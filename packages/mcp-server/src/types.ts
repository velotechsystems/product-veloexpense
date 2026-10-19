/**
 * The shapes the assistant's tool layer is built from.
 *
 * Deliberately free of any dependency on apps/web: this package declares WHAT a tool is,
 * WHAT SCOPE it needs, and WHO may see it — and knows nothing about how one is executed.
 * Execution is injected, because it needs the tRPC caller that lives in apps/web, and
 * routing every tool call through the real procedure is the whole security model.
 */

import type { Access, ScopeResource } from '@expenseos/api-scopes';
import type { ZodType } from 'zod';

/**
 * Does calling this tool change anything?
 *
 * The distinction is not cosmetic — it decides whether a call executes or returns a
 * confirmation for a human to press. A `read` the caller is already entitled to is not an
 * event; a `mutate` moves somebody's money.
 */
export type ToolKind = 'read' | 'mutate';

/**
 * Where a tool is offered.
 *
 * Not a security property — the scope and the procedure's own permission decide what a call
 * may do on either surface. It exists because a tool can be *useless* on one of them: filing
 * an uploaded receipt needs whoever holds the bytes to have PUT them first, which the panel
 * does over tRPC straight after the press and an MCP client must be told to do itself.
 */
export type ToolSurface = 'chat' | 'mcp';

/** One tool the assistant may offer, and the tRPC procedure behind it. */
export interface ToolSpec {
  /** Verb-first and stable — this is a wire contract with every connected client. */
  readonly name: string;
  /**
   * Written for the model, and prescriptive about WHEN to call it rather than only what
   * it does. A description that says "gets a report" is a description the model has to
   * guess with; one that says "call this when the person refers to a specific report"
   * is one it can act on.
   */
  readonly description: string;
  /** Validates the call, and is also the source of the MCP `inputSchema`. */
  readonly input: ZodType;
  /** Dot path into `appRouter`, e.g. `expenses.submit`. */
  readonly path: string;
  readonly kind: ToolKind;
  /**
   * The API scope a key must hold to call this, and whether read access is enough.
   *
   * On the tool rather than in a side table: a tool whose scope lives somewhere else is a
   * tool somebody adds without one, and the failure mode is silent — an operation reachable
   * by any key that got through the door. A test asserts every entry declares both.
   *
   * `access` is not the same question as `kind`. `kind` decides whether a HUMAN is asked to
   * confirm; `access` decides whether a `.readonly` scope suffices. They agree today and
   * are kept separate because they answer to different audiences.
   */
  readonly scope: ScopeResource;
  readonly access: Access;
  /**
   * The permission the underlying procedure requires, when it declares one.
   *
   * **Advisory.** It is used to keep tools the caller cannot use out of the tool list,
   * and never to decide whether a call is allowed — the procedure's own `withPermission`
   * does that, on every call, unchanged. Two checks with two purposes: this one saves
   * tokens and stops the model proposing actions that will fail, that one is the security
   * boundary. Deleting either as "redundant" is a mistake; they are not the same check.
   *
   * Absent where the procedure is a bare `protectedProcedure` whose access is decided
   * per-record inside the resolver (`canViewReport` and friends).
   */
  readonly permission?: string;
  /** Module slug the procedure is gated on, where it is gated on one. */
  readonly moduleSlug?: string;
  /**
   * The surfaces this tool is offered on. Omitted means both, which is what almost every
   * tool wants — a read is a read wherever it is called from.
   *
   * Set it only where a tool's contract cannot be fulfilled on a surface. The listing
   * functions take the surface as a REQUIRED argument for that reason: a call site that
   * forgot to say which surface it was would silently offer the chat model a tool meant for
   * an MCP client, and the failure would look like the model hallucinating a tool name.
   */
  readonly surfaces?: readonly ToolSurface[];
}

/**
 * What the calling human can do — the input to tool visibility.
 *
 * Both fields come from state the app already resolves per request: `permissions` from
 * the Redis-cached role lookup, `activeModules` from the platform installation table.
 */
export interface CallerCapabilities {
  readonly permissions: readonly string[];
  readonly activeModules: readonly string[];
}

/** A tool as handed to the Claude API / an MCP client. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

/** Why a tool is not available to this caller. */
export type UnavailableReason =
  | { readonly kind: 'permission'; readonly permission: string }
  | { readonly kind: 'module'; readonly moduleSlug: string };
