/**
 * `@expenseos/design-system`, as VeloExpense provides it.
 *
 * Ported screens import from this barrel exactly as they do in ExpenseOS. Behind it are the
 * lib-ui-kit components: ExpenseOS's own (ported into the kit, vendored here) and, where the kit
 * already had one, the kit's. Where the two APIs differ the difference is absorbed HERE, once,
 * so screens stay verbatim (`Tooltip`, below). Each export lands with the first ported screen
 * that needs it; names follow ExpenseOS's barrel (`packages/design-system/src/index.ts`).
 */

// ── data-display ─────────────────────────────────────────────────────
export {
  Avatar,
  type AvatarProps,
  type AvatarSize,
  type AvatarVariant,
} from '@/components/data-display/Avatar';
export { initialsFrom, initialsFromDisplayName } from '@/components/data-display/initials';
export * from '@/components/data-display/data-table';
export type { FilterLabels } from '@/components/data-display/filters';
export {
  AddFilterPill,
  CustomScrollBox,
  DATE_PRESETS,
  DEFAULT_FILTER_LABELS,
  FacetCard,
  FacetRail,
  FilterBlock,
  formatDateFilterValue,
  LAST_N_DAYS_PREFIX,
  parseLastNDays,
  resolveDateFilter,
} from '@/components/data-display/filters';
export { ScopeChip } from '@/components/data-display/ScopeChip';
export { Scroll2D } from '@/components/data-display/Scroll2D';
export {
  type ClauseGroup,
  clauseGroupKey,
  DEFAULT_FILTER_SHEET_LABELS,
  type DropdownView,
  FilterPillBar,
  FilterSheet,
  type FilterSheetLabels,
  type FilterSheetProps,
  groupClauses,
  type PersistedViewState,
  type SystemView,
  type UserView,
  ViewDropdown,
  ViewsBar,
} from '@/components/data-display/saved-views';

// ── navigation ───────────────────────────────────────────────────────
export { NavLink, type NavLinkProps } from '@/components/navigation/NavLink';
export { Sidebar, type SidebarProps } from '@/components/navigation/Sidebar';
export { SidebarHeader, type SidebarHeaderProps } from '@/components/navigation/SidebarHeader';
export { SidebarProfile, type SidebarProfileProps } from '@/components/navigation/SidebarProfile';
export { SidebarSection, type SidebarSectionProps } from '@/components/navigation/SidebarSection';

// ── ui ───────────────────────────────────────────────────────────────
export { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
export { Badge, badgeVariants } from '@/components/ui/badge';
export { Button, buttonVariants } from '@/components/ui/button';
export { Checkbox } from '@/components/ui/checkbox';
export {
  AsyncCombobox,
  type AsyncComboboxProps,
  Combobox,
  type ComboboxItem,
  type ComboboxProps,
} from '@/components/ui/combobox';
export {
  Drawer,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  type DrawerContentProps,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerPortal,
  type DrawerSide,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
export { EmojiPicker, type EmojiPickerProps } from '@/components/ui/emoji-picker';
export { Input } from '@/components/ui/input';
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
export { Tooltip } from './tooltip';

// ── hooks, tokens, utils ─────────────────────────────────────────────
export { useIsCompact } from '@/hooks/useIsCompact';
export {
  CARDS_ONLY,
  COMPACT_MAX_WIDTH_PX,
  COMPACT_QUERY,
  MD_BREAKPOINT_PX,
  TABLE_ONLY,
} from '@/lib/breakpoints';
export { cn } from '@/lib/utils';
