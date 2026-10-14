/**
 * @velotech/auth-kit — shared types.
 *
 * The kit standardizes the session claim shape across every VeloTech app so
 * downstream code (API gates, audit actors) is identical regardless of product:
 * { orgId, role, subjectId }. `role` stays a product-defined string (each app
 * keeps its own role vocabulary); `subjectId` is the product's person link
 * (employeeId in VeloPulse, contactId in VeloCRM, null where N/A).
 */

export interface VelotechClaims {
  orgId: string;
  role: string;
  /** Product-specific person link (VeloPulse: employeeId). Null when unlinked. */
  subjectId: string | null;
}

/** What the kit needs back from the app when an SSO callback lands. */
export interface ResolvedUser extends VelotechClaims {
  userId: string;
  email: string;
}

/**
 * SSOTENANT-1: what the kit hands the app about a completed SSO round trip.
 *
 * Email alone is not an identity for Microsoft. In a multi-tenant Entra app the
 * `email` claim is set by whoever administers the signing-in user's directory
 * and Microsoft does not verify it, so anyone can create a directory, give a
 * user someone else's address and arrive here with it ("nOAuth"). The app must
 * bind Microsoft sign-ins to the organization's own directory (tenantId) and to
 * the person's permanent object id, never to the email.
 */
export interface SsoIdentity {
  /** 'google' | 'microsoft-entra-id' (the kit's provider ids). */
  provider: string;
  /** Lower-cased. Microsoft: `email`, else `preferred_username` (the UPN). */
  email: string;
  /** Google's `email_verified`. Null for providers that do not send it. */
  emailVerified: boolean | null;
  /** Microsoft only: the directory (`tid`) the token was issued for. */
  tenantId: string | null;
  /** Microsoft only: the user's permanent object id (`oid`) in that directory. */
  objectId: string | null;
}

/** Every reason an SSO sign-in is refused. Written to the audit trail as-is. */
export type SsoDenyReason =
  | 'unknown_org'
  | 'unknown_user'
  | 'account_disabled'
  | 'org_cookie_missing'
  | 'no_email'
  | 'email_unverified'
  | 'entra_claims_missing'
  | 'entra_not_configured'
  | 'entra_tenant_mismatch'
  | 'entra_subject_mismatch';

export interface SsoDenied {
  denied: SsoDenyReason;
  /** The app's user concerned, when the denial is about a known account. */
  userId?: string;
}

/**
 * App-provided resolver: given the org slug (from the pre-redirect cookie) and
 * the provider's identity, return the existing user or a denial.
 * INVITE-ONLY CONTRACT: the kit signs in ONLY users this returns; a denial →
 * the sign-in is refused (the kit never provisions accounts from SSO).
 *
 * v0.3 (BREAKING): was (orgSlug, email) → ResolvedUser | null.
 */
export type ResolveSsoUser = (orgSlug: string, identity: SsoIdentity) => Promise<ResolvedUser | SsoDenied>;

/**
 * Called on every refused SSO attempt so the app can audit it. Carries an
 * email only when the provider verified it (`verifiedEmail`, Google today):
 * a Microsoft `email` claim is text the signing-in user's directory chose,
 * and writing it into an audit log as "who tried" would let anyone put any
 * address there.
 */
export interface SsoDeniedEvent {
  /** Null when the org-slug cookie was missing or expired. */
  orgSlug: string | null;
  provider: string;
  reason: SsoDenyReason;
  userId?: string;
  /**
   * Present only on a refusal by your resolver, and only when the provider
   * verified the address (SsoIdentity.emailVerified === true). Lower-cased.
   * Apps that do not record attempted addresses can ignore it.
   */
  verifiedEmail?: string;
}
/** v0.3 (BREAKING): was (orgSlug, email, provider). */
export type OnSsoDenied = (event: SsoDeniedEvent) => Promise<void>;

export interface AuthKitProviderFlags {
  google: boolean;
  microsoft: boolean;
}

export interface AuthKitOptions {
  /** e.g. 'velopulse' — namespaces the org-slug cookie per product. */
  productKey: string;
  providers: AuthKitProviderFlags;
  resolveSsoUser: ResolveSsoUser;
  onSsoDenied?: OnSsoDenied;
  /**
   * v0.3 — FAIL CLOSED for Microsoft. Set to `true` only when your
   * resolveSsoUser binds a Microsoft sign-in to the organization's own Entra
   * directory (`identity.tenantId`) and to the person's permanent object id
   * (`identity.objectId`), and uses the email at most once, to link a known
   * account. See SsoIdentity for why the email alone is not an identity.
   *
   * Without it the kit registers no Microsoft provider, even when
   * `providers.microsoft` is true (the Entra app is shared suite-wide, so its
   * env vars can be present in a product that has not built the binding), and
   * refuses any Microsoft callback with reason 'entra_not_configured'.
   */
  microsoftDirectoryBinding?: boolean;
  /**
   * Env names are standardized suite-wide (one Google client + one Entra app
   * for all products): AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET and
   * AUTH_MICROSOFT_ENTRA_ID_ID / AUTH_MICROSOFT_ENTRA_ID_SECRET /
   * AUTH_MICROSOFT_ENTRA_ID_ISSUER — read by next-auth automatically.
   */
}

/** Branding props for the shared split-screen login (per captured designs). */
export interface LoginBranding {
  /** Two-letter chip, e.g. 'VP' | 'VL' | 'VC'. */
  monogram: string;
  productName: string;
  headline: string;
  subtitle: string;
  bullets: string[];
  /** 'gradient' = VeloLedger blue gradient; 'navy' = VeloCRM solid dark. */
  panelStyle: 'gradient' | 'navy';
  footer: string;
}
