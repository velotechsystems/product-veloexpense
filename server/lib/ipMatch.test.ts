import { describe, expect, it } from 'vitest';
import { addressBytes, entryMatches, ipAllowed, validateAllowlistEntry } from './ipMatch';

describe('addressBytes', () => {
  it('parses IPv4 and IPv6 to the right width', () => {
    expect(addressBytes('203.0.113.9')).toHaveLength(4);
    expect(addressBytes('2001:db8::1')).toHaveLength(16);
  });

  it('expands :: to the missing zero groups', () => {
    expect(addressBytes('::1')).toEqual(addressBytes('0:0:0:0:0:0:0:1'));
    expect(addressBytes('2001:db8::')).toEqual(addressBytes('2001:db8:0:0:0:0:0:0'));
  });

  it('rejects leading zeros in IPv4', () => {
    // `010` is octal to some parsers and decimal to others. An allowlist must not depend on
    // which one reads it.
    expect(addressBytes('010.0.0.1')).toBeNull();
  });

  it('rejects malformed input rather than coercing it', () => {
    for (const bad of [
      '203.0.113',
      '203.0.113.9.9',
      '256.0.0.1',
      '203.0.113.-1',
      '2001:db8::1::2',
      '2001:db8:::1',
      'gggg::1',
      '',
      '1:2:3:4:5:6:7:8:9',
    ]) {
      expect(addressBytes(bad), bad).toBeNull();
    }
  });

  it('rejects :: standing for zero groups', () => {
    // A full 8-group address with a `::` in it is ambiguous, not merely redundant.
    expect(addressBytes('1:2:3:4:5:6:7::8')).toBeNull();
  });
});

describe('entryMatches', () => {
  it('matches an exact IPv4 and IPv6 address', () => {
    expect(entryMatches('203.0.113.9', '203.0.113.9')).toBe(true);
    expect(entryMatches('203.0.113.9', '203.0.113.10')).toBe(false);
    expect(entryMatches('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(entryMatches('2001:db8::1', '2001:db8::2')).toBe(false);
  });

  it('matches inside an IPv4 CIDR block', () => {
    expect(entryMatches('203.0.113.0/24', '203.0.113.200')).toBe(true);
    expect(entryMatches('203.0.113.0/24', '203.0.114.1')).toBe(false);
  });

  it('matches inside an IPv6 CIDR block — the case the first cut could not express', () => {
    expect(entryMatches('2001:db8::/32', '2001:db8:1234::5')).toBe(true);
    expect(entryMatches('2001:db8::/32', '2001:db9::5')).toBe(false);
    expect(entryMatches('2001:db8:abcd::/48', '2001:db8:abcd:1::9')).toBe(true);
    expect(entryMatches('2001:db8:abcd::/48', '2001:db8:abce:1::9')).toBe(false);
  });

  it('handles non-byte-aligned prefixes', () => {
    expect(entryMatches('203.0.113.0/25', '203.0.113.100')).toBe(true);
    expect(entryMatches('203.0.113.0/25', '203.0.113.200')).toBe(false);
    expect(entryMatches('2001:db8::/33', '2001:db8:7fff::1')).toBe(true);
    expect(entryMatches('2001:db8::/33', '2001:db8:8000::1')).toBe(false);
  });

  it('handles the boundary prefixes', () => {
    expect(entryMatches('0.0.0.0/0', '8.8.8.8')).toBe(true);
    expect(entryMatches('::/0', '2001:db8::1')).toBe(true);
    expect(entryMatches('10.1.2.3/32', '10.1.2.3')).toBe(true);
    expect(entryMatches('10.1.2.3/32', '10.1.2.4')).toBe(false);
  });

  it('never matches across address families', () => {
    // `::ffff:203.0.113.9` satisfying a `203.0.113.0/24` rule is the kind of cleverness
    // that makes an allowlist mean something other than what it says.
    expect(entryMatches('0.0.0.0/0', '2001:db8::1')).toBe(false);
    expect(entryMatches('::/0', '203.0.113.9')).toBe(false);
  });

  it('refuses an out-of-range or malformed prefix', () => {
    expect(entryMatches('203.0.113.0/33', '203.0.113.9')).toBe(false);
    expect(entryMatches('2001:db8::/129', '2001:db8::1')).toBe(false);
    expect(entryMatches('203.0.113.0/x', '203.0.113.9')).toBe(false);
  });
});

describe('validateAllowlistEntry', () => {
  it('accepts what we can actually match against', () => {
    for (const good of ['203.0.113.9', '203.0.113.0/24', '2001:db8::1', '2001:db8::/32', '::/0']) {
      expect(validateAllowlistEntry(good), good).toBe(true);
    }
  });

  it('rejects what would silently never match', () => {
    // The whole reason this function exists: an unparseable entry does not fail open or
    // closed in any obvious way — the key is just refused everywhere, with nothing saying why.
    for (const bad of [
      'nonsense',
      '203.0.113.0/33',
      '2001:db8::/129',
      '203.0.113.0/24/8',
      '203.0.113',
      '',
    ]) {
      expect(validateAllowlistEntry(bad), bad).toBe(false);
    }
  });
});

describe('ipAllowed', () => {
  it('permits anything when no allowlist is set', () => {
    expect(ipAllowed([], '203.0.113.9')).toBe(true);
    expect(ipAllowed([], null)).toBe(true);
    expect(ipAllowed([], 'unknown')).toBe(true);
  });

  it('refuses when the allowlist is set and the address is unknown', () => {
    // "We could not tell where this came from" is not a reason to waive a restriction
    // somebody deliberately set. `clientIp()` returns the literal 'unknown', so that string
    // has to be treated as absent rather than matched.
    expect(ipAllowed(['203.0.113.0/24'], null)).toBe(false);
    expect(ipAllowed(['203.0.113.0/24'], 'unknown')).toBe(false);
  });

  it('passes when any single entry matches', () => {
    expect(ipAllowed(['198.51.100.1', '2001:db8::/32'], '2001:db8::9')).toBe(true);
    expect(ipAllowed(['198.51.100.1', '2001:db8::/32'], '203.0.113.9')).toBe(false);
  });
});
