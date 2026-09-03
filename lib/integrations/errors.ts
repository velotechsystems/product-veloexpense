import { DomainError } from '@/lib/errors/domain';
/**
 * VX3-9a — `IntegrationError`, extracted from `service.ts`.
 *
 * It moved for one reason: `lib/integrations/oauth.ts` needs to throw it, and
 * `service.ts` needs to CALL oauth.ts. With the class in `service.ts` that is a
 * cycle, and ESM's handling of cycles is the kind of thing that works until a
 * bundler reorders something. A leaf module both can import costs nothing.
 *
 * `service.ts` re-exports it, so every existing
 * `import { IntegrationError } from '@/lib/integrations/service'` keeps working.
 */

export class IntegrationError extends DomainError {
  constructor(
    message: string,
    /**
     * A CLOSED union on purpose — the callers switch on it, so an invented code
     * would silently fall through to a generic branch. VX3-8 added the last three
     * and the compiler is what insisted; `npm test` cannot see this, because
     * vitest transpiles without type checking.
     */
    readonly code:
      | 'NOT_FOUND'
      | 'UNKNOWN_ADAPTER'
      | 'MISSING_FIELD'
      | 'DUPLICATE_CODE'
      | 'ALREADY_ACTIVE'
      | 'NO_CAPABILITY'
      | 'NOT_CONNECTED'
      // VX3-8, the OAuth flow:
      /** An authorisation was started on an adapter that takes pasted values. */
      | 'NOT_OAUTH'
      /** The callback's state is unknown, already used, or expired — one code for
       *  all three, matching the single message the caller is allowed to show. */
      | 'STATE_INVALID'
      /** Only a human can fix this: the refresh token is expired or revoked. */
      | 'NEEDS_CONSENT'
      // VX3-9b / AC-22:
      /**
       * Two ACTIVE installations claim the same capability, so there is no single
       * right answer to "who posts for this tenant". Deliberately NOT resolved by
       * picking one — see `resolveCapability`.
       */
      | 'AMBIGUOUS_CAPABILITY',
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}
