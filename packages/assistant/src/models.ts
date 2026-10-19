/**
 * Which model does what, and the rule that keeps the split honest.
 *
 * Two models, chosen for opposite reasons. Opus reasons about somebody's money, where being
 * confidently wrong is the failure that matters. Haiku does the mechanical work around the
 * edges — naming a conversation, deciding whether a turn was off-topic — where being wrong
 * is cosmetic and the volume is high.
 *
 * **Haiku never decides what is true about a number.** That is the whole discipline of this
 * arrangement, and it is a rule about which function calls which model, not a hope. Every
 * `fast` call in this package returns a label or a string; none returns an amount, and none
 * chooses which record an answer is about.
 */

/** Reasoning about money. Overridable per deployment. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Mechanical sub-tasks. Never a source of financial truth. */
export const DEFAULT_FAST_MODEL = 'claude-haiku-4-5';

/**
 * How many times one turn may call tools before the loop gives up.
 *
 * A ceiling rather than a preference. Everything else in the product costs what the person
 * asked it to cost; a model that keeps calling tools bills against a limit nobody set. Eight
 * rounds is well past any legitimate chain in this registry — the deepest real path is read a
 * report, read its thread, explain its tax.
 */
export const MAX_TOOL_ROUNDS = 8;

/** Ceiling on a single response. Generous: an explanation with a trace runs long. */
export const MAX_OUTPUT_TOKENS = 4096;

/**
 * How long a proposed mutation stays pressable.
 *
 * An approval is a decision about a moment. Fifteen minutes is long enough to read what is
 * being proposed and short enough that a transcript left open over lunch does not still carry
 * a live press against a report that has since changed.
 */
export const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export interface ModelConfig {
  readonly model: string;
  readonly fastModel: string;
}

/**
 * Resolve the models from the environment.
 *
 * Separate variables rather than one, because the two are chosen for different reasons and
 * a deployment that wants to pin the reasoning model has no business also pinning the one
 * that writes conversation titles.
 */
export function resolveModels(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  return {
    model: env.ASSISTANT_MODEL?.trim() || DEFAULT_MODEL,
    fastModel: env.ASSISTANT_FAST_MODEL?.trim() || DEFAULT_FAST_MODEL,
  };
}

/**
 * Is the assistant configured at all?
 *
 * Deliberately not a throw. The chat is a module that can be installed without anybody having
 * set an API key, and the honest behaviour is to not offer it — a panel that opens and then
 * fails on the first message is worse than a panel that isn't there.
 */
export function assistantConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim());
}
