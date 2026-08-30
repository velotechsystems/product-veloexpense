/**
 * VX3-3 — the accounting-adapter contract.
 *
 * PURE. No `pg`, no `next`, no vendor SDK. An adapter implementation may import
 * whatever it needs; this file is what core is allowed to know.
 *
 * ── This is the one file in the port that is DESIGNED rather than ported ─────
 *
 * GAP-AUDIT AC-1: there is nothing to port. ExpenseOS's `IntegrationDescriptor`
 * is pure declarative metadata — every field is a slug, a localized string, a
 * string array or a JSON schema, with no function members and no module handle —
 * and NetSuite is reached from generic code three ways, all vendor-specific:
 * direct imports of `@expenseos/integrations-netsuite` from four routers and four
 * workers, a hardcoded `switch (input.slug)` whose default returns
 * "No Test Connection implementation for integration '<slug>'", and five
 * vendor-named job types. With one accounting system that is cheaper than an
 * abstraction. With four it is what the Plan's risk register warns against:
 *
 *   "define the accounting-adapter contract once (VeloLedger) so
 *    QuickBooks/Xero/Sage are repeatable; avoid per-vendor special cases leaking
 *    into core."
 *
 * ── Resolution is by CAPABILITY, not by vendor ───────────────────────────────
 *
 * AC-5 is the reason this matters. ExpenseOS declares a closed `CAPABILITIES`
 * union, asserts it at boot, and stores it on every integration row — and a grep
 * for any of those seven strings outside the registry returns ZERO hits. Real
 * gating is `requiresIntegrations: ['netsuite']`, a vendor name. So the taxonomy
 * reads as an identity from outside and is decided by something else in fact,
 * which is exactly the shape NT-4 recorded for notification templates.
 *
 * Here, core asks "who can post an expense report for this tenant" and never
 * "is this tenant on QuickBooks". That is the property that makes the Plan's exit
 * criterion — VeloLedger in one tenant, QuickBooks in a second — reachable without
 * a branch in core, and VX3-8's diff is the test of whether it held.
 */

