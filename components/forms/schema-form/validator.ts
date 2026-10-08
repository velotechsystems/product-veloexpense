/**
 * Shared ajv validator for every <SchemaForm>. @rjsf/validator-ajv8 bundles
 * ajv 8 + ajv-formats. The same JSON Schemas are expected to validate
 * server-side (e.g. at a tRPC boundary) so the schema is the single source
 * of truth — this validator is the client half.
 */

import { customizeValidator } from '@rjsf/validator-ajv8';

export const validator = customizeValidator({
  ajvOptionsOverrides: { allErrors: true },
  ajvFormatOptions: { mode: 'fast' },
});
