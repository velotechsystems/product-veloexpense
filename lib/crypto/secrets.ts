/**
 * VX3-3 — authenticated encryption for secrets stored in a jsonb config blob.
 *
 * Used for a tenant's accounting credentials. The envelope is versioned so a key
 * rotation or an algorithm change is a migration rather than an archaeology
 * exercise:
 *
 *     enc:v1:<base64( iv[12] || authTag[16] || ciphertext )>
 *
 * ── Why this is in Node and not in Postgres ─────────────────────────────────
 *
 * ExpenseOS does the equivalent with pgcrypto — `pgp_sym_encrypt(${plaintext},
 * ${key})` through `$queryRaw`, for card PANs and for integration configs alike
 * (GAP-AUDIT AC-4). It works, and the crypto is Postgres's rather than ours, which
 * is a real argument. The reason not to copy it: the KEY travels to the database
 * on every read and every write. They are bind parameters rather than statement
 * text, so this is not the disaster it first sounds like — but Postgres can be
 * configured to log bind parameters, the key is then in the database process's
 * memory as well as the app's, and every environment including CI needs the
 * pgcrypto extension. Doing it here means the database only ever sees ciphertext.
 *
 * AES-256-GCM rather than CBC: it authenticates. A tampered ciphertext fails to
 * decrypt instead of returning plausible bytes, which matters for a value that is
 * about to be used as a credential against somebody's accounting system.
 *
 * ── The tolerance we deliberately do NOT port ───────────────────────────────
 *
 * Their decrypt path is marker-driven and forgiving: "any top-level string value
 * beginning with `enc:v1:` is decrypted; everything else (including legacy
 * plaintext …) passes through untouched." Tolerance plus a second writer is the
 * defect — `bootstrap.ts` writes a Google client secret straight into `config` and
 * never calls the encrypt helper, so an env-bootstrapped installation stores a
 * password-marked secret in cleartext and the reader accepts it without a murmur.
 * VeloExpense has no legacy rows to be tolerant of, so `decryptSecret` REFUSES an
 * unmarked value rather than returning it.
 */
import { DomainError } from '@/lib/errors/domain';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const MARKER = 'enc:v1:';
const IV_BYTES = 12; // GCM standard; 96 bits is what the mode is specified for
const TAG_BYTES = 16;
const KEY_BYTES = 32; // AES-256

export class SecretError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'SecretError';
  }
}

/**
 * The key, from `SECRET_ENCRYPTION_KEY`, as exactly 32 base64-encoded bytes.
 *
 * Read at CALL time, not at module load — same reasoning as `appOrigin()` in
 * `lib/notifications/email.ts` (NT-14): a module-load read means a test cannot set
 * it, and a missing key becomes a boot crash in an unrelated place instead of a
 * clear failure at the operation that needed it.
 *
 * A passphrase is NOT accepted. Deriving a key from an arbitrary string needs a
 * salt, a fixed salt is a smell, and the failure mode of accepting one is a
 * product encrypted under eight bytes of entropy. The error says what to run.
 */
function key(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    throw new SecretError(
      'SECRET_ENCRYPTION_KEY is not set, so integration credentials cannot be ' +
        'encrypted or read. Generate one with: openssl rand -base64 32',
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new SecretError('SECRET_ENCRYPTION_KEY is not valid base64');
  }
  if (decoded.length !== KEY_BYTES) {
    throw new SecretError(
      `SECRET_ENCRYPTION_KEY decodes to ${decoded.length} bytes; AES-256 needs ` +
        `exactly ${KEY_BYTES}. Generate one with: openssl rand -base64 32`,
    );
  }
  return decoded;
}

/** True for a value this module wrote. */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MARKER);
}

export function encryptSecret(plaintext: string): string {
  // Already encrypted: return as-is. This is the ONE tolerance kept, and it is
  // not the dangerous one — it exists because `mergeSecrets` carries an unchanged
  // secret forward from storage, so a re-save legitimately hands us ciphertext.
  if (isEncrypted(plaintext)) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MARKER + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    // The refusal described in the header. An unmarked value in a secret field is
    // either a bug in a writer or a tampered row; both want a loud failure.
    throw new SecretError(
      'a secret field holds an unencrypted value — refusing to use it. This is a ' +
        'bug in whatever wrote it, not a value to fall back on.',
    );
  }
  const blob = Buffer.from(value.slice(MARKER.length), 'base64');
  if (blob.length < IV_BYTES + TAG_BYTES + 1) {
    throw new SecretError('encrypted secret is truncated');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM's tag check failed: wrong key, or the row was altered. Deliberately one
    // message for both — the difference is not something a caller can act on, and
    // distinguishing them tells an attacker which of the two they achieved.
    throw new SecretError(
      'could not decrypt a secret: the key is wrong or the stored value has been altered',
    );
  }
}

/** Constant-time compare, for a secret a caller is verifying rather than reading. */
export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
