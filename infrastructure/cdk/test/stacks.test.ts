/**
 * What the synthesised templates must and must not contain.
 *
 * Every case here is a way this infrastructure could be wrong while still
 * synthesising and deploying cleanly — the class of failure that only shows up
 * as somebody else's outage or a credential in the wrong container.
 */
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { CacheStack } from '../lib/cache-stack';
import { buildConfig, type ExternalKeys, type Stage } from '../lib/config';
import { ComputeStack } from '../lib/compute-stack';
import { DataStack } from '../lib/data-stack';
import { MailStack } from '../lib/mail-stack';
import { NetworkStack } from '../lib/network-stack';
import { MANUAL_SECRETS, SecurityStack } from '../lib/security-stack';
import { StorageStack } from '../lib/storage-stack';

const CERT = 'arn:aws:acm:ca-central-1:535079144866:certificate/11111111-2222-3333-4444-555555555555';

function synth(stage: Stage = 'dev', externalKeys?: Partial<ExternalKeys>) {
  const app = new App();
  const config = buildConfig(stage, { albCertificateArn: CERT, externalKeys });
  const env = { account: config.accountId, region: config.region };
  const security = new SecurityStack(app, 'Sec', { env, config });
  const network = new NetworkStack(app, 'Net', { env, config });
  const storage = new StorageStack(app, 'Sto', { env, config, masterKeyArn: security.masterKey.keyArn });
  const data = new DataStack(app, 'Dat', {
    env,
    config,
    databaseSecurityGroupId: network.databaseSecurityGroup.securityGroupId,
    masterKeyArn: security.masterKey.keyArn,
  });
  const cache = new CacheStack(app, 'Cch', {
    env,
    config,
    cacheSecurityGroupId: network.cacheSecurityGroup.securityGroupId,
    masterKeyArn: security.masterKey.keyArn,
  });
  const compute = new ComputeStack(app, 'Cmp', {
    env,
    config,
    imageTag: 'abc123',
    serviceSecurityGroupId: network.serviceSecurityGroup.securityGroupId,
    masterKeyArn: security.masterKey.keyArn,
    dbHost: data.cluster.clusterEndpoint.hostname,
    authSecretArn: security.authSecret.secretArn,
    workerSecretArn: security.workerSecret.secretArn,
    appDbSecretArn: security.appDbSecret.secretArn,
    masterDbSecretArn: data.cluster.secret!.secretArn,
  });
  // w5-08: prod has no receipts by email, so no Mail stack (bin/app.ts creates it only then).
  const mail = config.inboundEmail ? new MailStack(app, 'Mal', { env, config }) : undefined;
  const t = (
    s: SecurityStack | NetworkStack | StorageStack | DataStack | CacheStack | ComputeStack | MailStack,
  ) => Template.fromStack(s);
  return {
    config,
    security: t(security),
    network: t(network),
    storage: t(storage),
    data: t(data),
    cache: t(cache),
    compute: t(compute),
    // Dev always has one; every dev case below reads it.
    mail: mail ? t(mail) : (undefined as unknown as Template),
    all: [security, network, storage, data, cache, compute, ...(mail ? [mail] : [])].map(t),
  };
}

const s = synth();

/** The CloudFormation parameter a stack uses for a shared SSM key, e.g. 'alb-sg-id'. */
function sharedParam(tpl: Template, key: string): string | undefined {
  const params = tpl.toJSON().Parameters ?? {};
  return Object.entries(params).find(
    ([, v]) => (v as { Default?: string }).Default === `/velotech/dev/shared/${key}`,
  )?.[0];
}

function resources(tpl: Template, type: string): Array<[string, { Properties: Record<string, unknown> }]> {
  return Object.entries(tpl.toJSON().Resources ?? {}).filter(
    ([, r]) => (r as { Type: string }).Type === type,
  ) as Array<[string, { Properties: Record<string, unknown> }]>;
}

const json = (v: unknown) => JSON.stringify(v);

describe('the shared infrastructure is read, never changed', () => {
  it('no stack adds a rule to the shared ALB security group', () => {
    for (const tpl of s.all) {
      const albSg = sharedParam(tpl, 'alb-sg-id');
      if (!albSg) continue;
      for (const type of ['AWS::EC2::SecurityGroupIngress', 'AWS::EC2::SecurityGroupEgress']) {
        for (const [id, r] of resources(tpl, type)) {
          expect(json(r.Properties.GroupId), `${id} writes a rule onto the shared ALB group`).not.toContain(albSg);
        }
      }
    }
  });

  it('no stack imports a product-velocrm CloudFormation export (SSM only)', () => {
    for (const tpl of s.all) {
      expect(json(tpl.toJSON())).not.toMatch(/"Fn::ImportValue":"Velotech-|"Fn::ImportValue":"VeloCrm-/);
    }
  });

  it('the web service joins the shared apps group, and our own', () => {
    const [[, svc]] = resources(s.compute, 'AWS::ECS::Service');
    const groups = json((svc.Properties.NetworkConfiguration as { AwsvpcConfiguration: unknown }).AwsvpcConfiguration);
    expect(groups).toContain(sharedParam(s.compute, 'apps-sg-id'));
    expect(groups).toContain('ServiceSg');
  });
});

