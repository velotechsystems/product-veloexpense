/**
 * Who performed the action. `system` covers background jobs and any
 * server-initiated action that has no human actor (e.g., the session
 * guard observing an idle expiration). User actors carry the role
 * LABEL at the moment of action — a stable, locale-resolved snapshot
 * that survives later role rename or deletion (the role's identifier
 * `id` is also retained on the User row but a fresh label snapshot
 * keeps audit log entries human-readable).
 */
export type AuditActor =
  | { kind: 'user'; id: string; name: string; roleLabel: string }
  | { kind: 'system'; jobName: string };

/**
 * Input accepted by writeAudit / withAudit. Mirrors the persisted
 * Audit row minus chain-managed fields (id, prevHash, entryHash,
 * expiresAt, occurredAt) which the writer mints itself.
 */
export type AuditInput = {
  /** Pick from the @expenseos/audit auditActions registry. */
  action: string;
  entityType?: string;
  entityId?: string;
  actor: AuditActor;
  details?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
  /** Operational tracing id. Stored but NOT part of the hash payload. */
  requestId?: string;
};

/** Persisted shape of the actor on the Audit row. */
export type ResolvedActor = {
  actorId: string | null;
  /** Snapshotted Role.label at action time; null for system actors. */
  actorRoleLabel: string | null;
  actorName: string;
};

export function resolveActor(actor: AuditActor): ResolvedActor {
  if (actor.kind === 'system') {
    return {
      actorId: null,
      actorRoleLabel: null,
      actorName: `system:${actor.jobName}`,
    };
  }
  return {
    actorId: actor.id,
    actorRoleLabel: actor.roleLabel,
    actorName: actor.name,
  };
}
