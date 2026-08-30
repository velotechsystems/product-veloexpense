/**
 * VX3-3 — the secret envelope. No database.
 *
 * The properties here are the ones whose absence is invisible: a value that looks
 * encrypted and is not, a tampered ciphertext that decrypts to something
 * plausible, a key length nobody checked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  secretEquals,
  SecretError,
} from '@/lib/crypto/secrets';

const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.SECRET_ENCRYPTION_KEY;
  process.env.SECRET_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = saved;
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    const sealed = encryptSecret('hunter2');
    expect(sealed).not.toContain('hunter2');
    expect(decryptSecret(sealed)).toBe('hunter2');
  });

  it('marks its output, and recognises only its own', () => {
    expect(isEncrypted(encryptSecret('x'))).toBe(true);
    expect(isEncrypted('x')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(42)).toBe(false);
  });

  it('produces a different ciphertext each time for the same input', () => {
    // A fresh IV per call. Deterministic output would let anyone holding the
    // database see which two tenants use the same credential.
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('is idempotent on already-encrypted input', () => {
    // The one tolerance kept: `prepareConfig` carries an unchanged secret forward
    // from storage, so a re-save legitimately hands ciphertext back.
    const once = encryptSecret('token');
    expect(encryptSecret(once)).toBe(once);
    expect(decryptSecret(encryptSecret(once))).toBe('token');
  });

  it('REFUSES an unmarked value instead of passing it through', () => {
    // The tolerance NOT ported. ExpenseOS lets any non-marked value through
    // untouched, which is how their env-bootstrap path stores a Google client
    // secret in cleartext and the reader accepts it without a murmur (AC-4).
    expect(() => decryptSecret('plaintext-token')).toThrow(SecretError);
    expect(() => decryptSecret('plaintext-token')).toThrow(/refusing to use it/);
  });

  it('refuses a tampered ciphertext rather than returning plausible bytes', () => {
    // GCM authenticates; this is why it is not CBC.
    const sealed = encryptSecret('sensitive');
    const body = sealed.slice('enc:v1:'.length);
    const bytes = Buffer.from(body, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    const tampered = 'enc:v1:' + bytes.toString('base64');
    expect(() => decryptSecret(tampered)).toThrow(/altered/);
  });

  it('refuses a truncated envelope', () => {
    expect(() => decryptSecret('enc:v1:' + Buffer.alloc(8).toString('base64'))).toThrow(
      /truncated/,
    );
  });

  it('fails under the wrong key, with the same message as tampering', () => {
    const sealed = encryptSecret('sensitive');
    process.env.SECRET_ENCRYPTION_KEY = OTHER_KEY;
    // Deliberately indistinguishable: the difference is not actionable, and
    // telling them apart tells an attacker which of the two they achieved.
    expect(() => decryptSecret(sealed)).toThrow(/the key is wrong or the stored value/);
  });

  it('refuses to work at all with no key, and says what to run', () => {
    delete process.env.SECRET_ENCRYPTION_KEY;
    expect(() => encryptSecret('x')).toThrow(/openssl rand -base64 32/);
  });

  it('refuses a key of the wrong length rather than padding it', () => {
    process.env.SECRET_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptSecret('x')).toThrow(/decodes to 16 bytes/);
  });

  it('refuses a passphrase', () => {
    // Accepting one means deriving a key from arbitrary entropy, and the failure
    // mode is a product encrypted under eight bytes.
    process.env.SECRET_ENCRYPTION_KEY = 'correct horse battery staple';
    expect(() => encryptSecret('x')).toThrow(SecretError);
  });
});

describe('secretEquals', () => {
  it('compares equal and unequal values', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
  });

  it('returns false on a length mismatch without throwing', () => {
    // timingSafeEqual throws on differing lengths; the length is not the secret.
    expect(secretEquals('abc', 'abcd')).toBe(false);
  });
});
