import { DomainError } from '@/lib/errors/domain';
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
  /**
   * The calendar day the report is booked on, `'YYYY-MM-DD'`, in the TENANT'S
   * zone (`organization.default_timezone`). Computed once, by the dispatcher.
   *
   * ── WHY AN ADAPTER IS HANDED A DAY AND NOT AN INSTANT ─────────────────────
   *
   * This used to be `approvedAt: Date`, and the VeloLedger adapter turned it into
   * a bill date with `toISOString().slice(0, 10)` — the UTC day. For a tenant in
   * Toronto, anything approved after 20:00 in summer (19:00 in winter) was booked
   * on TOMORROW, and on the last day of a month that is the next accounting
   * period. Nothing fails: the bill drafts, the period resolves, the journal
   * posts, and the month-end close is short by every late approval. A customer
   * finds it, not a test.
   *
   * ExpenseOS shipped the same defect in its NetSuite poster and fixed it as
   * "post the expense report on the approval's Toronto day, not its UTC day".
   * Fixing it per adapter would mean every adapter re-deriving a day from an
   * instant and every one of them getting a chance to do it in UTC. So the
   * contract offers ONLY the day, and an adapter has no instant to get wrong.
   * QuickBooks, Sage and Xero inherit the rule by not being able to break it.
   *
   * The zone is the tenant's configured one, not America/Toronto hard-coded:
   * VeloExpense has tenants outside Ontario, and `0027` explains why the column
   * defaults to `UTC` rather than guessing. A tenant that never set a zone is
   * booked on UTC days, which is what it was before this change.
   */
  postingDate: string;
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
  /**
   * A calendar date, `'YYYY-MM-DD'`. Typed `Date` until now, which was never
   * true at runtime: `lib/db/client.ts` hands `date` columns over as strings
   * (VX4-7 part 1b), so an adapter that called `.toISOString()` on it would have
   * thrown on the first post. No adapter reads it yet; the type is corrected
   * before one does.
   */
  txnDate: string | null;
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
 * How an adapter authenticates. VX3-8.
 *
 *   CONFIG  An admin pastes values into a form. `configFields` describes them,
 *           secret-typed ones are encrypted, and that is the whole flow. This is
 *           what VX3-3 built and what VeloLedger uses (a bearer API key).
 *
 *   OAUTH2  Authorization-code redirect. The admin leaves for the far end,
 *           consents, and returns to a callback carrying a short-lived code. Core
 *           exchanges it for an access token and a refresh token, stores both
 *           encrypted, refreshes on use, and asks for consent again when the
 *           refresh token dies.
 *
 * The SPLIT OF LABOUR is the point of these types. Core owns everything generic
 * and everything security-sensitive: minting and verifying the single-use state,
 * encrypting tokens, deciding when to refresh, distinguishing "needs a human" from
 * "try again later". The adapter owns only what is vendor knowledge — which URL to
 * send the admin to, and how that vendor shapes a token exchange. An adapter
 * cannot get the state handling wrong because it never sees it.
 */
export type AuthKind = 'CONFIG' | 'OAUTH2';

/** What an adapter hands back from an authorisation or a refresh. */
export interface OAuthTokens {
  accessToken: string;
  /**
   * The far end may or may not rotate this. QuickBooks does, and the new value
   * must replace the old one or the connection dies at the next refresh — so
   * `undefined` means "keep what we have" rather than "there is none".
   */
  refreshToken?: string;
  /** Seconds until the access token expires, as the far end reports it. */
  expiresInSeconds?: number;
  /** Seconds until the REFRESH token expires, where the vendor says. */
  refreshExpiresInSeconds?: number;
  /** The far end's id for the account the admin chose — a realm, company, tenant. */
  externalAccountId?: string;
  scope?: string;
}

/**
 * Why a refresh failed, which is the only question core asks about it.
 *
 * Same distinction as `AdapterError.definitelyNotApplied`, and it matters for the
 * same reason: getting it wrong in one direction nags an admin to re-authorise
 * because of a network blip, and in the other leaves a dead connection retrying
 * forever while reports pile up.
 */
export class OAuthConsentRequired extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthConsentRequired';
  }
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

  /**
   * How this adapter authenticates. Absent means `CONFIG`, so every adapter
   * written before VX3-8 keeps working unchanged.
   */
  auth?: AuthKind;

  /**
   * May a tenant connect this adapter in THIS deployment?
   *
   * VX3-8 moved this decision from core to the adapter, and it was a special case
   * in core before: `registry.ts` read
   * `a.slug !== 'stub-ledger' || process.env.INTEGRATIONS_ENABLE_STUB === '1'`.
   * One slug named in a shared file, which is precisely the shape
   * `npm run check:vendor` exists to stop — it only escaped the guard because
   * "stub-ledger" is not a vendor name.
   *
   * Each adapter now answers for itself, which is also what makes QuickBooks
   * dormant-but-ready: it returns false while the platform's client credentials
   * are absent, so it is invisible to every tenant, and it appears the day those
   * two environment variables are set. No migration, no code change, no release.
   *
   * MUST be read at CALL time, never at module load (NT-14): ES imports are
   * hoisted, so a module-load read cannot be varied by a test.
   */
  available?(): boolean;

  /** Always required: an admin must be able to find out if it works. */
  testConnection(config: AdapterConfig): Promise<TestResult>;

  /**
   * Where to send the admin to consent. OAUTH2 adapters only.
   *
   * `state` is minted, hashed and stored by core; the adapter's only job is to put
   * it in the URL the vendor expects. `redirectUri` must be echoed byte-identically
   * to `exchangeCode`, which is why core passes it rather than each side building it.
   */
  authorizeUrl?(input: {
    config: AdapterConfig;
    state: string;
    redirectUri: string;
  }): string;

  /** Trade the callback's code for tokens. OAUTH2 adapters only. */
  exchangeCode?(input: {
    config: AdapterConfig;
    code: string;
    redirectUri: string;
    /** Whatever else the callback carried, so a vendor-specific id can be read. */
    callbackParams: Record<string, string>;
  }): Promise<OAuthTokens>;

  /**
   * Trade a refresh token for a fresh access token. OAUTH2 adapters only.
   *
   * MUST throw `OAuthConsentRequired` when the failure is one only a human can
   * fix — an expired or revoked refresh token — and any other error otherwise.
   * Core sets the re-consent flag on the first and retries the second.
   */
  refreshTokens?(input: {
    config: AdapterConfig;
    refreshToken: string;
  }): Promise<OAuthTokens>;

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
export class AdapterError extends DomainError {
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
