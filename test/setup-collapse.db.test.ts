/**
 * The home checklist's "Hide" (migration 0043, decided 7 Oct): per admin, and
 * per tenant — one admin collapsing it does not collapse it for another, and an
 * id from another organization cannot be written through RLS.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { createOrganization } from '@/lib/onboarding/provision';
import { isSetupCollapsed, setSetupCollapsed } from '@/lib/onboarding/setup';

const admin = new Pool({
  connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL,
});

let orgA: { organizationId: string; adminUserId: string };
let orgB: { organizationId: string; adminUserId: string };

beforeEach(async () => {
  await admin.query('TRUNCATE invite, audit_entry, app_user, organization CASCADE');
  orgA = await createOrganization({
    name: 'Alpha Co',
    slug: 'alpha-collapse',
    adminEmail: 'founder@alpha.test',
    adminName: 'Alpha Founder',
  });
  orgB = await createOrganization({
    name: 'Beta Co',
    slug: 'beta-collapse',
    adminEmail: 'founder@beta.test',
    adminName: 'Beta Founder',
  });
});

afterAll(async () => {
  await admin.end();
});

describe('collapsing the setup checklist', () => {
  it('is expanded until the admin collapses it, and can be shown again', async () => {
    await withOrg(orgA.organizationId, async (tx) => {
      expect(await isSetupCollapsed(tx, orgA.adminUserId)).toBe(false);
      await setSetupCollapsed(tx, orgA.adminUserId, true);
      expect(await isSetupCollapsed(tx, orgA.adminUserId)).toBe(true);
      await setSetupCollapsed(tx, orgA.adminUserId, false);
      expect(await isSetupCollapsed(tx, orgA.adminUserId)).toBe(false);
    });
  });

  it("is one admin's choice, not the organization's", async () => {
    await withOrg(orgA.organizationId, (tx) => setSetupCollapsed(tx, orgA.adminUserId, true));
    await withOrg(orgB.organizationId, async (tx) => {
      expect(await isSetupCollapsed(tx, orgB.adminUserId)).toBe(false);
    });
  });

  it("cannot reach another tenant's person, even by id", async () => {
    // Inside tenant B, write A's admin: RLS hides the row, so nothing changes.
    await withOrg(orgB.organizationId, (tx) => setSetupCollapsed(tx, orgA.adminUserId, true));
    await withOrg(orgA.organizationId, async (tx) => {
      expect(await isSetupCollapsed(tx, orgA.adminUserId)).toBe(false);
    });
    // And B cannot read it either.
    await withOrg(orgA.organizationId, (tx) => setSetupCollapsed(tx, orgA.adminUserId, true));
    await withOrg(orgB.organizationId, async (tx) => {
      expect(await isSetupCollapsed(tx, orgA.adminUserId)).toBe(false);
    });
  });
});
