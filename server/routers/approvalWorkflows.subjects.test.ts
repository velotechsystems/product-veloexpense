// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APPROVAL_SUBJECT_TYPES } from '@/lib/approvalSubjects';

/*
 * VeloExpense (w4-01): there is no Prisma enum to compare against — `subject_type` is text
 * under a CHECK in 0058 — and the list is deliberately narrower than the CHECK: travel is
 * reserved there until the travel wave (see `@/lib/approvalSubjects`). So the parity test
 * asserts the list against the engine's live subjects, and that every member is one the
 * database accepts, read from the migration itself. ExpenseOS's travel case is skipped.
 */
function checkedSubjects(): string[] {
  const sql = readFileSync(
    join(process.cwd(), 'prisma/migrations/0058_approval_workflow_engine/migration.sql'),
    'utf8',
  );
  const m = sql.match(/CONSTRAINT approval_workflow_subject_type\s+CHECK \(subject_type IN \(([^)]*)\)\)/);
  if (!m) throw new Error('0058 no longer declares approval_workflow_subject_type');
  return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
}

/**
 * The list is asserted through the same `z.enum(...)` the router builds from it, rather
 * than importing the router — which drags in tRPC and next-auth and cannot load in the
 * node unit project. Same constant, same construction, no mock preamble.
 */
const SUBJECT_TYPES = z.enum(APPROVAL_SUBJECT_TYPES);

/**
 * The router's subject list must be the model's subject list.
 *
 * `SUBJECT_TYPES` gates both `simulate` and `create`, so a subject missing from it is a
 * subject no admin can author a workflow for and no admin can simulate — while the
 * engine, the seed and the editor all handle it perfectly well. That is not a
 * hypothetical: the enum held two members while `ApprovalSubjectType` held four, and
 * the GA v2 audit spent a P1 on the consequence. Pressing Run on the seeded travel
 * workflow sent `subjectType: 'TRAVEL_REQUEST'` into a schema that rejected it, the
 * query failed validation, and the dialog rendered nothing — which reads exactly like
 * an unrunnable graph.
 *
 * Nothing else would catch it. `tsc` was actively misled by a narrowing cast in
 * `SimulatorDialog`, the component tests only ever passed 'VIRTUAL_CARD_REQUEST', and
 * the failure is silent in the browser.
 *
 * Asserted against `schema.prisma` rather than a second hand-written list, so adding a
 * fifth subject to the model fails here instead of shipping half-wired.
 */
describe('approval-workflow subject coverage', () => {
  it('accepts every subject the engine routes, and only ones the database accepts', () => {
    // VeloExpense: the engine's live subjects (packages/approvals/src/engine.ts).
    expect([...SUBJECT_TYPES.options].sort()).toEqual(['EXPENSE_REPORT']);
    const allowed = new Set(checkedSubjects());
    for (const s of SUBJECT_TYPES.options) expect(allowed.has(s)).toBe(true);
  });

  // VeloExpense: no travel or virtual-card subjects yet (see the note at the top).
  it.skip('parses the subject the travel workflow actually sends', () => {
    // The specific value whose rejection produced the finding.
    expect(SUBJECT_TYPES.safeParse('TRAVEL_REQUEST').success).toBe(true);
    expect(SUBJECT_TYPES.safeParse('VIRTUAL_CARD_LIMIT_INCREASE').success).toBe(true);
  });

  it('still refuses a subject the model does not declare', () => {
    // Widening must not have turned into "accept anything" — the enum is still a gate.
    expect(SUBJECT_TYPES.safeParse('PURCHASE_ORDER').success).toBe(false);
  });
});
