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
 * App-provided resolver: given the org slug (from the pre-redirect cookie) and
 * the verified email from Google/Microsoft, return the existing user or null.
 * INVITE-ONLY CONTRACT: the kit signs in ONLY users this returns; null → the
 * sign-in is denied (the kit never provisions accounts from SSO).
 */
export type ResolveSsoUser = (orgSlug: string, email: string) => Promise<ResolvedUser | null>;

/** Called on every denied SSO attempt so the app can audit it. */
export type OnSsoDenied = (orgSlug: string, email: string, provider: string) => Promise<void>;

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
