import {
  IconBaselineDensityLarge,
  IconBaselineDensityMedium,
  IconBaselineDensitySmall,
} from '@tabler/icons-react';
import type { Density } from './types';

/** Vertical padding utility per density. Applied to body cells. */
export const DENSITY_PADDING: Record<Density, string> = {
  compact: 'py-1.5',
  normal: 'py-3',
  comfortable: 'py-5',
};

/** Icon used in the table-settings density section + the trigger. */
export const DENSITY_ICON: Record<Density, typeof IconBaselineDensitySmall> = {
  compact: IconBaselineDensitySmall,
  normal: IconBaselineDensityMedium,
  comfortable: IconBaselineDensityLarge,
};

/** Pinch-of-paranoia classNames concatenator — drops falsy parts. */
export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
