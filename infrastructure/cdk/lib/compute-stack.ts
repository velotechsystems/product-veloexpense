/**
 * ComputeStack – VeloExpense's web service on the SHARED cluster and ALB, the
 * BullMQ worker, the one-off database task, and the scheduled jobs.
 *
 * Ported from ExpenseOS `compute-stack.ts`. Kept: Fargate on ARM64; one task
 * role and one execution role per kind of task; secrets imported BY NAME/ARN so
 * nothing writes a resource policy back onto another stack's secret; execution
 * roles granted exactly the secrets they pull; the deployment circuit breaker
 * with rollback; minHealthy 100 / maxHealthy 200 so a deploy never drops below
 * one serving task; ECS Exec on; a target-group health check.
 *
 * Changed, and why:
 *   · NO cluster, ALB or listener of our own. The cluster and the HTTPS
 *     listener are product-velocrm's (shared.ts). We add a HOST rule in
 *     VeloExpense's priority band, our certificate to that listener by SNI, and a
 *     target group. The ALB reaches the task because the task joins the shared
 *     apps security group; we never touch the ALB's own group (the listener is
 *     imported WITHOUT it, so CDK cannot add rules to it on our behalf).
 *   · The worker service (w3-00, d41) runs the SAME image as web, with
 *     `node worker/dist/main.mjs` (ExpenseOS builds it a repository of its own).
 *     It runs only the jobs ported with it; VeloExpense's own background work stays
 *     on `/api/internal/*`, which a scheduled Fargate task (`scripts/tick.mjs`)
 *     calls with WORKER_SECRET.
 *   · The DATABASE TASK. ExpenseOS ran migrations from an in-VPC CodeBuild runner.
 *     Here the same image runs `scripts/db-bootstrap.mjs` then
 *     `scripts/migrate.mjs` as a one-off task — it is the ONLY task definition
 *     that receives the master login. The web task receives `veloapp` and
 *     nothing else, so the running app is subject to FORCE ROW LEVEL SECURITY
 *     like every test in the suite assumes.
 *   · DATABASE_URL is composed at container start (docker-entrypoint.sh) from
 *     DB_HOST/DB_PORT/DB_NAME plus DB_USER/DB_PASSWORD pulled from Secrets
 *     Manager, instead of ExpenseOS's hand-made `database-url` secret — one fewer
 *     secret for a person to keep in step with a generated password.
 */
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_iam as iam,
  aws_logs as logs,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { REDIS_URL_SECRET } from './cache-stack';
import { INBOUND_OBJECT_PREFIX, inboundMailBucketName, inboundMailTopicName } from './mail-stack';
import { ANTHROPIC_API_KEY_SECRET, PLATFORM_INBOUND_TOKEN_SECRET } from './security-stack';
import { hostsOf, type VeloExpenseConfig } from './config';
import { SHARED_APP_PORT, importShared } from './shared';

export interface ComputeStackProps extends StackProps {
  config: VeloExpenseConfig;
  /** Image tag in `<prefix>/web` to run. Immutable tags: one tag, one build. */
  imageTag: string;
  serviceSecurityGroupId: string;
  masterKeyArn: string;
  /** Aurora writer endpoint. */
  dbHost: string;
  authSecretArn: string;
  workerSecretArn: string;
  appDbSecretArn: string;
  /** The RDS-generated master secret (JSON: username, password, …). */
  masterDbSecretArn: string;
}

/** Where the image puts the RDS CA bundle (Dockerfile); node trusts it via NODE_EXTRA_CA_CERTS. */
export const RDS_CA_PATH = '/app/rds-ca.pem';

export class ComputeStack extends Stack {
  public readonly service: ecs.FargateService;
  public readonly workerService: ecs.FargateService;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = config.resourcePrefix;
    const shared = importShared(this, config.sharedStage);
    const origin = `https://${config.domainName}`;

