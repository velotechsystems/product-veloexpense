/**
 * VeloExpense – environment configuration.
 *
 * Ported from ExpenseOS `infrastructure/cdk/lib/config.ts` (committed per-stage
 * infra values, env only overrides) and adapted to the Velotech suite:
 *
 *   · ONE AWS account (535079144866, ca-central-1) for every Velotech product,
 *     not ExpenseOS's account-per-stage inside E Inc's organisation.
 *   · No VPC, NAT, ECS cluster or ALB of our own. VeloExpense runs on the SHARED
 *     velotech-<stage> infrastructure that product-velocrm's CDK owns, attaching
 *     through the SSM parameters that repo publishes (`shared.ts`). So there are
 *     no subnet tags, no edge mode and no CloudFront here: Cloudflare sits in
 *     front of the shared ALB for every product.
 *   · Two names per environment. `stage` is ours ("staging"); `sharedStage` is
 *     the Velotech infrastructure it runs on ("dev"). They differ on purpose: the
 *     first test environment for real people runs on the shared dev
 *     infrastructure, and calling it "dev" would hide that it is the one people
 *     are told to use.
 *   · No Valkey, no worker service, no SES stack. VeloExpense has no queue
 *     process — its background work is `/api/internal/*` routes that a scheduled
 *     task calls — and mail goes through the suite's Google Workspace SMTP
 *     credential, as VeloCRM's does.
 */

/** VeloExpense environments. Production is added when it is built, not before. */
export type Stage = 'staging';

/** The velotech-<sharedStage> infrastructure an environment runs on. */
export type SharedStage = 'dev' | 'prod';

export interface VeloExpenseConfig {
  stage: Stage;
  sharedStage: SharedStage;
  accountId: string;
  region: string;

  /** `veloexpense-<stage>` — every resource name starts with this. */
  resourcePrefix: string;
  /** `veloexpense/<stage>` — Secrets Manager path prefix. */
  secretPrefix: string;

  /** The ONE host this environment answers on. */
  domainName: string;
  /**
   * `AUTH_COOKIE_DOMAIN`. Undefined means TENANT SUBDOMAINS ARE OFF: every tenant
   * signs in at `domainName` itself. Staging runs this way so the free one-level
   * Cloudflare certificate covers it (decided 5 Oct 2026); production sets it to
   * the apex when `*.veloexpense.ai` tenants are wanted.
   */
  authCookieDomain?: string;

  /**
   * ACM certificate (in `region`) the shared ALB presents for `domainName`, by SNI.
   * Requested outside CDK and DNS-validated by a CNAME in Cloudflare, because a
   * CDK-created certificate would hold the deploy open until somebody added that
   * record by hand.
   */
  albCertificateArn: string;

  /** Rule priority on the shared HTTPS listener; inside VeloExpense's band (100-199). */
  listenerPriority: number;

  rds: {
    databaseName: string;
    minAcu: number;
    maxAcu: number;
    backupRetentionDays: number;
    deletionProtection: boolean;
  };

  web: {
    cpu: number;
    memoryMiB: number;
    desiredCount: number;
    /** node-postgres pool per task (PG_POOL_MAX). No RDS Proxy — see data-stack.ts. */
    pgPoolMax: number;
  };

  /**
   * `/api/internal/*` routes the scheduler calls, and how often. A route is only
   * listed once what it needs exists in this environment: the billing routes talk
   * to the platform (VeloCRM) and stay off until that link is configured.
   */
  schedules: Array<{ name: string; path: string; rate: { minutes: number } }>;

  /** Shared suite SMTP credential (Google Workspace, noreply@velotechsys.ai). */
  smtpSecretName: string;

  tags: Record<string, string>;
}

/** VeloExpense's band on the shared listener — mirrors product-velocrm's LISTENER_PRIORITY_BANDS. */
export const LISTENER_PRIORITY_BAND = { from: 100, to: 199 } as const;

const ACCOUNT_ID = '535079144866';
const REGION = 'ca-central-1';

/**
 * Committed per-stage values. Nothing here is a secret: secrets live in Secrets
 * Manager under `secretPrefix` and reach the container at task start.
 */
const STAGES: Record<Stage, Omit<VeloExpenseConfig, 'resourcePrefix' | 'secretPrefix' | 'tags'>> = {
  staging: {
    stage: 'staging',
    sharedStage: 'dev',
    accountId: ACCOUNT_ID,
    region: REGION,
    domainName: 'staging.veloexpense.ai',
    authCookieDomain: undefined,
    // ACM, ca-central-1, staging.veloexpense.ai — requested and DNS-validated
    // 5 Oct 2026 (validation CNAME in Cloudflare, DNS only; keep it, renewal uses
    // it). ALB_CERTIFICATE_ARN in the environment still overrides (bin/app.ts).
    albCertificateArn: 'arn:aws:acm:ca-central-1:535079144866:certificate/a2c0714c-bf9c-4f69-bed9-a31e1b2a56b9',
    listenerPriority: 100,
    rds: {
      databaseName: 'veloexpense',
      minAcu: 0.5,
      maxAcu: 2,
      backupRetentionDays: 3,
      deletionProtection: false,
    },
    web: { cpu: 512, memoryMiB: 1024, desiredCount: 1, pgPoolMax: 10 },
    schedules: [
      // Mail: invitations, verification links, approval requests. Without this
      // the outbox only moves when an admin presses "Send waiting mail now".
      { name: 'notifications', path: '/api/internal/notifications/drain', rate: { minutes: 2 } },
      // Approved reports to the connected ledger.
      { name: 'ledger', path: '/api/internal/ledger/drain', rate: { minutes: 5 } },
      // Fraud detectors and control evaluation (VX4-8). Retrospective, so daily.
      { name: 'compliance-scan', path: '/api/internal/compliance/scan', rate: { minutes: 1440 } },
      { name: 'compliance-evaluate', path: '/api/internal/compliance/evaluate', rate: { minutes: 1440 } },
    ],
    smtpSecretName: 'velocrm/smtp-credentials',
  },
};

export function buildConfig(stage: Stage, overrides: { albCertificateArn?: string } = {}): VeloExpenseConfig {
  const base = STAGES[stage];
  if (!base) throw new Error(`Unknown VeloExpense stage "${stage}". Known: ${Object.keys(STAGES).join(', ')}`);

  const config: VeloExpenseConfig = {
    ...base,
    albCertificateArn: overrides.albCertificateArn || base.albCertificateArn,
    resourcePrefix: `veloexpense-${stage}`,
    secretPrefix: `veloexpense/${stage}`,
    tags: { Product: 'veloexpense', Environment: stage, SharedStage: base.sharedStage, ManagedBy: 'cdk' },
  };

  const { from, to } = LISTENER_PRIORITY_BAND;
  if (config.listenerPriority < from || config.listenerPriority > to) {
    throw new Error(
      `listenerPriority ${config.listenerPriority} is outside VeloExpense's band ${from}-${to} ` +
        'on the shared listener (product-velocrm lib/shared-contract.ts).',
    );
  }
  if (!config.albCertificateArn) {
    throw new Error(
      `No ACM certificate for ${config.domainName}. Set albCertificateArn for "${stage}" in lib/config.ts ` +
        'or ALB_CERTIFICATE_ARN in the environment.',
    );
  }
  return config;
}
