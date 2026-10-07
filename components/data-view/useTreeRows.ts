'use client';

/**
 * Parent/child tree flattening for DataTable consumers (NetSuite reference
 * caches: accounts, subsidiaries, departments, classes, business units).
 *
 * The reference rows link to their parent by NetSuite-id string (resolved in
 * the UI, not an FK), so the caller supplies `getId` / `getParentId` in that
 * id space. `flattenTree` is the pure core (depth-first, collapsed subtrees
 * omitted, orphans promoted to roots); `useTreeRows` wraps it with
 * expand/collapse state (expanded by default — the requested UX).
 */
import { useCallback, useMemo, useState } from 'react';

export interface TreeNode<T> {
  /** Stable id in the parent-link space (e.g. netsuiteId). */
  id: string;
  item: T;
  depth: number;
  hasChildren: boolean;
}

/** Flatten items into the ordered list of currently-visible nodes. A node is
 *  hidden only when one of its ancestors is collapsed. Items whose parent is
 *  missing from the set are treated as roots (no silent dropping). Input order
 *  is preserved within each sibling group. */
export function flattenTree<T>(
  items: T[],
  getId: (t: T) => string,
  getParentId: (t: T) => string | null | undefined,
  collapsed: ReadonlySet<string>,
): TreeNode<T>[] {
  const byId = new Map<string, T>();
  for (const it of items) byId.set(getId(it), it);

  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];
  for (const it of items) {
    const parent = getParentId(it);
    if (parent != null && parent !== getId(it) && byId.has(parent)) {
      const arr = childrenOf.get(parent);
      if (arr) arr.push(it);
      else childrenOf.set(parent, [it]);
    } else {
      roots.push(it);
    }
  }

  const out: TreeNode<T>[] = [];
  const seen = new Set<string>(); // cycle guard
  const walk = (item: T, depth: number) => {
    const id = getId(item);
    if (seen.has(id)) return;
    seen.add(id);
    const kids = childrenOf.get(id) ?? [];
    out.push({ id, item, depth, hasChildren: kids.length > 0 });
    if (!collapsed.has(id)) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

export function useTreeRows<T>(
  items: T[],
  getId: (t: T) => string,
  getParentId: (t: T) => string | null | undefined,
) {
  // Collapsed set (expanded-by-default ⇒ empty initial set).
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const nodes = useMemo(
    () => flattenTree(items, getId, getParentId, collapsed),
    [items, getId, getParentId, collapsed],
  );

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(new Set(nodes.filter((n) => n.hasChildren).map((n) => n.id)));
  }, [nodes]);
  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  const isExpanded = useCallback((id: string) => !collapsed.has(id), [collapsed]);

  return { nodes, toggle, isExpanded, expandAll, collapseAll };
}
