// Ported from ExpenseOS `apps/web/src/lib/breakpoints.test.ts` (1e682dd6), w6-04 (d88): the `lg` half only.
import { describe, expect, it } from 'vitest';
import { LG_BREAKPOINT_PX, LG_MEDIA_QUERY } from './breakpointsLg';

/**
 * These assertions exist to make a silent divergence loud.
 *
 * The constants mirror Tailwind's compiled-in `lg` default, which no runtime read can
 * reach. If someone overrides `lg` in the theme and not here, nothing breaks at build
 * time and nothing breaks in the type checker — the JS branch simply flips at a
 * different width than the CSS does, which is the kind of bug that gets reported as
 * "it looks fine but the data is wrong at that one size". Pinning the number means the
 * change has to be made deliberately, in two places, with this test as the reminder.
 */
describe('breakpoints', () => {
  it('pins lg to 1024px, matching Tailwind default', () => {
    expect(LG_BREAKPOINT_PX).toBe(1024);
  });

  it('builds the media query from the pinned pixel value', () => {
    expect(LG_MEDIA_QUERY).toBe('(min-width: 1024px)');
  });
});
