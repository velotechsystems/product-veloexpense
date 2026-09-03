import { DomainError } from '@/lib/errors/domain';
/**
 * VX4-1 — `ModuleDisabledError`, in a leaf module.
 *
 * Same reason `lib/integrations/errors.ts` exists: the gate is called from
 * `lib/integrations/*`, `lib/accounts/*` and `lib/integrations/dispatch.ts`, and
 * every one of those would otherwise have to import the module service to catch
 * its own refusal. A leaf everybody can import costs nothing and cannot cycle.
 */

export class ModuleDisabledError extends DomainError {
  constructor(
    readonly moduleCode: string,
    /** What the module is called, so the message names it the way a screen does. */
    readonly moduleName: string,
  ) {
    super(
      `${moduleName} is not enabled for this organization. An administrator can ` +
        `turn it on under Modules.`,
    );
    this.name = 'ModuleDisabledError';
  }
}

/** Narrow an unknown error without importing the module service. */
export function isModuleDisabled(err: unknown): err is ModuleDisabledError {
  return err instanceof ModuleDisabledError;
}
