'use client';

/**
 * Sub-form for "external ID" maps — every entity that federates to outside systems
 * (User, BusinessUnit, LegalEntity, Department, Account, Role, JobLevel, FiscalYear…)
 * carries a `Record<string, string>` of `{ systemCode: externalId }` pairs.
 *
 * ── One shape, everywhere ────────────────────────────────────────────────────
 *
 * The product used to spell this two ways. Admin lookups had a sub-form; the People
 * drawer had a FIELD PER SYSTEM, rendered whether or not the person had an id in it —
 * so a directory with four sources put four permanently-empty boxes in front of
 * everybody editing a name, and adding a fifth source silently changed every profile
 * form in the app. This is the one shape now, and it is the shape the rest of the
 * product already uses for a repeating row: a list of line items, an "add" button, and
 * a trash button at the end of each row.
 *
 * ── The row ─────────────────────────────────────────────────────────────────
 *
 *   [ system ▾ ]  [ external id            ]  [🗑]
 *
 * The system comes from the tenant's OWN `ExternalIdSource` rows, passed in as
 * `sources`. It used to be a hardcoded list of four names, which is wrong in both
 * directions: it offered systems a tenant does not use, and it could not offer one
 * they had added. `(other…)` remains, because the server upserts an unknown code and a
 * list with no escape hatch cannot bootstrap the first id for a new system.
 *
 * A source already used on another row is not offered again — one id per system is the
 * whole point of the map — and a duplicate that arrives from stored data is flagged.
 *
 * Validation:
 *   - Duplicate keys get a destructive border (display only; the form decides whether
 *     to block submit).
 *   - Empty keys/values are dropped at submit time by `mapFromEntries`.
 *
 * The editor is controlled — callers own the `entries` state.
 */

import { useMemo } from 'react';
import { IconPlus, IconX } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ExternalIdEntry {
  /** Stable per-row id for React keys. */
  rowId: string;
  key: string;
  value: string;
  /**
   * Whether this row's key is typed rather than picked.
   *
   * Three states, and the third is the point. `true` is an explicit choice — the person
   * selected "(other…)" — and it STICKS even if what they then type happens to match a
   * known system, because a control that flips to a dropdown halfway through a word eats
   * the rest of it. `false` is a key the list is known to contain. `undefined` means
   * nobody could tell yet: rows built from a stored map before the source list arrived,
   * which the editor resolves at render.
   */
  customKey?: boolean;
}

/** One system the tenant federates to: the stored `code`, and what to call it. */
export interface ExternalIdSourceOption {
  code: string;
  label: string;
}

/** Convert a stored map → the editor's row list. */
export function entriesFromMap(
  map: Record<string, string>,
  sources: readonly ExternalIdSourceOption[] = [],
): ExternalIdEntry[] {
  const known = new Set<string>(sources.map((s) => s.code));
  return Object.entries(map).map(([k, v], i) => ({
    rowId: `e-${i}-${k}`,
    key: k,
    value: String(v ?? ''),
    // Left UNDECIDED when there is no list to decide against — the source list is
    // fetched, and callers routinely build rows before it lands. Answering "custom" there
    // would show a free-text box for `netsuite` on every form that opens first.
    ...(sources.length > 0 ? { customKey: !known.has(k) } : {}),
  }));
}

/** Reduce the row list to a clean map (drops empty rows). */
export function mapFromEntries(entries: ExternalIdEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const k = e.key.trim();
    if (k && e.value.trim()) out[k] = e.value.trim();
  }
  return out;
}

export interface ExternalIdsEditorProps {
  entries: ExternalIdEntry[];
  onChange: (next: ExternalIdEntry[]) => void;
  /** The systems this tenant federates to, from its own `ExternalIdSource` rows. The
   *  editor still accepts an arbitrary code via the "(other…)" branch, which is what
   *  lets somebody bootstrap the first id for a system nobody has used yet. Default
   *  `[]` = free-text only. */
  sources?: readonly ExternalIdSourceOption[];
  labels: {
    key: string;
    value: string;
    addRow: string;
    removeRow: string;
    help: string;
    /** Trailing dropdown option for free-text keys. Defaults to "(other…)". */
    other?: string;
  };
}

const OTHER_SENTINEL = '__other__';

