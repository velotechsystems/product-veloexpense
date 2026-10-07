'use client';

import { useEffect, useState } from 'react';

/**
 * Returns a debounced copy of `value` — updates `delay` ms after
 * the input value last changed. Useful for throttling expensive
 * queries (facet counts, autocomplete) on filter-state mutations
 * that the user generates rapidly.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
