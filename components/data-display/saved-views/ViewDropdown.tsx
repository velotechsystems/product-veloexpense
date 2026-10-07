'use client';

import {
  IconBookmark,
  IconBookmarkFilled,
  IconChevronDown,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { cls } from '../data-table/helpers';
import type { DropdownView, SystemView, UserView } from './types';

/**
 * Saved-view selector — `Defaults` / `My views` sections, per-row
 * hover actions (pin / rename / delete), and a "Save current as new
 * view" footer. Generic over the host's field and scope unions.
 */
export function ViewDropdown<F extends string, S extends string = string>({
  views,
  activeId,
  onSelect,
  activeName,
  onSaveAsNew,
  onRenameView,
  onDeleteView,
  onTogglePinned,
}: {
  views: DropdownView<F, S>[];
  activeId: string;
  onSelect: (id: string) => void;
  activeName: string;
  onSaveAsNew: () => void;
  onRenameView: (id: string, currentName: string) => void;
  onDeleteView: (id: string, name: string) => void;
  onTogglePinned: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const systemViews = views.filter((v): v is SystemView<F, S> => v.kind === 'system');
  const userViews = views.filter((v): v is UserView<F, S> => v.kind === 'user');
  const pinnedUser = userViews.filter((v) => v.pinned);
  const unpinnedUser = userViews.filter((v) => !v.pinned);

  const renderRow = (v: DropdownView<F, S>) => (
    <div
      key={v.id}
      className={cls(
        'group flex items-center gap-1 px-3 py-1.5 hover:bg-muted',
        v.id === activeId && 'text-primary',
      )}
    >
      {/* Left: default toggle. One default per resource; clicking another
          view's icon switches the default. System views can't be a default —
          render a spacer so their names stay aligned. */}
      {v.kind === 'user' ? (
        <button
          type="button"
          aria-label={v.pinned ? 'Default view — click to unset' : 'Set as default'}
          title={v.pinned ? 'Default view — click to unset' : 'Set as default'}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePinned(v.id);
          }}
          className={cls(
            'shrink-0 rounded p-0.5 transition-colors hover:bg-background',
            v.pinned ? 'text-primary' : 'text-muted-foreground/40 hover:text-foreground',
          )}
        >
          {v.pinned ? <IconBookmarkFilled size={12} /> : <IconBookmark size={12} />}
        </button>
      ) : (
        <span className="w-[20px] shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={() => {
          onSelect(v.id);
          setOpen(false);
        }}
        className="flex flex-1 items-center gap-2 text-left text-sm"
      >
        <span className="truncate">{v.name}</span>
      </button>
      {v.id === activeId && <span className="text-primary text-xs">●</span>}
      {v.kind === 'user' && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            type="button"
            aria-label="Rename"
            title="Rename"
            onClick={(e) => {
              e.stopPropagation();
              onRenameView(v.id, v.name);
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <IconPencil size={11} />
          </button>
          <button
            type="button"
            aria-label="Delete"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteView(v.id, v.name);
            }}
            className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <IconTrash size={11} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-semibold text-foreground text-sm hover:bg-muted"
      >
        {activeName}
        <IconChevronDown size={12} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40"
          />
          <div className="absolute top-full left-0 z-50 mt-1 min-w-[240px] rounded-md border border-border bg-popover py-1 shadow-md">
            <div className="px-3 py-1 font-semibold text-[10px] text-muted-foreground uppercase tracking-wide">
              Defaults
            </div>
            {systemViews.map(renderRow)}
            {(pinnedUser.length > 0 || unpinnedUser.length > 0) && (
              <>
                <div className="my-1 h-px bg-border" />
                <div className="px-3 py-1 font-semibold text-[10px] text-muted-foreground uppercase tracking-wide">
                  My views
                </div>
                {pinnedUser.map(renderRow)}
                {unpinnedUser.map(renderRow)}
              </>
            )}
            <div className="my-1 h-px bg-border" />
            <button
              type="button"
              onClick={() => {
                onSaveAsNew();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground text-sm hover:bg-muted"
            >
              <IconPlus size={12} />
              Save current as new view
            </button>
          </div>
        </>
      )}
    </div>
  );
}
