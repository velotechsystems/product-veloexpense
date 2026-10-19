/**
 * Which tools this caller is offered, and what they look like on the wire.
 *
 * **This is not the security boundary.** The boundary is the tRPC procedure, which
 * re-checks its own permission on every call regardless of what was offered. What this
 * file buys is a tool list the model can choose well from: an employee is not told that
 * `set_virtual_card_status` exists, so it cannot propose freezing a card and then explain
 * a 403 to somebody who was never going to be allowed.
 *
 * Both checks matter, for different reasons. Removing this one produces a chatty
 * assistant that proposes impossible actions; removing the procedure's one produces a
 * privilege escalation. They are not duplicates of each other.
 */

import { z } from 'zod';
import type {
  CallerCapabilities,
  ToolDefinition,
  ToolSpec,
  ToolSurface,
  UnavailableReason,
} from './types';

/**
 * Why this caller cannot use this tool, or `null` if they can.
 *
 * Permission is checked before module, so the answer names the thing the caller can
 * actually act on: "you'd need `budget.read`" is useful to an admin who can grant it,
 * where "the module is off" sends them to the wrong page.
 */
export function unavailableReason(
  spec: ToolSpec,
  caps: CallerCapabilities,
): UnavailableReason | null {
  if (spec.permission && !caps.permissions.includes(spec.permission)) {
    return { kind: 'permission', permission: spec.permission };
  }
  if (spec.moduleSlug && !caps.activeModules.includes(spec.moduleSlug)) {
    return { kind: 'module', moduleSlug: spec.moduleSlug };
  }
  return null;
}

/** Can this caller use this tool at all? */
export function isVisible(spec: ToolSpec, caps: CallerCapabilities): boolean {
  return unavailableReason(spec, caps) === null;
}

/**
 * Is this tool offered on this surface?
 *
 * Kept out of `unavailableReason` on purpose: that function answers "why can't THIS PERSON
 * use this tool", and the answer is shown to them. The surface is not a fact about the
 * person and there is nothing useful to tell them about it — a tool that isn't on their
 * surface simply isn't in the list.
 */
export function onSurface(spec: ToolSpec, surface: ToolSurface): boolean {
  return spec.surfaces === undefined || spec.surfaces.includes(surface);
}

/** The registry entries declared for one surface, in registry order. */
export function forSurface(specs: readonly ToolSpec[], surface: ToolSurface): readonly ToolSpec[] {
  return specs.filter((spec) => onSurface(spec, surface));
}

/** The tools to offer this caller on this surface, in registry order. */
export function visibleTools(
  specs: readonly ToolSpec[],
  caps: CallerCapabilities,
  surface: ToolSurface,
): readonly ToolSpec[] {
  return specs.filter((spec) => onSurface(spec, surface) && isVisible(spec, caps));
}

/**
 * A tool in the shape the Claude API and MCP both want.
 *
 * The JSON Schema comes from the same Zod schema that validates the call, so the contract
 * the model is shown and the contract enforced are one object. Zod 4 emits JSON Schema
 * natively — no converter dependency, and no second description of the same shape.
 */
export function toToolDefinition(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: z.toJSONSchema(spec.input) as Record<string, unknown>,
  };
}

/** The whole tool list for a caller, ready to hand to the model. */
export function toolDefinitionsFor(
  specs: readonly ToolSpec[],
  caps: CallerCapabilities,
  surface: ToolSurface,
): readonly ToolDefinition[] {
  return visibleTools(specs, caps, surface).map(toToolDefinition);
}