describe('the shared listener', () => {
  it('routes OUR host only, at a priority inside VeloExpense’s band', () => {
    const [[, rule]] = resources(s.compute, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    const p = rule.Properties as { Priority: number; Conditions: unknown; ListenerArn: unknown };
    expect(p.Priority).toBeGreaterThanOrEqual(100);
    expect(p.Priority).toBeLessThanOrEqual(199);
    expect(json(p.Conditions)).toBe(json([{ Field: 'host-header', HostHeaderConfig: { Values: ['dev.veloexpense.ai'] } }]));
    expect(json(p.ListenerArn)).toContain(sharedParam(s.compute, 'https-listener-arn'));
  });

  it('the service is created after its rule, or ECS refuses an unattached target group', () => {
    const [[, svc]] = resources(s.compute, 'AWS::ECS::Service');
    const [[ruleId]] = resources(s.compute, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    expect((svc as unknown as { DependsOn?: string[] }).DependsOn).toContain(ruleId);
  });

  it('adds our certificate to that listener by SNI', () => {
    s.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::ListenerCertificate', {
      Certificates: [{ CertificateArn: CERT }],
    });
  });

  it('the target group checks the route the proxy lets through unauthenticated', () => {
    s.compute.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/api/health',
      Port: 3000,
      TargetType: 'ip',
    });
  });
});

describe('credentials go only where they are needed', () => {
  const taskDefs = () =>
    resources(s.compute, 'AWS::ECS::TaskDefinition').map(([, r]) => {
      const p = r.Properties as { Family: string; ContainerDefinitions: Array<{ Secrets?: Array<{ Name: string; ValueFrom: unknown }> }> };
      return { family: p.Family, secrets: p.ContainerDefinitions.flatMap((c) => c.Secrets ?? []) };
    });

  it('the web task never receives the master login', () => {
    const web = taskDefs().find((t) => t.family === 'veloexpense-dev-web')!;
    expect(web.secrets.map((x) => x.Name)).not.toContain('DB_ADMIN_PASSWORD');
    expect(json(web.secrets)).not.toContain('rds-master');
    expect(json(web.secrets)).not.toMatch(/DbClusterSecret|MasterDb/);
    expect(web.secrets.map((x) => x.Name)).toEqual(
      expect.arrayContaining(['DB_USER', 'DB_PASSWORD', 'AUTH_SECRET', 'WORKER_SECRET', 'SECRET_ENCRYPTION_KEY']),
    );
  });

  it('only the database task does', () => {
    const holders = taskDefs().filter((t) => t.secrets.some((x) => x.Name === 'DB_ADMIN_PASSWORD'));
    expect(holders.map((t) => t.family)).toEqual(['veloexpense-dev-db']);
  });

  it('a scheduled job receives WORKER_SECRET and nothing else', () => {
    const ticks = taskDefs().filter((t) => t.family.startsWith('veloexpense-dev-tick-'));
    expect(ticks.length).toBe(s.config.schedules.length);
    for (const t of ticks) expect(t.secrets.map((x) => x.Name)).toEqual(['WORKER_SECRET']);
  });

  it('the web execution role cannot read the master secret', () => {
    const policies = resources(s.compute, 'AWS::IAM::Policy').filter(([id]) => id.startsWith('WebExecutionRole'));
    expect(policies.length).toBeGreaterThan(0);
    for (const [, p] of policies) expect(json(p.Properties)).not.toMatch(/MasterDb|DbClusterSecret|rds-master/);
  });
});

