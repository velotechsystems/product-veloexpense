'use client';

import { createContext, useContext } from 'react';

/**
 * SchemaForm-wide configuration plumbed via React context so templates
 * don't have to prop-drill through RJSF.
 *
 * Currently carries one switch:
 *   - `inline`: when true, every primitive Field in the form renders in
 *     inline layout (label/control side-by-side, AlignedFields-style)
 *     instead of stacked. Containers (Fieldset / array body) ignore
 *     this — only leaf fields adopt the inline layout.
 */
export interface SchemaFormConfig {
  inline: boolean;
}

export const SchemaFormConfigContext = createContext<SchemaFormConfig>({ inline: false });

export function useSchemaFormConfig(): SchemaFormConfig {
  return useContext(SchemaFormConfigContext);
}
