/**
 * DeployRoleStack — IAM role that GitHub Actions assume to deploy CDK stacks,
 * push to ECR, and run migrations for this stage.
 *
 * VeloExpense: ported from ExpenseOS `infrastructure/cdk/lib/deploy-role-stack.ts`
 * (1e682dd6). What differs, and why:
 *   · ONE account for every Velotech product (535079144866), not an account per
 *     stage. So the role is named per stage (`veloexpense-<stage>-deploy-role`), and
 *     it does NOT get AdministratorAccess: an admin role here could change VeloCRM,
 *     VeloLedger and every other product directly. It gets what a VeloExpense deploy
 *     uses and nothing else (John, 16 Oct 2026) — see "Permissions" below.
 *   · GitHub-hosted runners, not CodeBuild runners in a CI account: there is no
 *     runner account to trust, so the only principal is the GitHub federation.
 *     The database task runs as an ECS task (scripts/deploy-dev.sh), so the runner
 *     needs no route into the VPC.
 *   · The provider is not Terraform's: it already exists in this account, created
 *     outside this repo, and VeloCRM's and VeloLedger's CD roles federate through
 *     it. Same rule as ExpenseOS: named here by its deterministic ARN, never created.
 *
 * Trust:
 *   - GitHub Actions federates directly, through this account's GitHub OIDC
 *     provider, on a subject pinned to this stage's GitHub Environment
 *     (`repo:velotechsystems/product-veloexpense:environment:<stage>`). No stored
 *     credential. The provider itself is NOT created here — it is account-global
 *     shared infrastructure. Its ARN is deterministic, so this stack names it
 *     without a lookup, but it must exist before this trust policy is of any use.
 *   - If OIDC ever fails to assume this role, the way back is a workstation
 *     `cdk deploy` with SSO admin credentials (scripts/deploy-dev.sh), which never
 *     used this role.
 *
 * Permissions (VeloExpense): exactly the calls scripts/deploy-dev.sh and
 * .github/workflows/cd.yml make.
 *   - Take on CDK's bootstrap roles (deploy, file and image publishing, lookup).
 *     `cdk deploy` does all its CloudFormation work through them.
 *   - Push to and read this stage's ECR repository; the login token.
 *   - Read this product's stacks' outputs.
 *   - Start this stage's database task, read tasks, restart this stage's services,
 *     and pass this product's own task roles to ECS (needed to start the task).
 *   - Read this stage's ECS log groups.
 *   The limit, stated plainly: CDK's bootstrap roles are shared by every product
 *   in the account, and CloudFormation runs with the bootstrap execution role,
 *   which has admin rights. So a malicious change merged to main could still reach
 *   another product THROUGH a stack. What this policy removes is the direct path
 *   (an IAM, S3 or RDS call straight from the workflow). The real boundary is the
 *   trust: the stage's Environment, which only `main` may deploy to.
 *
 * Bootstrap: because the CI role does not exist yet on a fresh account, this
 * stack must be deployed ONCE from a workstation with admin credentials
 * (`VELOEXPENSE_STAGE=dev IMAGE_TAG=<deployed tag> npx cdk deploy VeloExpense-Dev-DeployRole`).
 * Every deploy thereafter is managed normally as part of `cdk deploy --all`.
 */

import { CfnOutput, Duration, aws_iam as iam, Stack, type StackProps, Tags } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';

/** GitHub's OIDC issuer. Also the `Url` of the per-account IAM provider. */
const GITHUB_OIDC_ISSUER = 'token.actions.githubusercontent.com';

/**
 * Audience the workflow requests and the trust policy pins. `sts.amazonaws.com`
 * is what `aws-actions/configure-aws-credentials` asks for by default.
 */
const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';

/**
 * VeloExpense: CDK's default bootstrap qualifier. This app sets none (cdk.json), so
 * `cdk deploy` uses the account's default bootstrap roles.
 */
const CDK_BOOTSTRAP_QUALIFIER = 'hnb659fds';

export interface DeployRoleStackProps extends StackProps {
  config: VeloExpenseConfig;
  /** `owner/repo` whose workflows may federate into this role. */
  githubRepository: string;
  /**
   * Override the GitHub OIDC provider ARN. Defaults to this account's, which is
   * deterministic: `arn:<partition>:iam::<account>:oidc-provider/<issuer>`. An
   * IAM provider is account-scoped and unique per URL, so there is nothing to
   * look up — only one can exist.
   */
  oidcProviderArn?: string;
}