function newRowId(): string {
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function ExternalIdsEditor({
  entries,
  onChange,
  sources = [],
  labels,
}: ExternalIdsEditorProps) {
  const labelOf = (code: string) => sources.find((s) => s.code === code)?.label ?? code;

  /**
   * Whether a row shows the free-text box instead of the picker, decided AT RENDER from
   * the sources actually available — not from the flag stored on the row.
   *
   * An explicit `true` — the person picked "(other…)" — always wins, because a control
   * that flips to a dropdown halfway through a typed word eats the rest of it. Otherwise
   * the list decides: a key it knows gets the picker, a key it does not gets the box. That
   * matters because the list is FETCHED, and rows built from a stored map before it lands
   * carry no answer at all; trusting a stale flag there would show a free-text box for
   * `netsuite` on every form that opens first.
   */
  const isCustom = (e: ExternalIdEntry) => {
    if (e.customKey === true) return true;
    if (sources.length === 0) return true;
    if (e.customKey === false) return false;
    const k = e.key.trim();
    if (!k) return false;
    return !sources.some((s) => s.code === k);
  };
  // Track which canonical systems are already in use so the quick-add
  // chips disable themselves and the per-row dropdown hides them.
  const usedKeys = useMemo(() => new Set(entries.map((e) => e.key.trim())), [entries]);

  // Per-row duplicate-key detection — for highlighting only.
  const dupKeys = useMemo(() => {
    const seen = new Map<string, string>();
    const flagged = new Set<string>();
    for (const e of entries) {
      const k = e.key.trim();
      if (!k) continue;
      const prev = seen.get(k);
      if (prev) {
        flagged.add(prev);
        flagged.add(e.rowId);
      } else {
        seen.set(k, e.rowId);
      }
    }
    return flagged;
  }, [entries]);

  const updateRow = (rowId: string, patch: Partial<ExternalIdEntry>) =>
    onChange(entries.map((e) => (e.rowId === rowId ? { ...e, ...patch } : e)));
  const removeRow = (rowId: string) => onChange(entries.filter((e) => e.rowId !== rowId));
  const addRowWithKey = (key: string, customKey = false) =>
    onChange([...entries, { rowId: newRowId(), key, value: '', customKey }]);
  // A new row starts with the SELECT showing, not a free-text box: "pick the name from
  // the list" is the path, and typing a raw system code is the exception behind
  // "(other…)". With no sources configured there is no list, so it falls back to text.
  const addBlankRow = () => addRowWithKey('', sources.length === 0);

  const otherLabel = labels.other ?? '(other…)';

  return (
    <div className="space-y-2">
      {labels.help && <p className="text-muted-foreground text-xs">{labels.help}</p>}

      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map((e) => {
            const isDup = dupKeys.has(e.rowId);
            return (
              <div key={e.rowId} className="flex items-start gap-2">
                <div className="flex-1">
                  {isCustom(e) ? (
                    <Input
                      value={e.key}
                      onChange={(ev) => updateRow(e.rowId, { key: ev.target.value })}
                      placeholder={labels.key}
                      className={isDup ? 'border-destructive' : undefined}
                    />
                  ) : (
                    <select
                      value={e.key}
                      onChange={(ev) => {
                        if (ev.target.value === OTHER_SENTINEL) {
                          updateRow(e.rowId, { key: '', customKey: true });
                        } else {
                          updateRow(e.rowId, { key: ev.target.value });
                        }
                      }}
                      className={`flex h-9 w-full rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
                        isDup ? 'border-destructive' : 'border-input'
                      }`}
                    >
                      {/* An unpicked row leads with a blank, so the select does not
                          claim a system the person has not chosen. */}
                      {!e.key && <option value="">{labels.key}</option>}
                      {/* The currently-selected system always appears, even though it
                          would otherwise be filtered out as used-on-this-row. */}
                      {e.key && (
                        <option key={`__current_${e.key}`} value={e.key}>
                          {labelOf(e.key)}
                        </option>
                      )}
                      {sources
                        .filter((s) => !usedKeys.has(s.code) || s.code === e.key)
                        .map((s) =>
                          s.code === e.key ? null : (
                            <option key={s.code} value={s.code}>
                              {s.label}
                            </option>
                          ),
                        )}
                      <option value={OTHER_SENTINEL}>{otherLabel}</option>
                    </select>
                  )}
                </div>
                <div className="flex-[2]">
                  <Input
                    value={e.value}
                    onChange={(ev) => updateRow(e.rowId, { value: ev.target.value })}
                    placeholder={labels.value}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(e.rowId)}
                  title={labels.removeRow}
                  aria-label={labels.removeRow}
                >
                  <IconX size={14} />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <Button type="button" variant="outline" size="sm" onClick={addBlankRow} className="w-full">
        <IconPlus size={14} className="mr-1" />
        {labels.addRow}
      </Button>
    </div>
  );
}
