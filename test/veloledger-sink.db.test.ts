/**
 * VX3-9a — the REAL VeloLedger adapter against a REAL HTTP far end.
 *
 * ── Why this file exists, and what it changes ───────────────────────────────
 *
 * The tracker has carried "the VeloLedger adapter has never met a real
 * VeloLedger" as an open item since VX3-4, and `test/veloledger-adapter.test.ts`
 * only narrowed it: that suite stubs `fetch`, so it proves which calls we make and
 * in what order, and nothing about whether an HTTP round trip works.
 *
 * This suite starts `scripts/e2e-ledger.mjs` — the same sink the e2e uses — and
 * drives the adapter through `postOne`, the path that ships. So it covers the
 * seam every stubbed test leaves open: a real socket, a real status code, a real
 * JSON body, and the payload as it actually goes over the wire.
 *
 * It still has not met a real VeloLedger, and that item stays open. What it has
 * met is a far end that answers on the documented tool names.
 *
 * ── The assertion that matters most ─────────────────────────────────────────
 *
 * The account PRE-FLIGHT. VX3-7 added it because `createBill` stores
 * `expense_account_number` as plain text and resolves it only when a human posts,
 * so a bill can draft perfectly and be permanently unpostable. Until now that
 * pre-flight was tested against a stubbed `list_accounts`. Here the far end really
 * answers with a chart, the adapter really compares, and a number the chart does
 * not have produces a local refusal with NOTHING drafted — which is the whole
 * point of it.
 *
 * ── It starts its own sink ──────────────────────────────────────────────────
 *
 * A test that needs a process someone remembered to start is a test that fails on
 * a laptop and blocks CI. Ports are distinct from the Playwright run's defaults so
 * `npm test` and `npx playwright test` cannot collide — the lesson VX2-10 paid for
 * when Playwright's port probe silently adopted a local MinIO.
 */
// Not ambient: CI exports it for the whole job, which hid that this suite needs
// it. `beforeAll` installs the adapter with an `apiKey`, a `secret` field, and
// `encryptSecret` refuses without a key — so without this the hook throws and
// the suite's three tests report as SKIPPED, not failed, beside 1,700 passes.
// Read at call time, so assigning after the hoisted imports is in time.
process.env.SECRET_ENCRYPTION_KEY =
  process.env.SECRET_ENCRYPTION_KEY ?? Buffer.alloc(32, 19).toString('base64');

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { withOrg } from '@/lib/tenant/context';
import { installIntegration, testInstallation } from '@/lib/integrations/service';
import * as outbox from '@/lib/integrations/post-outbox';
import { postOne } from '@/lib/integrations/dispatch';

const LEDGER_PORT = 9451;
const CONTROL_PORT = 9452;
const SINK = `http://localhost:${LEDGER_PORT}`;
const CONTROL = `http://localhost:${CONTROL_PORT}`;
const ENTITY = '00000000-0000-4000-8000-0000000000e1';

let sink: ChildProcess;

