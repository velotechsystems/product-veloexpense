/**
 * Read-only rendering of an `externalIds` JSON map (`{ system: id }`).
 *
 * Pill shape is shared across every consumer (directory tables, admin
 * lookup pages, drawer view-mode panels) so the visual vocabulary is
 * consistent. Two variants:
 *
 *   - `<ExternalIdsCell>`  compact, for table cells   (bg-card)
 *   - `<ExternalIdsBlock>` roomier, for drawer panels (bg-muted)
 *
 * The components are tolerant of arbitrary input — non-string values
 * are skipped, missing maps render an em dash placeholder. No
 * particular system names are baked in; whatever keys exist in the
 * map are surfaced verbatim.
 */

/** Filter + normalize a raw value into displayable entries. */
export function externalIdEntries(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && (v as string).length > 0)
    .map(([k, v]) => [k, v as string]);
}

/** Compact pill cluster — used inside DataTable cells. */
export function ExternalIdsCell({ value }: { value: unknown }) {
  const entries = externalIdEntries(value);
  if (entries.length === 0) {
    return <span className="text-muted-foreground text-sm">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([system, id]) => (
        <span
          key={system}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-foreground text-xs"
        >
          <span className="font-medium text-muted-foreground">{system}:</span>
          <span className="font-mono">{id}</span>
        </span>
      ))}
    </div>
  );
}

/** Roomier block — used inside drawer "External systems" sections. */
export function ExternalIdsBlock({ value }: { value: unknown }) {
  const entries = externalIdEntries(value);
  if (entries.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([system, id]) => (
        <span
          key={system}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
        >
          <span className="font-medium text-muted-foreground">{system}:</span>
          <span className="font-mono">{id}</span>
        </span>
      ))}
    </div>
  );
}
