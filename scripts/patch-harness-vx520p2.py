#!/usr/bin/env python3
"""
VX5-20 part 2 — patch `playwright.config.ts` in place.

WHY A SCRIPT AND NOT THE FILE. `playwright.config.ts` carries edits that belong
to whichever machine runs the suite (browser paths, ports), so a copy from one
tree clobbers the other's. `npm run check:harness` exists to notice that. So the
harness file is PATCHED, never replaced, and the patch is idempotent so a second
run is a no-op rather than a duplicate line.

WHAT IT ADDS. One env var on the app server: `PLATFORM_INBOUND_TOKEN`, which the
provision route requires. UNSET, that route answers 503 to everything and
`e2e/platform-provision.spec.ts` would pass its refusal assertions by the feature
being switched off — the same trap an unset `SMTP_HOST` sets for the mail specs,
and the reason `PLATFORM_API_URL` and `PLATFORM_SERVICE_TOKEN` are already here
with that argument written beside them.

It is a DIFFERENT token from `PLATFORM_SERVICE_TOKEN` on purpose: inbound and
outbound must not be one secret, or a leak in either direction grants both.

Run: python3 scripts/patch-harness-vx520p2.py
"""
import re
import sys
from pathlib import Path

CONFIG = Path('playwright.config.ts')

ANCHOR = "  PLATFORM_SERVICE_TOKEN: 'e2e-platform-token-not-a-real-secret',\n"

ADDITION = """
  // VX5-20 part 2. The INBOUND token, and a different string from the outbound
  // one above: one secret for both directions means a leak in either grants
  // both. Unset, `POST /api/platform/provision` answers 503 to everything and
  // every assertion in `e2e/platform-provision.spec.ts` would pass by the route
  // being off.
  PLATFORM_INBOUND_TOKEN: 'e2e-inbound-token-not-a-real-secret',
"""


def main() -> int:
    if not CONFIG.exists():
        print(f'{CONFIG} not found — run this from the repo root.', file=sys.stderr)
        return 1

    text = CONFIG.read_text(encoding='utf-8')

    if 'PLATFORM_INBOUND_TOKEN' in text:
        print('playwright.config.ts already has PLATFORM_INBOUND_TOKEN — nothing to do.')
        return 0

    if text.count(ANCHOR) != 1:
        print(
            'Could not find exactly one PLATFORM_SERVICE_TOKEN line in APP_ENV.\n'
            'Refusing to guess: add PLATFORM_INBOUND_TOKEN to APP_ENV by hand.',
            file=sys.stderr,
        )
        return 1

    CONFIG.write_text(text.replace(ANCHOR, ANCHOR + ADDITION, 1), encoding='utf-8')

    # Prove it, rather than announcing it.
    after = CONFIG.read_text(encoding='utf-8')
    assert after.count('PLATFORM_INBOUND_TOKEN') == 1, 'patch wrote the wrong number of lines'
    assert re.search(r'PLATFORM_INBOUND_TOKEN: .e2e-inbound-token', after), 'value not written'
    print('playwright.config.ts patched: APP_ENV now sets PLATFORM_INBOUND_TOKEN.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