/** What an adapter can do. Core asks for one of these, never for a vendor. */
export const CAPABILITIES = [
  'POST_EXPENSE_REPORT',
  'PULL_CHART_OF_ACCOUNTS',
  'READ_PAYMENT_STATUS',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/**
 * One configuration field an adapter needs from a tenant.
 *
 * `secret: true` is the single source of truth for sensitivity — it drives
 * redaction on read, blank-means-unchanged on write, and encryption at rest.
 * ExpenseOS derives the same fact from `'ui:widget': 'password'` in a UI schema,
 * which works and puts a security property in a presentation file; a boolean on
 * the field says it once.
 */
export interface ConfigField {
  name: string;
  label: string;
  type: 'text' | 'url' | 'secret';
  required: boolean;
  help?: string;
  placeholder?: string;
}

export function isSecretField(field: ConfigField): boolean {
  return field.type === 'secret';
}

/** A tenant's stored configuration, secrets already DECRYPTED. */
export type AdapterConfig = Record<string, string>;

export interface TestResult {
  ok: boolean;
  /** Shown to an admin verbatim, so it has to be a sentence rather than a code. */
  detail: string;
}

/** What an adapter is handed to post. Vendor-neutral by construction. */
export interface PostableReport {
  reportId: string;
  /** The human-facing number, e.g. 'EXP-000123'. */
  number: string | null;
  title: string;
  submitterName: string;
  submitterEmail: string;
  currencyCode: string;
  totalMinor: string;
  approvedAt: Date | null;
  lines: PostableLine[];
}

export interface PostableLine {
  lineItemId: string;
  description: string | null;
  categoryCode: string;
  categoryLabel: string;
  /** The SNAPSHOT from VX3-1, not the category's current account (AC-10). */
  glAccountNumber: string | null;
  glAccountName: string | null;
  amountMinor: string;
  taxMinor: string;
  txnDate: Date | null;
  merchant: string | null;
}

export interface PostResult {
  /** The id the ledger assigned. Stored so a duplicate can be recognised. */
  externalId: string;
  /** Anything worth showing an operator — a document number, a URL. */
  detail?: string;
}

/** One account as the ledger reports it, in `gl_account`'s shape (VX3-1). */
export interface RemoteAccount {
  externalId: string;
  number: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subType?: string | null;
  parentNumber?: string | null;
  active: boolean;
}

/**
 * An accounting adapter.
 *
 * Every capability method is OPTIONAL and must be present exactly when the
 * adapter declares the matching capability — `registry.ts` asserts that pairing
 * at module load, so a declared-but-unimplemented capability is a startup failure
 * rather than a `TypeError` on a tenant's posting attempt.
 */
export interface AccountingAdapter {
  /** Stable, kebab-case. Matches `integration_installation.integration_slug`. */
  slug: string;
  name: string;
  /** One sentence, shown on the connect screen. */
  description: string;
  capabilities: readonly Capability[];
  configFields: readonly ConfigField[];
  /** What to do in the other system first. Rendered on the connect screen. */
  setupSteps?: readonly string[];

  /** Always required: an admin must be able to find out if it works. */
  testConnection(config: AdapterConfig): Promise<TestResult>;

  postExpenseReport?(config: AdapterConfig, report: PostableReport): Promise<PostResult>;
  pullChartOfAccounts?(config: AdapterConfig): Promise<RemoteAccount[]>;
  readPaymentStatus?(config: AdapterConfig, externalId: string): Promise<'PAID' | 'UNPAID'>;
}

/**
 * The error an adapter throws, and the one thing core needs to know about it.
 *
 * ── Why this is on the CONTRACT and not in an adapter (VX3-7) ────────────────
 *
 * It was in an adapter, and that was a defect rather than an untidiness. The
 * generic drain in `lib/integrations/dispatch.ts` imported
 * `isDefinitelyNotApplied` from `lib/integrations/veloledger.ts` — so the ONLY
 * adapter that could say "this call was refused, nothing happened upstream" was
 * VeloLedger. Every other adapter's failure fell through to the ambiguous branch,
 * and `NEEDS_REVIEW` is deliberately a state no automatic path will retry (AC-8).
 *
 * The consequence, for a tenant nobody has yet: a QuickBooks connection with a
 * mistyped credential returns 401 on every report, each one lands in
 * NEEDS_REVIEW, and a human has to clear each by hand — for a failure that
 * definitely never reached QuickBooks and should simply have backed off and
 * retried. VX3-3's acceptance criterion says adding an adapter touches no shared
 * file; it would have had to touch this one.
 *
 * So: an adapter throws `AdapterError` and says which kind of failure it was.
 *
 *   definitelyNotApplied = true   The far end refused BEFORE doing anything —
 *                                 401/403/404/422, a bad configuration, a
 *                                 validation rejection. Safe to retry.
 *   definitelyNotApplied = false  It might have applied — a timeout, a 5xx, a
 *                                 dropped connection. NOT safe to retry.
 *
 * The DEFAULT IS THE DANGEROUS CASE: anything that is not an `AdapterError`
 * classifies as ambiguous. An adapter wrapping a vendor SDK it does not control
 * must therefore catch that SDK's errors and re-throw them as `AdapterError`,
 * and forgetting to costs a human a click rather than costing a company a
 * duplicated bill.
 */
export class AdapterError extends Error {
  constructor(
    message: string,
    /** True when the call certainly did NOT reach the far end's handler. */
    readonly definitelyNotApplied: boolean,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Did this failure certainly not apply upstream?
 *
 * Core's only question about an adapter's error. Fail-safe by construction: an
 * error of any other kind answers `false`, which routes to NEEDS_REVIEW.
 */
export function isDefinitelyNotApplied(err: unknown): boolean {
  return err instanceof AdapterError && err.definitelyNotApplied;
}

/** The method each capability promises. Used by the registry's pairing check. */
export const CAPABILITY_METHOD: Record<Capability, keyof AccountingAdapter> = {
  POST_EXPENSE_REPORT: 'postExpenseReport',
  PULL_CHART_OF_ACCOUNTS: 'pullChartOfAccounts',
  READ_PAYMENT_STATUS: 'readPaymentStatus',
};
