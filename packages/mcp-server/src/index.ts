/**
 * @expenseos/mcp-server — what ExpenseOS exposes as tools, what scope each one needs, and
 * the MCP protocol that carries them.
 *
 * Execution is injected rather than imported: running a tool means calling a tRPC procedure
 * with the acting person's own context, and that lives in apps/web. Keeping it out means this
 * package has no database, no network and no framework — so the protocol and the scope rules
 * are testable on their own.
 *
 * The in-app assistant and the HTTP endpoint are both consumers. Only one of them speaks
 * HTTP; both use the same registry, the same scope check and the same executor contract.
 */

export {
  availableTools,
  type ExecOutcome,
  type Executor,
  type HandleContext,
  handleRpc,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  jsonSafeReplacer,
  listPage,
  PAGE_SIZE,
  PROTOCOL_VERSION,
  toolContent,
  untrustedEnvelope,
} from './protocol';
export { TOOLS, toolByName } from './tools';
export type {
  CallerCapabilities,
  ToolDefinition,
  ToolKind,
  ToolSpec,
  ToolSurface,
  UnavailableReason,
} from './types';
export {
  forSurface,
  isVisible,
  onSurface,
  toolDefinitionsFor,
  toToolDefinition,
  unavailableReason,
  visibleTools,
} from './visibility';