describe('the database', () => {
  it('accepts 5432 from the VeloExpense service group only', () => {
    const rules = resources(s.network, 'AWS::EC2::SecurityGroupIngress').filter(
      ([, r]) => json(r.Properties.GroupId).includes('DatabaseSg'),
    );
    expect(rules).toHaveLength(1);
    const [[, r]] = rules;
    expect(r.Properties.FromPort).toBe(5432);
    expect(json(r.Properties.SourceSecurityGroupId)).toContain('ServiceSg');
  });

  it('lives in the isolated subnets', () => {
    const [[, g]] = resources(s.data, 'AWS::RDS::DBSubnetGroup');
    const ids = json(g.Properties.SubnetIds);
    expect(ids).toContain(sharedParam(s.data, 'isolated-subnet-1'));
    expect(ids).toContain(sharedParam(s.data, 'isolated-subnet-2'));
    expect(ids).not.toContain('private-subnet');
  });

  it('is encrypted, logs no bind parameters, and runs the major version CI tests', () => {
    s.data.hasResourceProperties('AWS::RDS::DBCluster', { StorageEncrypted: true, Engine: 'aurora-postgresql' });
    const [[, c]] = resources(s.data, 'AWS::RDS::DBCluster');
    expect(String(c.Properties.EngineVersion)).toMatch(/^16\./);
    s.data.hasResourceProperties('AWS::RDS::DBClusterParameterGroup', {
      Parameters: { log_parameter_max_length: '0', log_parameter_max_length_on_error: '0', 'pgaudit.log_parameter': '0' },
    });
  });

  it('generates alphanumeric passwords, which the entrypoint puts in a URL unescaped', () => {
    // ExcludePunctuation, NOT an ExcludeCharacters list of every punctuation mark:
    // the latter cannot satisfy Secrets Manager's each-type rule and fails the deploy.
    const masters = resources(s.data, 'AWS::SecretsManager::Secret');
    expect(masters).toHaveLength(1);
    const gen = masters[0][1].Properties.GenerateSecretString as { ExcludePunctuation?: boolean; ExcludeCharacters?: string };
    expect(gen.ExcludePunctuation).toBe(true);
    expect(gen.ExcludeCharacters ?? '').not.toMatch(/[!-/:-@[-`{-~]{20,}/);
    const app = resources(s.security, 'AWS::SecretsManager::Secret').find(([id]) => id.startsWith('AppDbSecret'))!;
    expect((app[1].Properties.GenerateSecretString as { ExcludePunctuation: boolean }).ExcludePunctuation).toBe(true);
  });
});

describe('the queue (w3-00)', () => {
  const secretsOf = (family: string) => {
    const [, r] = resources(s.compute, 'AWS::ECS::TaskDefinition').find(
      ([, t]) => (t.Properties as { Family: string }).Family === family,
    )!;
    const defs = (r.Properties as { ContainerDefinitions: Array<{ Secrets?: Array<{ Name: string }>; Command?: string[] }> })
      .ContainerDefinitions;
    return { secrets: defs.flatMap((c) => c.Secrets ?? []).map((x) => x.Name), command: defs[0].Command };
  };

  it('Valkey accepts 6379 from the VeloExpense service group only', () => {
    const rules = resources(s.network, 'AWS::EC2::SecurityGroupIngress').filter(
      ([, r]) => json(r.Properties.GroupId).includes('CacheSg'),
    );
    expect(rules).toHaveLength(1);
    expect(rules[0][1].Properties.FromPort).toBe(6379);
    expect(json(rules[0][1].Properties.SourceSecurityGroupId)).toContain('ServiceSg');
  });

  it('never evicts a key — BullMQ loses jobs silently if it does', () => {
    s.cache.hasResourceProperties('AWS::ElastiCache::ParameterGroup', {
      Properties: { 'maxmemory-policy': 'noeviction' },
    });
  });

  it('is encrypted at rest and in transit, behind an AUTH token, in the isolated subnets', () => {
    s.cache.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      Engine: 'valkey',
      AtRestEncryptionEnabled: true,
      TransitEncryptionEnabled: true,
    });
    const [[, rg]] = resources(s.cache, 'AWS::ElastiCache::ReplicationGroup');
    expect(json(rg.Properties.AuthToken)).toContain('resolve:secretsmanager');
    const [[, g]] = resources(s.cache, 'AWS::ElastiCache::SubnetGroup');
    expect(json(g.Properties.SubnetIds)).toContain(sharedParam(s.cache, 'isolated-subnet-1'));
    expect(json(g.Properties.SubnetIds)).not.toContain('private-subnet');
  });

  it('the URL secret speaks TLS and holds the token as a reference, not as text', () => {
    const url = resources(s.cache, 'AWS::SecretsManager::Secret').find(([id]) => id.startsWith('RedisUrl'))!;
    const value = json(url[1].Properties.SecretString);
    expect(value).toContain('rediss://:');
    expect(value).toContain('resolve:secretsmanager');
  });

  it('the worker runs the bundle with the queue, veloapp\'s login, the model key and the mail relay — nothing else', () => {
    const w = secretsOf('veloexpense-dev-worker');
    expect(w.command).toEqual(['node', 'worker/dist/main.mjs']);
    // w3-02a: the database as veloapp (RLS-bound, like the web task) and the Anthropic key.
    // w3-06: the relay, so a receipt emailed in is acknowledged rather than logged.
    expect([...w.secrets].sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'DB_PASSWORD',
      'DB_USER',
      'EMAIL_FROM',
      'REDIS_URL',
      'SMTP_HOST',
      'SMTP_PASS',
      'SMTP_PORT',
      'SMTP_USER',
    ]);
  });

  it('the worker and the web task read the same relay under the same names', () => {
    const relay = (family: string) =>
      [...secretsOf(family).secrets].filter((n) => n.startsWith('SMTP_') || n === 'EMAIL_FROM').sort();
    expect(relay('veloexpense-dev-worker')).toEqual(relay('veloexpense-dev-web'));
  });

  // w6-03 (d90, reverses d40's worker-only rule): the web task holds the key too, for the
  // assistant's chat route. Still nothing else — not the db task, not a scheduled job.
  it('only the web task and the worker receive the Anthropic key', () => {
    const holders = resources(s.compute, 'AWS::ECS::TaskDefinition')
      .filter(([, r]) =>
        json((r.Properties as { ContainerDefinitions: unknown }).ContainerDefinitions).includes('ANTHROPIC_API_KEY'),
      )
      .map(([, r]) => (r.Properties as { Family: string }).Family)
      .sort();
    expect(holders).toEqual(['veloexpense-dev-web', 'veloexpense-dev-worker']);
  });

  it('the web execution role can read the Anthropic key (the assistant, d90)', () => {
    const [, p] = resources(s.compute, 'AWS::IAM::Policy').find(([id]) => id.startsWith('WebExecutionRole'))!;
    expect(json(p.Properties)).toContain('veloexpense/dev/anthropic-api-key');
    expect(secretsOf('veloexpense-dev-web').secrets).toContain('ANTHROPIC_API_KEY');
  });

  // mcp-oauth (ported from VeloCRM): the MCP access-token signing key is the web task's alone,
  // read by its execution role, and named for the stage — never the worker, never the db task.
  it('only the web task receives the MCP OAuth signing key, and its execution role can read it', () => {
    const holders = resources(s.compute, 'AWS::ECS::TaskDefinition')
      .filter(([, r]) =>
        json((r.Properties as { ContainerDefinitions: unknown }).ContainerDefinitions).includes('MCP_OAUTH_SIGNING_KEY'),
      )
      .map(([, r]) => (r.Properties as { Family: string }).Family)
      .sort();
    expect(holders).toEqual(['veloexpense-dev-web']);
    expect(secretsOf('veloexpense-dev-web').secrets).toContain('MCP_OAUTH_SIGNING_KEY');
    const [, web] = resources(s.compute, 'AWS::IAM::Policy').find(([id]) => id.startsWith('WebExecutionRole'))!;
    expect(json(web.Properties)).toContain('veloexpense/dev/mcp-oauth-signing-key');
    const [, worker] = resources(s.compute, 'AWS::IAM::Policy').find(([id]) => id.startsWith('WorkerExecutionRole'))!;
    expect(json(worker.Properties)).not.toContain('mcp-oauth-signing-key');
    expect(JSON.stringify(synth('prod').compute.toJSON())).toContain('veloexpense/prod/mcp-oauth-signing-key');
  });

  // f63: the streaming e2e points the assistant at a fake Messages API on loopback
  // (server/lib/assistantClient.ts anthropicBaseUrl). No deployed task may name one, nor the
  // SDK's own base-URL override.
  it('no stage points the assistant anywhere but Anthropic', () => {
    for (const stage of ['dev', 'prod'] as const) {
      const text = JSON.stringify(synth(stage).compute.toJSON());
      expect(text).not.toContain('ASSISTANT_FAKE_ANTHROPIC_URL');
      expect(text).not.toContain('ANTHROPIC_BASE_URL');
    }
  });

  it('the web task can enqueue', () => {
    expect(secretsOf('veloexpense-dev-web').secrets).toContain('REDIS_URL');
  });

  it('the worker takes no inbound traffic: our group only, no load balancer', () => {
    const svc = resources(s.compute, 'AWS::ECS::Service').find(
      ([, r]) => r.Properties.ServiceName === 'veloexpense-dev-worker',
    )![1];
    const net = json((svc.Properties.NetworkConfiguration as { AwsvpcConfiguration: unknown }).AwsvpcConfiguration);
    expect(net).toContain('ServiceSg');
    expect(net).not.toContain(sharedParam(s.compute, 'apps-sg-id'));
    expect(svc.Properties.LoadBalancers).toBeUndefined();
  });

  it('the worker execution role reads the queue URL, veloapp\'s login, the model key and the relay only', () => {
    const [, p] = resources(s.compute, 'AWS::IAM::Policy').find(([id]) => id.startsWith('WorkerExecutionRole'))!;
    const text = json(p.Properties);
    expect(text).toContain('veloexpense/dev/redis-url');
    expect(text).toContain('veloexpense/dev/anthropic-api-key');
    expect(text).toContain('velocrm/smtp-credentials');
    expect(text).toMatch(/AppDb/);
    expect(text).not.toMatch(/AuthSecret|WorkerSecret|MasterDb|rds-master|secret-encryption-key|google-oauth/);
  });

  it('the worker may read a receipt and its scan tag, and delete or list nothing (w3-02a)', () => {
    const [, p] = resources(s.compute, 'AWS::IAM::Policy').find(([id]) => id.startsWith('WorkerTaskRole'))!;
    const text = json(p.Properties);
    expect(text).toContain('s3:GetObject');
    expect(text).toContain('s3:GetObjectTagging');
    expect(text).toContain('veloexpense-dev-receipts-535079144866/*');
    // w3-06 lets it WRITE an emailed attachment (below); never delete, never list receipts.
    expect(text).not.toMatch(/s3:DeleteObject|kms:Encrypt/);
    expect(text).not.toMatch(/"s3:ListBucket","Effect":"Allow","Resource":\["arn:aws:s3:::veloexpense-dev-receipts/);
  });

  it('the worker reads nothing before GuardDuty has scanned it (d42)', () => {
    const [[, td]] = resources(s.compute, 'AWS::ECS::TaskDefinition').filter(
      ([, r]) => (r.Properties as { Family: string }).Family === 'veloexpense-dev-worker',
    );
    expect(json(td.Properties)).toContain(json({ Name: 'S3_MALWARE_SCAN', Value: 'guardduty' }));
  });
});

describe('malware scanning (w3-02a, d42)', () => {
  it('GuardDuty scans the receipts bucket and tags each object with its verdict', () => {
    const [[, plan]] = resources(s.storage, 'AWS::GuardDuty::MalwareProtectionPlan');
    expect(json(plan.Properties.ProtectedResource)).toContain('ReceiptsBucket');
    expect(plan.Properties.Actions).toEqual({ Tagging: { Status: 'ENABLED' } });
  });

  it('the plan waits for its role\'s permissions, or ownership validation fails', () => {
    const [[, plan]] = resources(s.storage, 'AWS::GuardDuty::MalwareProtectionPlan');
    const deps = (plan as unknown as { DependsOn?: string[] }).DependsOn ?? [];
    expect(deps.some((d) => d.startsWith('ReceiptsMalwareScanRoleDefaultPolicy'))).toBe(true);
  });
});

describe('storage', () => {
  it('lets the browser upload from this host and no other', () => {
    const cors = resources(s.storage, 'AWS::S3::Bucket')
      .map(([, b]) => b.Properties.CorsConfiguration as { CorsRules: Array<{ AllowedOrigins: string[] }> } | undefined)
      .filter(Boolean);
    expect(cors).toHaveLength(1); // the receipts bucket; the log bucket has none
    expect(cors[0]!.CorsRules.map((r) => r.AllowedOrigins)).toEqual([['https://dev.veloexpense.ai']]);
  });
});

describe('config', () => {
  it('dev carries its committed, issued certificate; the environment can override it', () => {
    expect(buildConfig('dev').albCertificateArn).toBe(
      'arn:aws:acm:ca-central-1:535079144866:certificate/b9d463c0-8c2f-4754-bf39-cd4231b92a9c',
    );
    expect(buildConfig('dev', { albCertificateArn: CERT }).albCertificateArn).toBe(CERT);
  });
});

describe('receipts by email (w3-06)', () => {
  const statements = (tpl: Template, prefix: string) => {
    const [, p] = resources(tpl, 'AWS::IAM::Policy').find(([id]) => id.startsWith(prefix))!;
    return (p.Properties as { PolicyDocument: { Statement: Array<Record<string, unknown>> } }).PolicyDocument
      .Statement;
  };

  it('receives on every tenant subdomain of the inbound domain, scanned, over TLS, then stops', () => {
    const [[, rule]] = resources(s.mail, 'AWS::SES::ReceiptRule');
    const r = (rule.Properties as { Rule: Record<string, unknown> }).Rule;
    expect(r.Recipients).toEqual(['.mail.dev.veloexpense.ai']);
    expect(r.ScanEnabled).toBe(true);
    expect(r.TlsPolicy).toBe('Require');
    const actions = r.Actions as Array<Record<string, unknown>>;
    expect(Object.keys(actions[0] ?? {})).toEqual(['S3Action']);
    expect(json(actions[0])).toContain('"ObjectKeyPrefix":"inbound/"');
    expect(Object.keys(actions[1] ?? {})).toEqual(['StopAction']);
  });

  it('lets only SES, from this account, write the bucket — under the inbound prefix', () => {
    const [[, policy]] = resources(s.mail, 'AWS::S3::BucketPolicy');
    const text = json(policy.Properties);
    expect(text).toContain('ses.amazonaws.com');
    expect(text).toContain('"aws:SourceAccount"');
    expect(text).toMatch(/inbound\/\*/);
  });

  it('keeps a raw message two weeks, encrypted, private, over TLS only', () => {
    const [[, bucket]] = resources(s.mail, 'AWS::S3::Bucket').filter(([, b]) =>
      json(b.Properties).includes('inbound-mail'),
    );
    const text = json(bucket.Properties);
    expect(text).toContain('"ExpirationInDays":14');
    expect(text).toContain('AES256');
    expect(text).toContain('"BlockPublicAcls":true');
    const [[, policy]] = resources(s.mail, 'AWS::S3::BucketPolicy');
    expect(json(policy.Properties)).toMatch(/"aws:SecureTransport":"false"/);
  });

  it('tells the app over HTTPS, and only SES from this account may publish', () => {
    s.mail.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'https',
      Endpoint: 'https://dev.veloexpense.ai/api/email/inbound',
    });
    const [[, topicPolicy]] = resources(s.mail, 'AWS::SNS::TopicPolicy');
    const text = json(topicPolicy.Properties);
    expect(text).toContain('ses.amazonaws.com');
    expect(text).toContain('"aws:SourceAccount"');
  });

  it('activates its rule set, and on delete clears it rather than naming another (d49)', () => {
    // SES allows one active set per account and region, and the account is the suite's:
    // dev had none when this was decided, so nothing is displaced and nothing to restore.
    expect(s.config.inboundEmail?.activateRuleSet).toBe(true);
    expect(s.config.inboundEmail?.restoreRuleSetNameOnDelete).toBeUndefined();
    const [[, activate]] = resources(s.mail, 'Custom::AWS');
    const text = json(activate.Properties);
    expect(text).toContain('setActiveReceiptRuleSet');
    // It activates this stack's own set, by reference.
    const [[setId, set]] = resources(s.mail, 'AWS::SES::ReceiptRuleSet');
    expect((set.Properties as { RuleSetName: string }).RuleSetName).toBe('veloexpense-dev-inbound');
    expect(text).toContain(json({ Ref: setId }));
    // The delete call carries no rule set name, which deactivates every set.
    const onDelete = JSON.parse(String((activate.Properties as { Delete?: unknown }).Delete ?? '{}')) as {
      parameters?: Record<string, unknown>;
    };
    expect(onDelete.parameters ?? {}).toEqual({});
  });

  it('the web task gets the domain and the pinned topic, not the bucket', () => {
    const [[, td]] = resources(s.compute, 'AWS::ECS::TaskDefinition').filter(
      ([, r]) => (r.Properties as { Family: string }).Family === 'veloexpense-dev-web',
    );
    const text = json(td.Properties);
    expect(text).toContain(json({ Name: 'INBOUND_EMAIL_DOMAIN', Value: 'mail.dev.veloexpense.ai' }));
    expect(text).toContain(
      json({ Name: 'INBOUND_SNS_TOPIC_ARN', Value: 'arn:aws:sns:ca-central-1:535079144866:veloexpense-dev-inbound-mail' }),
    );
    expect(text).not.toContain('S3_INBOUND_MAIL_BUCKET');
    const web = json(statements(s.compute, 'WebTaskRole'));
    expect(web).not.toContain('inbound-mail');
  });

  it('the worker reads the inbound prefix and writes receipts under the tenant prefix only', () => {
    const [[, td]] = resources(s.compute, 'AWS::ECS::TaskDefinition').filter(
      ([, r]) => (r.Properties as { Family: string }).Family === 'veloexpense-dev-worker',
    );
    expect(json(td.Properties)).toContain(
      json({ Name: 'S3_INBOUND_MAIL_BUCKET', Value: 'veloexpense-dev-inbound-mail-535079144866' }),
    );
    // w5-01b: what the worker builds a `receipts+<token>@<tenant>.<domain>` address from.
    expect(json(td.Properties)).toContain(
      json({ Name: 'INBOUND_EMAIL_DOMAIN', Value: 'mail.dev.veloexpense.ai' }),
    );
    expect(json(td.Properties)).toContain(json({ Name: 'INBOUND_RECEIPTS_MAILBOXES', Value: 'receipts' }));
    const worker = statements(s.compute, 'WorkerTaskRole');
    const put = worker.find((st) => json(st).includes('s3:PutObject'))!;
    expect(put.Resource).toBe('arn:aws:s3:::veloexpense-dev-receipts-535079144866/org/*');
    const read = worker.find((st) => json(st).includes('inbound-mail'))!;
    expect(json(read)).not.toMatch(/PutObject|DeleteObject/);
    expect(read.Resource).toEqual([
      'arn:aws:s3:::veloexpense-dev-inbound-mail-535079144866',
      'arn:aws:s3:::veloexpense-dev-inbound-mail-535079144866/inbound/*',
    ]);
  });
});

// ── w5-08: production (d86) ────────────────────────────────────────────────────
describe('production (w5-08)', () => {
  const p = synth('prod');
  const rule = () => {
    const [[, r]] = resources(p.compute, 'AWS::ElasticLoadBalancingV2::ListenerRule');
    return r.Properties as { Conditions: Array<{ Field: string; HostHeaderConfig?: { Values: string[] } }> };
  };

  it('answers on app.veloexpense.ai and every tenant subdomain, with the apex as the cookie domain', () => {
    const hosts = rule().Conditions.find((c) => c.Field === 'host-header')!.HostHeaderConfig!.Values;
    expect(hosts).toEqual(['app.veloexpense.ai', '*.veloexpense.ai']);
    expect(JSON.stringify(p.compute.toJSON())).toContain('"AUTH_COOKIE_DOMAIN","Value":"veloexpense.ai"');
  });

  it('lets a browser upload a receipt from a tenant subdomain', () => {
    const cors = resources(p.storage, 'AWS::S3::Bucket')
      .map(([, b]) => b.Properties.CorsConfiguration as { CorsRules: Array<{ AllowedOrigins: string[] }> } | undefined)
      .filter(Boolean);
    expect(cors[0]!.CorsRules.map((r) => r.AllowedOrigins)).toEqual([
      ['https://app.veloexpense.ai', 'https://*.veloexpense.ai'],
    ]);
  });

  it('protects the database: deletion protection, 14 days of backups, up to 4 ACU', () => {
    p.data.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
      ServerlessV2ScalingConfiguration: { MinCapacity: 0.5, MaxCapacity: 4 },
    });
  });

  it('runs two web tasks, so a deploy or a restart is not an outage', () => {
    const services = resources(p.compute, 'AWS::ECS::Service').map(([, sv]) => sv.Properties);
    const web = services.find((sv) => String(sv.ServiceName).endsWith('-web'));
    expect(web?.DesiredCount).toBe(2);
  });

  it('names everything veloexpense-prod and reads velotech-prod\'s shared parameters', () => {
    const json = JSON.stringify(p.all.map((t) => t.toJSON()));
    expect(json).toContain('veloexpense-prod');
    expect(json).not.toContain('veloexpense-dev');
    expect(json).toContain('/velotech/prod/shared/');
    expect(json).not.toContain('/velotech/dev/shared/');
  });

  it('has no receipts by email yet (d86): no inbound settings on the app', () => {
    expect(p.config.inboundEmail).toBeUndefined();
    expect(JSON.stringify(p.compute.toJSON())).not.toContain('INBOUND_EMAIL_DOMAIN');
  });

  it('carries its committed certificate (app + *.veloexpense.ai); the environment can override it', () => {
    expect(buildConfig('prod').albCertificateArn).toBe(
      'arn:aws:acm:ca-central-1:535079144866:certificate/6cddefb8-7f13-4ffb-82af-d185f56a8488',
    );
    expect(buildConfig('prod', { albCertificateArn: CERT }).albCertificateArn).toBe(CERT);
  });

  it('leaves dev exactly as it was: one host, its own origin, no cookie domain', () => {
    const dev = buildConfig('dev');
    expect(dev.extraHosts).toBeUndefined();
    expect(dev.authCookieDomain).toBeUndefined();
  });
});

// ── 18 Oct 2026: how tenants are created, per stage ─────────────────────────────
describe('tenant creation per stage', () => {
  const webEnv = (tpl: Template) => {
    const [[, td]] = resources(tpl, 'AWS::ECS::TaskDefinition').filter(([, t]) =>
      String((t.Properties as { Family?: string }).Family).endsWith('-web'),
    );
    const [c] = (td.Properties as { ContainerDefinitions: Array<{ Environment: Array<{ Name: string; Value: string }>; Secrets: Array<{ Name: string; ValueFrom: unknown }> }> }).ContainerDefinitions;
    return { env: c.Environment.map((e) => e.Name), secrets: c.Secrets.map((x) => x.Name) };
  };

  it('dev: self-serve signup on, no platform token', () => {
    const { env, secrets } = webEnv(s.compute);
    expect(env).toContain('SIGNUP_ENABLED');
    expect(secrets).not.toContain('PLATFORM_INBOUND_TOKEN');
  });

  it('prod: signup closed, and the platform token reaches the web task', () => {
    const p = synth('prod');
    const { env, secrets } = webEnv(p.compute);
    expect(env).not.toContain('SIGNUP_ENABLED');
    expect(secrets).toContain('PLATFORM_INBOUND_TOKEN');
    expect(JSON.stringify(p.compute.toJSON())).toContain('veloexpense/prod/platform-inbound-token');
  });
});

// ── f78 / f62: Google Maps and SerpApi keys, off per stage until the keys exist ──
describe('third-party keys (f78, f62)', () => {
  const KEYS = [
    { flag: 'googlePlaces', env: 'GOOGLE_PLACES_API_KEY', secret: 'google-places-key' },
    { flag: 'googleMapsBrowser', env: 'GOOGLE_MAPS_BROWSER_KEY', secret: 'google-maps-browser-key' },
    { flag: 'serpapi', env: 'SERPAPI_API_KEY', secret: 'serpapi-key' },
  ] as const;
  const containerSecrets = (tpl: Template, suffix: string) => {
    const [[, td]] = resources(tpl, 'AWS::ECS::TaskDefinition').filter(([, t]) =>
      String((t.Properties as { Family?: string }).Family).endsWith(suffix),
    );
    const [c] = (td.Properties as { ContainerDefinitions: Array<{ Secrets?: Array<{ Name: string }> }> }).ContainerDefinitions;
    return (c.Secrets ?? []).map((x) => x.Name);
  };
  const execPolicyText = (tpl: Template, role: string) =>
    json(
      resources(tpl, 'AWS::IAM::Policy').filter(([, p]) =>
        json((p.Properties as { Roles?: unknown }).Roles).includes(role),
      ),
    );

  for (const stage of ['dev', 'prod'] as const) {
    it(`${stage}: every key is off by default — no variable, no grant, not a manual secret`, () => {
      const t = stage === 'dev' ? s : synth('prod');
      expect(t.config.externalKeys).toEqual({ googlePlaces: false, googleMapsBrowser: false, serpapi: false });
      const web = containerSecrets(t.compute, '-web');
      const text = json(t.compute.toJSON());
      for (const k of KEYS) {
        expect(web).not.toContain(k.env);
        expect(text).not.toContain(`veloexpense/${stage}/${k.secret}`);
      }
      for (const k of KEYS) expect(MANUAL_SECRETS as readonly string[]).not.toContain(k.secret);
    });
  }

  for (const k of KEYS) {
    it(`${k.flag} on: ${k.env} reaches the web task, and only the web exec role may read ${k.secret}`, () => {
      const on = synth('prod', { [k.flag]: true });
      expect(containerSecrets(on.compute, '-web')).toContain(k.env);
      expect(containerSecrets(on.compute, '-worker')).not.toContain(k.env);
      const others = KEYS.filter((o) => o !== k);
      for (const o of others) expect(containerSecrets(on.compute, '-web')).not.toContain(o.env);
      const webPolicy = execPolicyText(on.compute, 'WebExecutionRole');
      expect(webPolicy).toContain(`veloexpense/prod/${k.secret}-??????`);
      for (const o of others) expect(webPolicy).not.toContain(`veloexpense/prod/${o.secret}`);
      const workerPolicy = execPolicyText(on.compute, 'WorkerExecutionRole');
      expect(workerPolicy).not.toContain(k.secret);
      // Never the fake model's switch, whatever is on.
      expect(json(on.compute.toJSON())).not.toContain('ASSISTANT_FAKE_ANTHROPIC_URL');
    });
  }

  it('all on: the three keys together, the browser key distinct from the server key', () => {
    const on = synth('dev', { googlePlaces: true, googleMapsBrowser: true, serpapi: true });
    const web = containerSecrets(on.compute, '-web');
    for (const k of KEYS) expect(web).toContain(k.env);
    const text = json(on.compute.toJSON());
    expect(text).toContain('veloexpense/dev/google-places-key');
    expect(text).toContain('veloexpense/dev/google-maps-browser-key');
  });
});
