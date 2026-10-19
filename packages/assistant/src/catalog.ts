/**
 * Help answers, derived from the registries rather than from a written corpus.
 *
 * "What can I do here?", "why can't I see Budgets?", "what does an AP Clerk get?" are all
 * answerable from things that already exist and already cannot drift: the typed permission
 * registry, the caller's resolved permission set, the platform module descriptors, and the
 * tool registry itself.
 *
 * The alternative — a hand-written help corpus — gives richer prose and starts rotting the
 * day it merges, because nothing fails when the product changes underneath it. What is
 * here can only ever say what the product currently does. Where that is genuinely too thin
 * (multi-step workflows like month-end close), the honest answer is a written guide, and
 * that is deferred rather than faked.
 *
 * Module facts are passed IN rather than imported, so this package needs no dependency on
 * @expenseos/platform (and therefore none on the database). The caller already has them.
 */

import type {
  CallerCapabilities,
  ToolKind,
  ToolSpec,
  UnavailableReason,
} from '@expenseos/mcp-server';
import { unavailableReason } from '@expenseos/mcp-server';

/**
 * The platform module the chat is gated on.
 *
 * Here rather than beside the HTTP handler so a router and a client component can both name
 * it without dragging the executor — and the tRPC caller it imports — into their bundle.
 */
export const ASSISTANT_MODULE_SLUG = 'assistant';

/** The locales the product ships. Help is bilingual for the same reason the UI is. */
export type Locale = 'en' | 'fr-CA';

/** Locale-keyed display string, matching `LocalizedText` in @expenseos/platform. */
export interface LocalizedText {
  readonly en: string;
  readonly 'fr-CA': string;
}

/** What the catalog needs to know about a module — a subset of `ModuleDescriptor`. */
export interface ModuleFact {
  readonly slug: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly active: boolean;
}

export interface AvailableCapability {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  /** True when using it will ask the person to confirm first. */
  readonly confirms: boolean;
}

export interface UnavailableCapability {
  readonly name: string;
  readonly reason: UnavailableReason;
}

export interface CapabilityCatalog {
  readonly available: readonly AvailableCapability[];
  readonly unavailable: readonly UnavailableCapability[];
}

/**
 * Everything this caller can and cannot ask for.
 *
 * The unavailable half is deliberate. Answering "you can't do that" is unhelpful; "you
 * can't do that because it needs `budget.read`, which your role doesn't carry" tells
 * somebody what to ask their admin for — and tells the admin exactly what to grant.
 */
export function capabilityCatalog(
  specs: readonly ToolSpec[],
  caps: CallerCapabilities,
): CapabilityCatalog {
  const available: AvailableCapability[] = [];
  const unavailable: UnavailableCapability[] = [];

  for (const spec of specs) {
    const reason = unavailableReason(spec, caps);
    if (reason) {
      unavailable.push({ name: spec.name, reason });
    } else {
      available.push({
        name: spec.name,
        description: spec.description,
        kind: spec.kind,
        confirms: spec.kind === 'mutate',
      });
    }
  }
  return { available, unavailable };
}

/**
 * A sentence explaining why something is out of reach.
 *
 * A missing module and a missing permission look identical from the outside — the feature
 * simply is not there — and send the person to completely different places. One is an
 * admin granting a permission; the other is an admin installing a module.
 */
export function explainUnavailable(
  reason: UnavailableReason,
  modules: readonly ModuleFact[],
  locale: Locale = 'en',
): string {
  if (reason.kind === 'permission') {
    return locale === 'fr-CA'
      ? `Cette action requiert la permission « ${reason.permission} », que votre rôle ne possède pas. Un administrateur peut l'ajouter dans Rôles.`
      : `That needs the "${reason.permission}" permission, which your role doesn't carry. An administrator can add it under Roles.`;
  }
  const mod = modules.find((m) => m.slug === reason.moduleSlug);
  const label = mod ? mod.name[locale] : reason.moduleSlug;
  return locale === 'fr-CA'
    ? `Le module « ${label} » n'est pas activé pour cette organisation. Un administrateur peut l'installer dans Paramètres de la plateforme.`
    : `The "${label}" module isn't active for this organisation. An administrator can install it under Platform Settings.`;
}

/**
 * The module part of "what is this product?", limited to what is actually switched on.
 *
 * An inactive module is not described as available — the fastest way to make a help
 * system untrustworthy is to have it explain a page that isn't there.
 */
export function activeModuleSummary(modules: readonly ModuleFact[], locale: Locale = 'en'): string {
  const active = modules.filter((m) => m.active);
  if (active.length === 0) return '';
  return active.map((m) => `- ${m.name[locale]}: ${m.description[locale]}`).join('\n');
}

/**
 * The grounding block for the assistant's system prompt.
 *
 * Stable per caller, which is what makes it worth caching: it changes when somebody's role
 * or the installed modules change, not per turn.
 */
export function helpContext(
  specs: readonly ToolSpec[],
  caps: CallerCapabilities,
  modules: readonly ModuleFact[],
  locale: Locale = 'en',
): string {
  const { unavailable } = capabilityCatalog(specs, caps);
  const parts: string[] = [];

  const mods = activeModuleSummary(modules, locale);
  if (mods) parts.push(`Modules active for this organisation:\n${mods}`);

  if (unavailable.length > 0) {
    const lines = unavailable.map(
      (u) => `- ${u.name}: ${explainUnavailable(u.reason, modules, locale)}`,
    );
    parts.push(
      'Actions this person CANNOT take. Do not offer them; if asked, explain why using ' +
        `the reason given:\n${lines.join('\n')}`,
    );
  }
  return parts.join('\n\n');
}

/**
 * Openers to offer somebody staring at an empty panel.
 *
 * Derived from the tools this caller can actually use, so it cannot promise something their
 * role forbids and cannot drift as the registry changes. An assistant that will not say what
 * it is for gets tried once — and a suggestion that comes back refused reads as the product
 * being broken rather than as a permission they lack.
 *
 * The preference order is editorial: what most people want first, filtered against what this
 * person has rather than assumed. Anything not on the list is still reachable by asking.
 */
const SUGGESTION_ORDER = [
  'list_my_expense_reports',
  'list_my_approval_tasks',
  'explain_expense_tax',
  'list_budgets',
  'list_my_travel_requests',
  'list_virtual_cards',
];

export function suggestedCapabilities(
  specs: readonly ToolSpec[],
  caps: CallerCapabilities,
  limit = 4,
): string[] {
  const available = new Set(capabilityCatalog(specs, caps).available.map((c) => c.name));
  return SUGGESTION_ORDER.filter((name) => available.has(name)).slice(0, limit);
}