    const serviceSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'ServiceSg', props.serviceSecurityGroupId);
    const appsSg = ec2.SecurityGroup.fromSecurityGroupId(this, 'SharedAppsSg', shared.appsSecurityGroupId, {
      mutable: false,
    });
    const repo = ecr.Repository.fromRepositoryName(this, 'WebRepo', `${prefix}/web`);
    const image = ecs.ContainerImage.fromEcrRepository(repo, props.imageTag);

    // ── Secrets, imported locally ─────────────────────────────────────────────
    const byArn = (cid: string, arn: string) => secretsmanager.Secret.fromSecretCompleteArn(this, cid, arn);
    const byName = (cid: string, name: string) => secretsmanager.Secret.fromSecretNameV2(this, cid, name);

    const authSecret = byArn('AuthSecret', props.authSecretArn);
    const workerSecret = byArn('WorkerSecret', props.workerSecretArn);
    const appDb = byArn('AppDb', props.appDbSecretArn);
    const masterDb = byArn('MasterDb', props.masterDbSecretArn);
    const encryptionKey = byName('SecretEncryptionKey', `${config.secretPrefix}/secret-encryption-key`);
    const googleOAuth = byName('GoogleOAuth', `${config.secretPrefix}/google-oauth`);
    const smtp = byName('Smtp', config.smtpSecretName);
    // Composed by CacheStack (rediss:// with the AUTH token); read by name, as ExpenseOS does.
    const redisUrl = byName('RedisUrl', `${config.secretPrefix}/${REDIS_URL_SECRET}`);
    // Made by a person (MANUAL_SECRETS): the VeloExpense Anthropic key. The worker reads it for
    // receipt reading (d40); the web task reads it for the assistant, whose chat route calls
    // Claude in the request (w6-03, d90 — reverses d40's worker-only rule; AI is native, d89).
    const anthropicKey = byName('AnthropicApiKey', `${config.secretPrefix}/${ANTHROPIC_API_KEY_SECRET}`);

    /** Partial-ARN wildcard for a secret imported by NAME (its ARN ends in a random suffix). */
    const nameArn = (name: string) =>
      `arn:aws:secretsmanager:${config.region}:${config.accountId}:secret:${name}-??????`;

    // ── Roles ─────────────────────────────────────────────────────────────────
    const executionRole = (rid: string, name: string, secretArns: string[]) => {
      const role = new iam.Role(this, rid, {
        roleName: `${prefix}-${name}-exec`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        ],
      });
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: secretArns,
        }),
      );
      // Secrets and ECR layers are encrypted with our master key.
      role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [props.masterKeyArn] }));
      return role;
    };

    const webExecRole = executionRole('WebExecutionRole', 'web', [
      props.authSecretArn,
      props.workerSecretArn,
      props.appDbSecretArn,
      nameArn(`${config.secretPrefix}/secret-encryption-key`),
      nameArn(`${config.secretPrefix}/google-oauth`),
      nameArn(config.smtpSecretName),
      // The web app enqueues (receipt extraction, w3-02).
      nameArn(`${config.secretPrefix}/${REDIS_URL_SECRET}`),
      // The assistant (w6-03, d90): the chat route calls Claude from the web task.
      nameArn(`${config.secretPrefix}/${ANTHROPIC_API_KEY_SECRET}`),
      // Platform provisioning, where it is on (config.ts `platformProvisioning`).
      ...(config.platformProvisioning ? [nameArn(`${config.secretPrefix}/${PLATFORM_INBOUND_TOKEN_SECRET}`)] : []),
    ]);
    // The worker: the queue's URL; and, with receipt reading (w3-02a), veloapp's login —
    // the same RLS-bound role the web app uses — and the Anthropic key. And the mail relay:
    // receipts by email (w3-06) answers the sender from the worker, as ExpenseOS's worker
    // does (its `sharedSecrets` give both tasks SMTP). Nothing else.
    const workerExecRole = executionRole('WorkerExecutionRole', 'worker', [
      nameArn(`${config.secretPrefix}/${REDIS_URL_SECRET}`),
      props.appDbSecretArn,
      nameArn(`${config.secretPrefix}/${ANTHROPIC_API_KEY_SECRET}`),
      nameArn(config.smtpSecretName),
    ]);
    // The database task: the master login and veloapp's (to set its password). Nothing else.
    const dbExecRole = executionRole('DbExecutionRole', 'db', [props.masterDbSecretArn, props.appDbSecretArn]);
    // The scheduled caller: WORKER_SECRET only.
    const tickExecRole = executionRole('TickExecutionRole', 'tick', [props.workerSecretArn]);

    const webTaskRole = new iam.Role(this, 'WebTaskRole', {
      roleName: `${prefix}-web-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    // Receipts: by ARN string, not the bucket construct, so no bucket policy is
    // written back onto the storage stack.
    const receiptsArn = `arn:aws:s3:::${prefix}-receipts-${config.accountId}`;
    webTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        resources: [receiptsArn, `${receiptsArn}/*`],
      }),
    );
    webTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:GenerateDataKey', 'kms:Encrypt', 'kms:Decrypt'],
        resources: [props.masterKeyArn],
      }),
    );
    const plainTaskRole = (rid: string, name: string) =>
      new iam.Role(this, rid, {
        roleName: `${prefix}-${name}-task`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      });
    const dbTaskRole = plainTaskRole('DbTaskRole', 'db');
    const tickTaskRole = plainTaskRole('TickTaskRole', 'tick');
    // Receipt reading (w3-02a): READ a receipt and its GuardDuty scan tag (d42), and decrypt
    // it (the bucket is SSE-KMS under the master key). No write, no delete, no list: the
    // worker never changes or enumerates a stored file. ExpenseOS grants its worker the
    // same reads (GetObject, GetObjectTagging).
    const workerTaskRole = plainTaskRole('WorkerTaskRole', 'worker');
    workerTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectTagging'],
        resources: [`${receiptsArn}/*`],
      }),
    );
    workerTaskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [props.masterKeyArn] }),
    );
    // Receipts by email (w3-06): the worker WRITES each attachment as a receipt — the first
    // object it creates — so it may put (and encrypt under the master key), under the receipts
    // prefix only. Still no delete and no list. GuardDuty scans what it writes like any other
    // upload, and extraction waits for that verdict (d42).
    // And it READS the raw message SES stored. Read-only, worker only — the web app never
    // touches that bucket. ExpenseOS's grant, after its first dev receipt logged "could not
    // read inbound/…: 403" (the bucket name was handed over as env, with no grant).
    if (config.inboundEmail) {
      workerTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [`${receiptsArn}/org/*`] }),
      );
      workerTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({ actions: ['kms:GenerateDataKey'], resources: [props.masterKeyArn] }),
      );
      const inboundArn = `arn:aws:s3:::${inboundMailBucketName(config)}`;
      workerTaskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject', 's3:GetObjectTagging', 's3:ListBucket'],
          resources: [inboundArn, `${inboundArn}/${INBOUND_OBJECT_PREFIX}*`],
        }),
      );
    }

    // ── Logs ──────────────────────────────────────────────────────────────────
    const logGroup = (lid: string, name: string) =>
      new logs.LogGroup(this, lid, {
        logGroupName: `/ecs/${prefix}/${name}`,
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    // ── Environment shared by every task ──────────────────────────────────────
    const dbEnv = {
      DB_HOST: props.dbHost,
      DB_PORT: '5432',
      DB_NAME: config.rds.databaseName,
      NODE_EXTRA_CA_CERTS: RDS_CA_PATH,
    };
    const runtime = { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX };

    // ── 1. Web ────────────────────────────────────────────────────────────────
    const webTaskDef = new ecs.FargateTaskDefinition(this, 'WebTaskDef', {
      family: `${prefix}-web`,
      cpu: config.web.cpu,
      memoryLimitMiB: config.web.memoryMiB,
      taskRole: webTaskRole,
      executionRole: webExecRole,
      runtimePlatform: runtime,
    });
    webTaskDef.addContainer('web', {
      image,
      portMappings: [{ containerPort: SHARED_APP_PORT, protocol: ecs.Protocol.TCP }],
      environment: {
        NODE_ENV: 'production',
        HOSTNAME: '0.0.0.0',
        PORT: String(SHARED_APP_PORT),
        APP_URL: origin,
        AUTH_URL: origin,
        // The app sits behind Cloudflare and the ALB; the host it sees is the
        // forwarded one. AUTH_URL above pins what Auth.js builds links on.
        AUTH_TRUST_HOST: 'true',
        ...(config.authCookieDomain ? { AUTH_COOKIE_DOMAIN: config.authCookieDomain } : {}),
        // Self-serve /signup — closed unless this says otherwise (lib/onboarding/signupGate.ts).
        ...(config.selfServeSignup ? { SIGNUP_ENABLED: 'true' } : {}),
        STORAGE_DRIVER: 's3',
        STORAGE_BUCKET: `${prefix}-receipts-${config.accountId}`,
        STORAGE_REGION: config.region,
        PG_POOL_MAX: String(config.web.pgPoolMax),
        // Receipts by email (w3-06, d47): the route reads the tenant from the address's label
        // under this domain, and acts only on messages from this topic — named, not
        // referenced, so this stack does not depend on the Mail stack.
        ...(config.inboundEmail
          ? {
              INBOUND_EMAIL_DOMAIN: config.inboundEmail.domain,
              INBOUND_RECEIPTS_MAILBOXES: config.inboundEmail.receiptsMailboxes.join(','),
              INBOUND_SNS_TOPIC_ARN: `arn:aws:sns:${config.region}:${config.accountId}:${inboundMailTopicName(config)}`,
            }
          : {}),
        ...dbEnv,
      },
      secrets: {
        AUTH_SECRET: ecs.Secret.fromSecretsManager(authSecret),
        WORKER_SECRET: ecs.Secret.fromSecretsManager(workerSecret),
        DB_USER: ecs.Secret.fromSecretsManager(appDb, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appDb, 'password'),
        SECRET_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(encryptionKey),
        AUTH_GOOGLE_ID: ecs.Secret.fromSecretsManager(googleOAuth, 'clientId'),
        AUTH_GOOGLE_SECRET: ecs.Secret.fromSecretsManager(googleOAuth, 'clientSecret'),
        // The suite's Google Workspace relay, the same secret VeloCRM reads. Its
        // keys are VeloCRM's names; mapped to VeloExpense's here. Port 465 turns
        // on implicit TLS by itself (lib/notifications/email.ts).
        SMTP_HOST: ecs.Secret.fromSecretsManager(smtp, 'SMTP_HOST'),
        SMTP_PORT: ecs.Secret.fromSecretsManager(smtp, 'SMTP_PORT'),
        SMTP_USER: ecs.Secret.fromSecretsManager(smtp, 'SMTP_USER'),
        SMTP_PASS: ecs.Secret.fromSecretsManager(smtp, 'SMTP_PASSWORD'),
        EMAIL_FROM: ecs.Secret.fromSecretsManager(smtp, 'SMTP_FROM_ADDRESS'),
        REDIS_URL: ecs.Secret.fromSecretsManager(redisUrl),
        // The assistant (w6-03, d90). Without it the chat route answers 503 "not configured".
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicKey),
        // The token the platform presents to create a tenant here — the INBOUND one, never
        // the outbound PLATFORM_SERVICE_TOKEN (app/api/platform/provision/route.ts).
        ...(config.platformProvisioning
          ? {
              PLATFORM_INBOUND_TOKEN: ecs.Secret.fromSecretsManager(
                byName('PlatformInboundToken', `${config.secretPrefix}/${PLATFORM_INBOUND_TOKEN_SECRET}`),
              ),
            }
          : {}),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup('WebLogs', 'web'), streamPrefix: 'web' }),
      healthCheck: {
        command: ['CMD-SHELL', `node -e "fetch('http://127.0.0.1:${SHARED_APP_PORT}/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });

    this.service = new ecs.FargateService(this, 'WebService', {
      serviceName: `${prefix}-web`,
      cluster: shared.cluster,
      taskDefinition: webTaskDef,
      desiredCount: config.web.desiredCount,
      // OUR group (database access) + the SHARED apps group (the ALB's way in).
      securityGroups: [serviceSg, appsSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: true,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    Tags.of(this.service).add('Product', 'veloexpense');

    // ── 2. The shared listener: our host, our certificate, our target group ───
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, 'SharedHttpsListener', {
      listenerArn: shared.httpsListenerArn,
      // IMMUTABLE: CDK would otherwise add egress rules to the ALB's group for our
      // targets. That group is product-velocrm's; our tasks are reachable because
      // they join the shared apps group, whose rules that repo owns.
      securityGroup: ec2.SecurityGroup.fromSecurityGroupId(this, 'SharedAlbSg', shared.albSecurityGroupId, {
        mutable: false,
      }),
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebTargetGroup', {
      targetGroupName: `${prefix}-web`,
      vpc: shared.vpc,
      port: SHARED_APP_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/api/health',
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: Duration.seconds(15),
    });
    targetGroup.addTarget(this.service);

    new elbv2.ApplicationListenerRule(this, 'HostRule', {
      listener,
      priority: config.listenerPriority,
      // w5-08: plus the tenant subdomains where they are on (config.ts `extraHosts`).
      conditions: [elbv2.ListenerCondition.hostHeaders(hostsOf(config))],
      action: elbv2.ListenerAction.forward([targetGroup]),
    });
    // ECS refuses a service whose target group is not yet attached to a load
    // balancer. CDK orders the service after this rule by itself (the target
    // group records the rule as its attachment); test/stacks.test.ts holds it to that.

    // SNI: the shared listener presents our certificate for our host. Cloudflare
    // in Full (strict) refuses an origin whose certificate does not name it.
    new elbv2.ApplicationListenerCertificate(this, 'HostCertificate', {
      listener,
      certificates: [elbv2.ListenerCertificate.fromArn(config.albCertificateArn)],
    });

    // ── 2b. The worker (BullMQ consumer) ──────────────────────────────────────
    // Ported from ExpenseOS's worker task definition and service. Kept: Fargate ARM64,
    // ECS Exec, the circuit breaker with rollback, minHealthy 100 / maxHealthy 200, and NO
    // health check — the worker has no listener; ECS treats the task as healthy while the
    // process runs and the circuit breaker catches a crash loop. Changed: the web image
    // with a command (one image here); our service group only (no inbound, so not the
    // shared apps group); no autoscaling (one task in dev); no 40 GiB ephemeral storage
    // (ExpenseOS's is for PDF rasterising, which VeloExpense's extraction does not do).
    const workerTaskDef = new ecs.FargateTaskDefinition(this, 'WorkerTaskDef', {
      family: `${prefix}-worker`,
      cpu: config.worker.cpu,
      memoryLimitMiB: config.worker.memoryMiB,
      taskRole: workerTaskRole,
      executionRole: workerExecRole,
      runtimePlatform: runtime,
    });
    workerTaskDef.addContainer('worker', {
      image,
      command: ['node', 'worker/dist/main.mjs'],
      environment: {
        NODE_ENV: 'production',
        // Receipt reading (w3-02a). The scan gate is on (d42): no receipt is read before
        // GuardDuty has tagged it clean. The model is the extraction package's default
        // unless RECEIPT_EXTRACTION_MODEL is set here.
        S3_MALWARE_SCAN: 'guardduty',
        STORAGE_DRIVER: 's3',
        STORAGE_BUCKET: `${prefix}-receipts-${config.accountId}`,
        STORAGE_REGION: config.region,
        // One job at a time per queue is the most this task's pool is asked for.
        PG_POOL_MAX: '5',
        // Receipts by email (w3-06): the bucket SES stores raw messages in.
        // w5-01b: and the tenant mail domain and the receipts mailbox, so an acknowledgement
        // can carry the `receipts+<token>@<tenant>.<domain>` address a reply adds receipts to.
        ...(config.inboundEmail
          ? {
              S3_INBOUND_MAIL_BUCKET: inboundMailBucketName(config),
              INBOUND_EMAIL_DOMAIN: config.inboundEmail.domain,
              INBOUND_RECEIPTS_MAILBOXES: config.inboundEmail.receiptsMailboxes.join(','),
            }
          : {}),
        ...dbEnv,
      },
      secrets: {
        REDIS_URL: ecs.Secret.fromSecretsManager(redisUrl),
        DB_USER: ecs.Secret.fromSecretsManager(appDb, 'username'),
        DB_PASSWORD: ecs.Secret.fromSecretsManager(appDb, 'password'),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(anthropicKey),
        // The acknowledgement and cap emails of receipts by email (w3-06). Without these
        // the worker falls back to the console transport: the reply is logged, not sent.
        // The same relay and the same mapping as the web task's.
        SMTP_HOST: ecs.Secret.fromSecretsManager(smtp, 'SMTP_HOST'),
        SMTP_PORT: ecs.Secret.fromSecretsManager(smtp, 'SMTP_PORT'),
        SMTP_USER: ecs.Secret.fromSecretsManager(smtp, 'SMTP_USER'),
        SMTP_PASS: ecs.Secret.fromSecretsManager(smtp, 'SMTP_PASSWORD'),
        EMAIL_FROM: ecs.Secret.fromSecretsManager(smtp, 'SMTP_FROM_ADDRESS'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup('WorkerLogs', 'worker'), streamPrefix: 'worker' }),
    });

    this.workerService = new ecs.FargateService(this, 'WorkerService', {
      serviceName: `${prefix}-worker`,
      cluster: shared.cluster,
      taskDefinition: workerTaskDef,
      desiredCount: config.worker.desiredCount,
      securityGroups: [serviceSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      enableExecuteCommand: true,
      circuitBreaker: { enable: true, rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });
    Tags.of(this.workerService).add('Product', 'veloexpense');

    // ── 3. The database task (bootstrap + migrations), run on demand ──────────
    const dbTaskDef = new ecs.FargateTaskDefinition(this, 'DbTaskDef', {
      family: `${prefix}-db`,
      cpu: 256,
      memoryLimitMiB: 512,
      taskRole: dbTaskRole,
      executionRole: dbExecRole,
      runtimePlatform: runtime,
    });
    dbTaskDef.addContainer('db', {
      image,
      command: ['sh', '-c', 'node scripts/db-bootstrap.mjs && node scripts/migrate.mjs'],
      environment: { NODE_ENV: 'production', ...dbEnv },
      secrets: {
        DB_ADMIN_USER: ecs.Secret.fromSecretsManager(masterDb, 'username'),
        DB_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(masterDb, 'password'),
        DB_APP_USER: ecs.Secret.fromSecretsManager(appDb, 'username'),
        DB_APP_PASSWORD: ecs.Secret.fromSecretsManager(appDb, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: logGroup('DbLogs', 'db'), streamPrefix: 'db' }),
    });

    // ── 4. Scheduled jobs: POST /api/internal/* with WORKER_SECRET ────────────
    // One task definition PER JOB, with its path in the command, rather than one
    // definition and a per-schedule override: what a schedule runs is then
    // readable in the task definition itself, and nothing depends on how the
    // scheduler passes overrides to RunTask.
    const tickLogs = logGroup('TickLogs', 'tick');
    const tickFamilies: string[] = [];
    const tickTaskDefs = config.schedules.map((job) => {
      const family = `${prefix}-tick-${job.name}`;
      tickFamilies.push(family);
      const def = new ecs.FargateTaskDefinition(this, `TickTaskDef-${job.name}`, {
        family,
        cpu: 256,
        memoryLimitMiB: 512,
        taskRole: tickTaskRole,
        executionRole: tickExecRole,
        runtimePlatform: runtime,
      });
      def.addContainer('tick', {
        image,
        command: ['node', 'scripts/tick.mjs', job.path],
        environment: { NODE_ENV: 'production', APP_URL: origin },
        secrets: { WORKER_SECRET: ecs.Secret.fromSecretsManager(workerSecret) },
        logging: ecs.LogDrivers.awsLogs({ logGroup: tickLogs, streamPrefix: job.name }),
      });
      return { job, def };
    });

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `${prefix}-scheduler`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });
    schedulerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        // Any revision of the tick families, and nothing else.
        resources: tickFamilies.map(
          (f) => `arn:aws:ecs:${config.region}:${config.accountId}:task-definition/${f}:*`,
        ),
      }),
    );
    schedulerRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [tickExecRole.roleArn, tickTaskRole.roleArn],
      }),
    );

    const privateSubnetIds = shared.vpc.privateSubnets.map((s) => s.subnetId);
    for (const { job, def } of tickTaskDefs) {
      new scheduler.CfnSchedule(this, `Schedule-${job.name}`, {
        name: `${prefix}-${job.name}`,
        description: `POST ${job.path}`,
        scheduleExpression: `rate(${job.rate.minutes} minutes)`,
        flexibleTimeWindow: { mode: 'OFF' },
        target: {
          arn: shared.cluster.clusterArn,
          roleArn: schedulerRole.roleArn,
          ecsParameters: {
            taskDefinitionArn: def.taskDefinitionArn,
            launchType: 'FARGATE',
            taskCount: 1,
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: privateSubnetIds,
                securityGroups: [props.serviceSecurityGroupId],
                assignPublicIp: 'DISABLED',
              },
            },
          },
          retryPolicy: { maximumRetryAttempts: 0 },
        },
      });
    }

    // ── Outputs: what a person needs for DNS and for running the database task ─
    new CfnOutput(this, 'CloudflareCnameTarget', {
      value: shared.albDnsName,
      description: `Cloudflare: CNAME ${config.domainName} -> this (proxied)`,
    });
    new CfnOutput(this, 'ClusterName', { value: shared.cluster.clusterName });
    new CfnOutput(this, 'DbTaskFamily', { value: dbTaskDef.family });
    new CfnOutput(this, 'WorkerServiceName', { value: this.workerService.serviceName });
    new CfnOutput(this, 'TaskSubnets', { value: privateSubnetIds.join(',') });
    new CfnOutput(this, 'TaskSecurityGroup', { value: props.serviceSecurityGroupId });

    for (const [key, value] of Object.entries(config.tags)) Tags.of(this).add(key, value);
  }
}
