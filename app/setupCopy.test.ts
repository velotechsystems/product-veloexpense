// @vitest-environment node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETUP_ITEMS } from '@/lib/onboarding/setup';
import { SETUP_COPY } from './setupCopy';

/**
 * Every setup-checklist link opens a page that exists, and the one that does the step.
 *
 * Two links once opened the wrong screen — categories went to the spend rules, structure
 * to the employee list — and a wrong destination is a page that loads fine, so the crawl
 * and the e2e both stayed green. Existence is checked against the route tree (a route is
 * `app/<path>/page.tsx`, or under the `(app)` group); the destination is pinned per item.
 */
const ROOT = join(__dirname, '..');
const routeExists = (href: string) =>
  ['app', join('app', '(app)')].some((base) => existsSync(join(ROOT, base, href, 'page.tsx')));

const SCREEN: Record<(typeof SETUP_ITEMS)[number], string> = {
  APPROVER: '/admin/employees/invite',
  CATEGORIES: '/admin/expense-categories',
  APPROVAL_FLOW: '/admin/approval-workflows',
  SPEND_POLICY: '/admin/expense-policies',
  STRUCTURE: '/admin/legal-entities',
  BRANDING: '/admin/branding',
};

describe('setup checklist links', () => {
  it.each(SETUP_ITEMS)('%s opens the screen that does it', (item) => {
    expect(SETUP_COPY[item].href).toBe(SCREEN[item]);
  });

  it.each(SETUP_ITEMS)('%s links to a page that exists', (item) => {
    expect(routeExists(SETUP_COPY[item].href), SETUP_COPY[item].href).toBe(true);
  });
});
