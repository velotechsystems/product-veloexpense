'use client';

/**
 * Context for the schema-driven node config. RJSF instantiates custom fields
 * itself, so they can't receive `options`/`locale` as props — they read them
 * here. `NodeConfigPanel` wraps its <SchemaForm> in this provider.
 */
import type { PredicateField } from '@expenseos/approvals';
import { PREDICATE_FIELDS } from '@expenseos/approvals';
import { DEFAULT_LOCALE, type Locale } from '@expenseos/i18n/locales';
import { createContext, useContext } from 'react';
import type { EditorOptions } from './options';

interface NodeConfigCtx {
  options: EditorOptions | undefined;
  /** Condition fields selectable for this workflow's subject type. */
  fields: PredicateField[];
  locale: Locale;
}

const Ctx = createContext<NodeConfigCtx>({
  options: undefined,
  fields: [...PREDICATE_FIELDS],
  // VeloExpense: the registry's default, not a bare tag (scripts/check-i18n.mjs, IL-1).
  locale: DEFAULT_LOCALE,
});

export const NodeConfigProvider = Ctx.Provider;
export const useNodeConfig = () => useContext(Ctx);
