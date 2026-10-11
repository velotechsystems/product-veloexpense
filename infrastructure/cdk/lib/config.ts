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
 *   · Two names per environment, `stage` (ours) and `sharedStage` (the Velotech
 *     infrastructure it runs on). Today they are the same word: VeloExpense's one
 *     deployed test environment is "dev", on velotech-dev, at dev.veloexpense.ai —
 *     named like VeloCRM's dev.velocrm.ai on the same cluster (DECIDED 6 Oct 2026,
 *     John: suite-consistent names everywhere, rather than "staging"). They stay
 *     separate fields because production will be stage "prod" on sharedStage
 *     "prod", and nothing should assume the two always match.
 *   · Outgoing mail goes through the suite's Google Workspace SMTP credential, as
 *     VeloCRM's does. SES only RECEIVES, for receipts by email (w3-06, mail-stack.ts).
 *   · Valkey and the worker service arrived with receipt extraction (w3-00, d41),
 *     sized for dev. Background work that was already VeloExpense's own —
 *     notifications, the ledger, compliance — stays on the `/api/internal/*`
 *     routes a scheduled task calls; the worker runs only the jobs ported with it.
 */

/** VeloExpense environments. Production is added when it is built, not before. */
export type Stage = 'dev';

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
   * signs in at `domainName` itself. Dev runs this way so the free one-level
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

  /** ExpenseOS's ElastiCache Valkey (cache-stack.ts): BullMQ's queues. */
  valkey: {
    nodeType: string; // e.g. "cache.t4g.micro"
    numReplicas: number; // 0 = single-node, >0 = multi-AZ with failover
    engineVersion: string; // Valkey, e.g. "8.0"
    snapshotRetentionDays: number;
  };

  /** The BullMQ consumer (worker/). No listener, so no target group or health route. */
  worker: {
    cpu: number;
    memoryMiB: number;
    desiredCount: number;
  };

  /**
   * `/api/internal/*` routes the scheduler calls, and how often. A route is only
   * listed once what it needs exists in this environment: the billing routes talk
   * to the platform (VeloCRM) and stay off until that link is configured.
   */
  schedules: Array<{ name: string; path: string; rate: { minutes: number } }>;

  /** Shared suite SMTP credential (Google Workspace, noreply@velotechsys.ai). */
  smtpSecretName: string;

  /**
   * Receipts by email (w3-06, mail-stack.ts). Absent leaves it off: no Mail stack, and the
   * app ignores whatever reaches its endpoint (INBOUND_EMAIL_DOMAIN unset).
   *
   * ExpenseOS's `ses.inbound` block, reduced to what VeloExpense receives: one mailbox, on
   * every tenant's own subdomain of `domain` (d47) — no reply mailbox (w5-01), and no public
   * forwarding domain, since SES receives on the tenant's address itself.
   */
  inboundEmail?: {
    /** Each tenant's mail domain is ONE label under this: `receipts@<tenant>.<domain>`. */
    domain: string;
    /** The app endpoint SNS posts to. Public: SNS cannot reach an internal edge. */
    webhookUrl: string;
    /** Local parts that mean "receipts", e.g. `['receipts']`. */
    receiptsMailboxes: string[];
    /** Days a raw message is kept. ExpenseOS's default, 14. */
    retentionDays: number;
    /**
     * Make this stack's rule set the account's active one. SES allows ONE per account and
     * region, and the account is shared by every Velotech product — so this is decided per
     * environment, after checking nothing else uses inbound SES there.
     */
    activateRuleSet: boolean;
    /** Rule set to re-activate when the stack is deleted; absent clears the active set. */
    restoreRuleSetNameOnDelete?: string;
  };

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
  dev: {
    stage: 'dev',
    sharedStage: 'dev',
    accountId: ACCOUNT_ID,
    region: REGION,
    domainName: 'dev.veloexpense.ai',
    authCookieDomain: undefined,
    // ACM, ca-central-1, dev.veloexpense.ai — DNS-validated by a CNAME in
    // Cloudflare (DNS only; keep it, renewal uses it). ALB_CERTIFICATE_ARN in the
    // environment still overrides (bin/app.ts).
    albCertificateArn: 'arn:aws:acm:ca-central-1:535079144866:certificate/b9d463c0-8c2f-4754-bf39-cd4231b92a9c',
    listenerPriority: 100,
    rds: {
      databaseName: 'veloexpense',
      minAcu: 0.5,
      maxAcu: 2,
      backupRetentionDays: 3,
      deletionProtection: false,
    },
    web: { cpu: 512, memoryMiB: 1024, desiredCount: 1, pgPoolMax: 10 },
    // ExpenseOS's dev runs cache.t4g.small; micro is the smallest that takes the
    // noeviction parameter group, and one queue consumer is all it serves (d41).
    valkey: { nodeType: 'cache.t4g.micro', numReplicas: 0, engineVersion: '8.0', snapshotRetentionDays: 1 },
    // ExpenseOS's dev worker is 1 vCPU / 2 GiB. Half that here: one task, and the
    // receipt images sharp normalises are phone photos, not scans.
    worker: { cpu: 512, memoryMiB: 1024, desiredCount: 1 },
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
    inboundEmail: {
      domain: 'mail.dev.veloexpense.ai',
      webhookUrl: 'https://dev.veloexpense.ai/api/email/inbound',
      receiptsMailboxes: ['receipts'],
      retentionDays: 14,
      activateRuleSet: false,
    },
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
