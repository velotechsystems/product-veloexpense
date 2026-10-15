import { resetMobileArtifacts } from './mobile-census';

/**
 * `globalSetup`: empty `e2e/.artifacts/mobile/` and open a new run, once per
 * `playwright test` invocation, before any project starts.
 *
 * WHY IT IS ITS OWN FILE. Playwright loads `globalSetup` and `globalTeardown` by module
 * path and calls each module's DEFAULT export, and `mobile-census.ts`'s default export is
 * already the teardown. One module cannot have two defaults, so this is a shim over the
 * named `resetMobileArtifacts()` rather than a second home for the logic.
 *
 * WHY IT EXISTS AT ALL, and what it deliberately destroys, is the run-identity note in
 * `mobile-census.ts`. Short version: without it the census counted sidecars from earlier
 * runs as coverage of this one, which had already corrupted the evidence once.
 */
export default async function globalSetup(): Promise<void> {
  resetMobileArtifacts();
}
