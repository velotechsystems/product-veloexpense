/**
 * Address matching for an API key's allowlist — IPv4 and IPv6, exact or CIDR.
 *
 * Split out from the guard because it is pure, fiddly, and the failure mode is silent: the
 * first cut parsed IPv4 only and returned false for anything else, so a key with an
 * allowlist reached over IPv6 was refused with no indication that the allowlist itself
 * could not express the caller's address. `validateAllowlistEntry` exists so that
 * configuration is refused where somebody types it, rather than discovered at 3am.
 *
 * Ported from ExpenseOS `apps/web/src/server/lib/ipMatch.ts` (1e682dd6), w6-04 (d88).
 */

/** Expand an address to its bytes, or null if it is not one. */
export function addressBytes(value: string): Uint8Array | null {
  return value.includes(':') ? ipv6Bytes(value) : ipv4Bytes(value);
}

function ipv4Bytes(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    // Reject leading zeros: `010` is ambiguous (octal in some parsers) and an allowlist
    // must not depend on which parser reads it.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipv6Bytes(value: string): Uint8Array | null {
  // One `::` at most, and it expands to however many zero groups are missing.
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (text: string): number[] | null => {
    if (text === '') return [];
    const groups: number[] = [];
    for (const g of text.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(Number.parseInt(g, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // `::` must stand for at least one group
    groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = groups[i] >> 8;
    out[i * 2 + 1] = groups[i] & 0xff;
  }
  return out;
}

/** Do the first `bits` bits of two equal-length byte arrays agree? */
function prefixMatches(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  const whole = bits >> 3;
  for (let i = 0; i < whole; i++) if (a[i] !== b[i]) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (a[whole] & mask) === (b[whole] & mask);
}

/** Is this allowlist entry something we can actually match against? */
export function validateAllowlistEntry(entry: string): boolean {
  const [address, bitsRaw, ...extra] = entry.split('/');
  if (extra.length > 0) return false;
  const bytes = addressBytes(address);
  if (!bytes) return false;
  if (bitsRaw === undefined) return true;
  if (!/^\d{1,3}$/.test(bitsRaw)) return false;
  const bits = Number(bitsRaw);
  return bits >= 0 && bits <= bytes.length * 8;
}

/**
 * Does `ip` satisfy one allowlist entry?
 *
 * An IPv4 entry never matches an IPv6 caller and vice versa — no mapping between families
 * is attempted, because `::ffff:203.0.113.9` matching a `203.0.113.0/24` rule is the kind of
 * cleverness that makes an allowlist mean something different from what it says.
 */
export function entryMatches(entry: string, ip: string): boolean {
  const [address, bitsRaw] = entry.split('/');
  const target = addressBytes(address);
  const caller = addressBytes(ip);
  if (!target || !caller) return false;
  if (target.length !== caller.length) return false;
  if (bitsRaw === undefined) return prefixMatches(target, caller, target.length * 8);
  if (!/^\d{1,3}$/.test(bitsRaw)) return false;
  const bits = Number(bitsRaw);
  if (bits < 0 || bits > target.length * 8) return false;
  return prefixMatches(target, caller, bits);
}

/**
 * Does this caller satisfy the key's allowlist?
 *
 * Empty allowlist means unrestricted. A NON-empty allowlist with an unknown caller address
 * refuses: "we could not tell where this came from" is not a reason to waive a restriction
 * somebody deliberately set.
 */
export function ipAllowed(allowed: readonly string[], ip: string | null): boolean {
  if (allowed.length === 0) return true;
  if (!ip || ip === 'unknown') return false;
  return allowed.some((entry) => entryMatches(entry, ip));
}
