/**
 * Client-safe catalog of workflow Action-node integration hooks. Just metadata
 * (id + label) for the editor's hook picker — the server-side handlers live in
 * `server/lib/workflowEffects`. Keep this free of server imports so the React
 * Flow editor can import it.
 *
 * v1 ships one hook (an audited "action fired" entry); real integrations (e.g.
 * NetSuite post-on-approval) register here + in the server registry as they land.
 */
export const ACTION_HOOKS = [{ value: 'audit.log', label: 'Record an audit entry' }] as const;

export type ActionHookName = (typeof ACTION_HOOKS)[number]['value'];
