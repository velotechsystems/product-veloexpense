/**
 * @expenseos/assistant — the in-app Help Center's own concerns.
 *
 * The tool registry, the scope rules and the protocol live in @expenseos/mcp-server, which
 * both this and the HTTP endpoint consume. What is left here is what only the in-app chat
 * has: the registry-derived help catalog, and the confirmation gate a human presses in
 * ExpenseOS (an MCP client confirms in its own UI instead).
 *
 * See docs/design/help-center-assistant.md.
 */

export {
  type AttachedFile,
  type AttachmentRejection,
  attachmentNotice,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  RECEIPT_ACCEPT,
  RECEIPT_CONTENT_TYPES,
  rejectAttachment,
} from './attachments';
export {
  ASSISTANT_MODULE_SLUG,
  type AvailableCapability,
  activeModuleSummary,
  type CapabilityCatalog,
  capabilityCatalog,
  explainUnavailable,
  helpContext,
  type Locale,
  type LocalizedText,
  type ModuleFact,
  suggestedCapabilities,
  type UnavailableCapability,
} from './catalog';
export {
  type ConfirmationEnvelope,
  type ConfirmationRejection,
  confirmationEnvelope,
  hashToolInput,
  type PendingAction,
  rejectConfirmation,
  requiresConfirmation,
  stableStringify,
} from './confirm';
export { hasLiveProposal, toApiMessages } from './history';
export {
  type Extract,
  extractFromArticle,
  extractFromArticles,
  type FastClient as ExtractClient,
} from './knowledge/extract';
export { collectGuidance } from './knowledge/guidance';
export {
  articleBySlug,
  buildIndex,
  type SearchOptions,
  searchArticles,
  searchIndexed,
  tokenize,
} from './knowledge/search';
export type { Article, ArticleHit } from './knowledge/types';
export {
  assistantConfigured,
  CONFIRMATION_TTL_MS,
  DEFAULT_FAST_MODEL,
  DEFAULT_MODEL,
  MAX_OUTPUT_TOKENS,
  MAX_TOOL_ROUNDS,
  type ModelConfig,
  resolveModels,
} from './models';
export {
  type ConfirmationMarker,
  confirmationBlock,
  type PendingConfirmation,
  pendingConfirmation,
  readMarker,
  rejectPress,
  type StoredMessage,
  settleMarker,
} from './pending';
export {
  buildSystemPrompt,
  type PromptInput,
  type ScreenContext,
  type SystemBlock,
} from './prompt';
export {
  checkGrounding,
  type FastClient,
  proposeTitle,
  reviewTurn,
  type TurnFlag,
} from './review';
export {
  type AssistantClient,
  runTurn,
  type StopReason,
  type StreamedMessage,
  type TurnEvent,
  type TurnInput,
} from './turn';
