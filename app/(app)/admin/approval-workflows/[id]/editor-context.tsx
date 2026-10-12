'use client';

import type { WorkflowNode } from '@expenseos/approvals';
/**
 * Editor options context. React Flow instantiates node components itself, so
 * the node renderer can't receive props directly — it reads them here. The
 * editor wraps the canvas in <EditorOptionsProvider>. `updateNode` lets nodes
 * edit their own config inline (e.g. the Approval node's pills); `readOnly`
 * disables that in version-preview mode.
 */
import { DEFAULT_LOCALE, type Locale } from '@expenseos/i18n/locales';
import { createContext, useContext } from 'react';
import type { EditorOptions } from './options';

interface EditorOptionsCtx {
  options: EditorOptions | undefined;
  locale: Locale;
  readOnly: boolean;
  updateNode: (node: WorkflowNode) => void;
}

const Ctx = createContext<EditorOptionsCtx>({
  options: undefined,
  // VeloExpense: the registry's default, not a bare tag (scripts/check-i18n.mjs, IL-1).
  locale: DEFAULT_LOCALE,
  readOnly: true,
  updateNode: () => {},
});

export const EditorOptionsProvider = Ctx.Provider;
export const useEditorOptions = () => useContext(Ctx);
