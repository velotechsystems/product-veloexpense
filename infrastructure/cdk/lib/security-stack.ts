/**
 * SecurityStack – the KMS key and the secrets VeloExpense's containers read.
 *
 * Ported from ExpenseOS `security-stack.ts`. Kept: one master key with yearly
 * rotation; CDK-GENERATED secrets that are RETAINed (a session-signing secret
 * destroyed with the stack logs everybody out and cannot be got back); secrets
 * that must be made by a person REFERENCED by name, never created here.
 *
 * Dropped, and why:
 *   · The audit key — ExpenseOS archives audit rows to an Object Lock bucket.
 *     VeloExpense's audit trail is the hash chain in Postgres (lib/audit).
 *   · The CloudFront WAF — there is no CloudFront; Cloudflare fronts the shared
 *     ALB, and VeloCRM's stack owns the regional WAF on it.
 *   · pg-crypto-key — that encrypts ExpenseOS's virtual-card numbers. VeloExpense
 *     has no VCC module (HANDOFF Phase 5). Its own envelope key is
 *     SECRET_ENCRYPTION_KEY, below.
 *
 * GENERATED HERE (nobody types them, nobody needs to know them):
 *   auth-secret     NextAuth session signing (AUTH_SECRET).
 *   worker-secret   Bearer token for /api/internal/* (WORKER_SECRET). The
 *                   scheduled caller reads the same secret.
 *   app-db          {username: "veloapp", password} — the ONLY database
 *                   credential the running app ever receives. Alphanumeric, so
 *                   it can sit in a URL without escaping (docker-entrypoint.sh).
 *
 * MADE BY A PERSON FIRST (the deploy fails if one is missing, by design — a
 * referenced secret that does not exist blocks task start, which is louder than
 * an app that boots without it):
 *   secret-encryption-key   32 random bytes, base64 (`openssl rand -base64 32`).
 *                           Encrypts integration credentials at rest. NEVER
 *                           rotate it in place: stored credentials become
 *                           unreadable.
 *   google-oauth            {"clientId": …, "clientSecret": …} — the Google
 *                           sign-in client for this environment's host.
 *   anthropic-api-key       The VeloExpense Anthropic API key (w3-02a, d40),
 *                           plain text. Read by the worker (receipt reading)
 *                           and, since w6-03 (d90), the web task (the assistant).
 *   mcp-oauth-signing-key   mcp-oauth: the RSA-2048 private key (PKCS#8 PEM, plain text)
 *                           that signs MCP access tokens for Claude connectors — VeloCRM's
 *                           `velocrm/mcp/oauth-signing-key`, made the same way:
 *                           `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`.
 *                           Read by the web task only. Rotating it: put the old PEM in a
 *                           `-previous` secret first (lib/mcpOauth/keys.ts); replacing it
 *                           outright only signs every connector out (they reconnect).
 */
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  aws_kms as kms,
  aws_secretsmanager as secretsmanager,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { VeloExpenseConfig } from './config';

export interface SecurityStackProps extends StackProps {
  config: VeloExpenseConfig;
}

/** Secrets a person creates before the first deploy. Name suffix under `secretPrefix`. */
export const MANUAL_SECRETS = [
  'secret-encryption-key',
  'google-oauth',
  'anthropic-api-key',
  'mcp-oauth-signing-key',
] as const;

/**
 * 18 Oct 2026: the token the platform presents to `/api/platform/provision`, made by a person
 * where `platformProvisioning` is on (production). 48+ random characters. Not in
 * MANUAL_SECRETS because dev does not need it.
 */
export const PLATFORM_INBOUND_TOKEN_SECRET = 'platform-inbound-token';

/** mcp-oauth: the MCP access-token signing key's name under `secretPrefix` (MANUAL_SECRETS). */
export const MCP_OAUTH_SIGNING_KEY_SECRET = 'mcp-oauth-signing-key';

/** The Anthropic key's name under `secretPrefix` (MANUAL_SECRETS). */
export const ANTHROPIC_API_KEY_SECRET = 'anthropic-api-key';

export class SecurityStack extends Stack {
  public readonly masterKey: kms.Key;
  public readonly authSecret: secretsmanager.Secret;
  public readonly workerSecret: secretsmanager.Secret;
  public readonly appDbSecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);
    const { config } = props;
    const prefix = config.resourcePrefix;

    this.masterKey = new kms.Key(this, 'MasterKey', {
      alias: `${prefix}/master`,
      description: 'VeloExpense master encryption key (RDS, S3, ECR, Secrets Manager)',
      enableKeyRotation: true,
      rotationPeriod: Duration.days(365),
      // RETAIN even outside production: a destroyed key makes every snapshot and
      // every object encrypted under it unrecoverable, test environments included.
      removalPolicy: RemovalPolicy.RETAIN,
      pendingWindow: Duration.days(30),
    });

    const generated = (cid: string, name: string, description: string, opts: secretsmanager.SecretStringGenerator) => {
      const s = new secretsmanager.Secret(this, cid, {
        secretName: `${config.secretPrefix}/${name}`,
        description,
        generateSecretString: opts,
        encryptionKey: this.masterKey,
      });
      s.applyRemovalPolicy(RemovalPolicy.RETAIN);
      return s;
    };

    this.authSecret = generated('AuthSecret', 'auth-secret', 'NextAuth session signing (AUTH_SECRET)', {
      passwordLength: 64,
      excludePunctuation: true,
    });
    this.workerSecret = generated('WorkerSecret', 'worker-secret', 'Bearer token for /api/internal/* (WORKER_SECRET)', {
      passwordLength: 48,
      excludePunctuation: true,
    });
    this.appDbSecret = generated('AppDbSecret', 'app-db', 'veloapp database login - the only DB credential the app receives', {
      secretStringTemplate: JSON.stringify({ username: 'veloapp' }),
      generateStringKey: 'password',
      passwordLength: 40,
      excludePunctuation: true,
    });

    for (const [key, value] of Object.entries(config.tags)) Tags.of(this).add(key, value);
  }
}