export class DeployRoleStack extends Stack {
  public readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: DeployRoleStackProps) {
    super(scope, id, props);

    const { config, githubRepository } = props;
    const prefix = config.resourcePrefix;

    // Referenced, not created (see the header).
    // A role can only name a Federated principal that lives in its own account,
    // and the provider is unique per issuer within an account, so the ARN is
    // fully determined by the account and needs no lookup or cross-stack export.
    const oidcProviderArn =
      props.oidcProviderArn ??
      this.formatArn({
        service: 'iam',
        region: '',
        resource: 'oidc-provider',
        resourceName: GITHUB_OIDC_ISSUER,
      });

    // Pinned to the GitHub Environment, not the repository: a job must declare
    // `environment: <stage>` to present this subject, which binds the role to
    // whatever rules that Environment carries (VeloExpense: dev deploys from
    // `main` only). StringEquals, not StringLike — no pattern is
    // needed here and an exact match cannot be widened by a stray wildcard.
    const githubPrincipal = new iam.FederatedPrincipal(
      oidcProviderArn,
      {
        StringEquals: {
          [`${GITHUB_OIDC_ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${GITHUB_OIDC_ISSUER}:sub`]: `repo:${githubRepository}:environment:${config.stage}`,
        },
      },
      'sts:AssumeRoleWithWebIdentity',
    );

    // VeloExpense: named per stage, since every stage shares one account.
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `${prefix}-deploy-role`,
      description: `GitHub Actions deploy role for VeloExpense ${config.stage}`,
      assumedBy: githubPrincipal,
      // cdk-deploy allows itself 60 minutes; at the IAM default of 1 hour the
      // credential could expire mid-deploy. Federation is not role chaining, so
      // this ceiling is the role's own and the 1-hour chaining cap does not apply.
      maxSessionDuration: Duration.hours(2),
    });

    // VeloExpense: in place of AdministratorAccess, the calls scripts/deploy-dev.sh
    // makes (header, "Permissions"). Each statement names the step it serves.
    const arn = (service: string, resource: string, region = this.region) =>
      `arn:${this.partition}:${service}:${region}:${this.account}:${resource}`;
    const statements: iam.PolicyStatement[] = [
      // 5. `cdk deploy --all`: the CLI does its work through the bootstrap roles.
      new iam.PolicyStatement({
        sid: 'CdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map((r) =>
          arn('iam', `role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${r}-role-${this.account}-${this.region}`, ''),
        ),
      }),
      // 3-4. Is this tag built already; push it if not.
      new iam.PolicyStatement({
        sid: 'EcrLogin',
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'], // the action takes no resource
      }),
      new iam.PolicyStatement({
        sid: 'EcrPushThisRepository',
        actions: [
          'ecr:DescribeImages',
          'ecr:BatchCheckLayerAvailability',
          'ecr:BatchGetImage',
          'ecr:GetDownloadUrlForLayer',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:PutImage',
        ],
        resources: [arn('ecr', `repository/${prefix}/web`)],
      }),
      // 6. Read the Compute stack's outputs: cluster, task family, subnets, group.
      new iam.PolicyStatement({
        sid: 'ReadOwnStacks',
        actions: ['cloudformation:DescribeStacks'],
        resources: [arn('cloudformation', `stack/VeloExpense-${pascal(config.stage)}-*/*`)],
      }),
      // 6. Start the database task, wait for it, read its exit code.
      new iam.PolicyStatement({
        sid: 'RunDatabaseTask',
        actions: ['ecs:RunTask'],
        resources: [arn('ecs', `task-definition/${prefix}-db:*`)],
      }),
      new iam.PolicyStatement({
        sid: 'ReadTasks',
        actions: ['ecs:DescribeTasks'],
        resources: [arn('ecs', 'task/*')],
      }),
      // ECS must be handed the task's own roles to start it; this product's only.
      new iam.PolicyStatement({
        sid: 'PassOwnTaskRoles',
        actions: ['iam:PassRole'],
        resources: [arn('iam', `role/${prefix}-*`, '')],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
      // 7. --restart-worker; and cd.yml's verify step, which restarts and waits for
      // both services (ExpenseOS's "force new deployment if CDK didn't change them").
      new iam.PolicyStatement({
        sid: 'RestartOwnServices',
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: [arn('ecs', `service/*/${prefix}-web`), arn('ecs', `service/*/${prefix}-worker`)],
      }),
      // 6-7. Print the database task's and the worker's log lines.
      new iam.PolicyStatement({
        sid: 'ReadOwnLogs',
        actions: ['logs:FilterLogEvents', 'logs:GetLogEvents', 'logs:DescribeLogStreams'],
        resources: [arn('logs', `log-group:/ecs/${prefix}/*`)],
      }),
    ];
    for (const statement of statements) this.deployRole.addToPolicy(statement);

    new CfnOutput(this, 'DeployRoleArn', {
      value: this.deployRole.roleArn,
      description: 'ARN the CD workflow assumes (role-to-assume)',
      exportName: `${prefix}-deploy-role-arn`,
    });

    for (const [key, value] of Object.entries(config.tags)) {
      Tags.of(this).add(key, value);
    }
  }
}

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