/** Wait for the control port to answer, rather than sleeping and hoping. */
async function waitForSink(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${CONTROL}/bills`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('the e2e ledger sink did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
let orgId: string, actorId: string, catId: string, acctId: string, instId: string;

beforeAll(async () => {
  sink = spawn(process.execPath, ['scripts/e2e-ledger.mjs'], {
    env: {
      ...process.env,
      E2E_LEDGER_PORT: String(LEDGER_PORT),
      E2E_LEDGER_CONTROL_PORT: String(CONTROL_PORT),
      E2E_LEDGER_ENTITY_ID: ENTITY,
    },
    stdio: 'ignore',
  });
  await waitForSink();

  await admin.query('TRUNCATE app_user, organization CASCADE');
  // UD-8: AUTOMATIC explicitly; see test/posting-trigger.db.test.ts for the
  // AP_QUEUE half. The default for a new organization is now AP_QUEUE.
  const o = await admin.query(
    "INSERT INTO organization (slug,name,posting_trigger) VALUES ('real','Real','AUTOMATIC') RETURNING id",
  );
  orgId = o.rows[0].id;

  // VX4-1: ABSENCE MEANS OFF. Entitled HERE and not at the end of this hook,
  // because the hook itself calls `installIntegration` below — a gated write. The
  // first mechanical placement put this line after that call and the suite failed
  // with ModuleDisabledError from its own setup.
  await admin.query(
    `INSERT INTO module_entitlement (organization_id, module_code, enabled)
     VALUES ($1, 'accounting', true)`,
    [orgId],
  );
  await withOrg(orgId, async (tx) => {
    const u = await tx.query("INSERT INTO app_user (organization_id,email,role_id) VALUES ($1,'a@r.test','019e3000-0000-7000-8000-000000000001') RETURNING id", [orgId]);
    actorId = u.rows[0].id;
    const a = await tx.query(
      `INSERT INTO gl_account (organization_id,number,name,type,is_postable,source)
       VALUES ($1,'68100','Travel','expense',true,'MANUAL') RETURNING id`, [orgId]);
    acctId = a.rows[0].id;
    const c = await tx.query(
      `INSERT INTO expense_category (organization_id,code,label,gl_account_id)
       VALUES ($1,'travel','{"en":"Travel"}',$2) RETURNING id`, [orgId, acctId]);
    catId = c.rows[0].id;
  });
  const i = await withOrg(orgId, (tx) => installIntegration(tx, {
    slug: 'veloledger', code: 'main', label: 'Sink Ledger',
    config: { baseUrl: SINK, apiKey: 'sink-key', entityId: ENTITY, vendorRef: 'V-1' },
  }, actorId));
  instId = i.id;
});

afterAll(async () => {
  sink.kill('SIGTERM');
  await admin.end();
});

describe('the real VeloLedger adapter, over real HTTP', () => {
  it('testConnection reaches the sink and declines to overclaim', async () => {
    const r = await withOrg(orgId, (tx) => testInstallation(tx, instId));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('Sink Entity');
    expect(r.detail).toMatch(/does not prove the key may DRAFT/i);
  });

  it('posts a bill: resolve_period, the account pre-flight, then draft_bill', async () => {
    const reportId = await withOrg(orgId, async (tx) => {
      const rep = await tx.query(
        `INSERT INTO expense_report (organization_id,submitter_id,title,currency_code,status,approved_at,number,total_minor)
         VALUES ($1,$2,'Sink trip','CAD','APPROVED',clock_timestamp(),'EXP-777',5000) RETURNING id`, [orgId, actorId]);
      const rid = rep.rows[0].id as string;
      const e = await tx.query(
        `INSERT INTO expense (organization_id,report_id,currency_code,merchant,txn_date)
         VALUES ($1,$2,'CAD','Beck',current_date) RETURNING id`, [orgId, rid]);
      await tx.query(
        `INSERT INTO expense_line_item (organization_id,expense_id,category_id,amount_minor,description,gl_account_id)
         VALUES ($1,$2,$3,5000,'taxi',$4)`, [orgId, e.rows[0].id, catId, acctId]);
      await outbox.enqueuePost(tx, rid);
      return rid;
    });
    const q = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(await postOne(orgId, q[0].id)).toBe('POSTED');

    const received = await (await fetch(`${CONTROL}/bills`)).json();
    expect(received.count).toBe(1);
    const b = received.bills[0];
    expect(b.via).toBe('veloledger');
    expect(b.authorization).toBe('Bearer sink-key');
    // THE payload assertions — the real adapter's real shape.
    expect(b.payload.idempotencyKey).toBe(`veloexpense-report-${reportId}`);
    expect(b.payload.vendorRef).toBe('V-1');
    expect(b.payload.entityId).toBe(ENTITY);
    expect(b.payload.periodId).toBeTruthy();
    expect(b.payload.lines).toHaveLength(1);
    expect(b.payload.lines[0].expenseAccountNumber).toBe('68100');
    expect(b.payload.lines[0].unitPriceMinor).toBe('5000');
  });

  it('the account PRE-FLIGHT refuses a number the sink does not have', async () => {
    await withOrg(orgId, (tx) => tx.query(
      "UPDATE gl_account SET number = '99999' WHERE organization_id = $1", [orgId]));
    const reportId = await withOrg(orgId, async (tx) => {
      const rep = await tx.query(
        `INSERT INTO expense_report (organization_id,submitter_id,title,currency_code,status,approved_at,number,total_minor)
         VALUES ($1,$2,'Unmapped','CAD','APPROVED',clock_timestamp(),'EXP-778',5000) RETURNING id`, [orgId, actorId]);
      const rid = rep.rows[0].id as string;
      const e = await tx.query(
        `INSERT INTO expense (organization_id,report_id,currency_code,merchant,txn_date)
         VALUES ($1,$2,'CAD','Beck',current_date) RETURNING id`, [orgId, rid]);
      await tx.query(
        `INSERT INTO expense_line_item (organization_id,expense_id,category_id,amount_minor,description,gl_account_id)
         VALUES ($1,$2,$3,5000,'taxi',$4)`, [orgId, e.rows[0].id, catId, acctId]);
      await outbox.enqueuePost(tx, rid);
      return rid;
    });
    const q = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    const row = q.find((r) => r.report_id === reportId)!;
    // Refused locally: FAILED (retryable), not a drafted-but-unpostable bill.
    expect(await postOne(orgId, row.id)).toBe('FAILED');
    const after = await withOrg(orgId, (tx) => outbox.listQueue(tx));
    expect(after.find((r) => r.report_id === reportId)!.last_error).toMatch(/99999/);
    // And nothing new reached the sink.
    const received = await (await fetch(`${CONTROL}/bills`)).json();
    expect(received.count).toBe(1);
  });
});
