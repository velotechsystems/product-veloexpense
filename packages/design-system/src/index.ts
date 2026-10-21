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
export {
  ExternalIdsBlock,
  ExternalIdsCell,
  externalIdEntries,
} from '@/components/data-display/ExternalIds';
export { ScopeChip } from '@/components/data-display/ScopeChip';
export { Scroll2D } from '@/components/data-display/Scroll2D';
// Wave 2 (w2-05): the expense report list's tiles and status pill.
export { StatCard } from '@/components/data-display/StatCard';
export type {
  StatCardProps,
  StatCardTrend,
  StatCardVariant,
} from '@/components/data-display/StatCard.types';
export { StatusBadge } from '@/components/data-display/StatusBadge';
export type {
  ExpenseStatus,
  StatusBadgeProps,
  WorkflowStatus,
} from '@/components/data-display/StatusBadge.types';
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

// ── forms ────────────────────────────────────────────────────────────
export { ColorInput, type ColorInputProps } from '@/components/forms/ColorInput';
export {
  type ExternalIdEntry,
  type ExternalIdSourceOption,
  ExternalIdsEditor,
  type ExternalIdsEditorProps,
  entriesFromMap,
  mapFromEntries,
} from '@/components/forms/ExternalIdsEditor';
export { Fieldset, type FieldsetProps } from '@/components/forms/Fieldset';
export { AlignedFields, Field, type FieldProps } from '@/components/forms/field/Field';
export { HexInput, type HexInputProps, isValidHex } from '@/components/forms/HexInput';
export { MultiSelectDropdown } from '@/components/forms/MultiSelectDropdown';
export type { MultiSelectDropdownProps } from '@/components/forms/MultiSelectDropdown.types';
export { NumberStepper, type NumberStepperProps } from '@/components/forms/NumberStepper';
export {
  SchemaForm,
  type SchemaFormHandle,
  type SchemaFormProps,
  schemaFormValidator,
} from '@/components/forms/schema-form';

// ── icons ────────────────────────────────────────────────────────────
// ExpenseOS's barrel re-exports the Tabler icons its screens use (`src/icons`); each lands
// here with the first ported screen that imports it from this barrel.
export { IconEdit, IconPlus } from '@tabler/icons-react';

// ── navigation ───────────────────────────────────────────────────────
export { NavLink, type NavLinkProps } from '@/components/navigation/NavLink';
export { Sidebar, type SidebarProps } from '@/components/navigation/Sidebar';
export { SidebarHeader, type SidebarHeaderProps } from '@/components/navigation/SidebarHeader';
export { SidebarProfile, type SidebarProfileProps } from '@/components/navigation/SidebarProfile';
export { SidebarSection, type SidebarSectionProps } from '@/components/navigation/SidebarSection';

// ── ui ───────────────────────────────────────────────────────────────
export { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
export { Textarea } from '@/components/ui/textarea';
// w6-03: the assistant panel and its feedback queue render replies with ExpenseOS's MarkdownText.
export { MarkdownText, type MarkdownTextProps } from '@/components/ui/markdown-text';
export { Badge, badgeVariants } from '@/components/ui/badge';
/** People 3: ExpenseOS's barrel exports `BadgeProps` (lib/employeeStatus.ts types its variant map
 *  with it); the kit's Badge has no props interface of its own, so it is derived here. */
export type BadgeProps = import('react').ComponentProps<typeof import('@/components/ui/badge').Badge>;
export { Button, buttonVariants } from '@/components/ui/button';
// w4-09: the kit's Card, as StatCard and SectionCard are drawn on (the kit's own shadcn card;
// ExpenseOS's is a plain bordered box with the same part names).
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
export { Checkbox } from '@/components/ui/checkbox';
// VeloExpense: the kit's Radix dialog, where ExpenseOS's is Base UI. The same parts and the
// same corner close button; `onOpenChange` takes the next open state in both.
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
// w4-09: the dashboard's band and card shell — ExpenseOS's `ui/identity-banner` and
// `ui/section-card`, vendored from the kit's data-display item.
export {
  IdentityBanner,
  IdentityBannerChip,
  type IdentityBannerChipProps,
  type IdentityBannerProps,
} from '@/components/data-display/IdentityBanner';
export {
  SectionCard,
  type SectionCardError,
  type SectionCardProps,
  SectionEmpty,
  type SectionEmptyProps,
} from '@/components/data-display/SectionCard';
export { Input } from '@/components/ui/input';
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
export { ResizablePanels, type ResizablePanelsProps } from '@/components/ui/resizable-panels';
export { Radio, RadioGroup } from '@/components/ui/radio';
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
// VeloExpense (eos batch 5): ExpenseOS #591 adds `SelectGroupLabel` to its design system, a
// group's visible title announced through the group. The kit's Radix `SelectLabel` is
// exactly that (Radix wires the group's `aria-labelledby` to it), with the same classes.
export { SelectLabel as SelectGroupLabel } from '@/components/ui/select';
// VeloExpense: ExpenseOS's one-component Tooltip, on the kit's parts — in the kit's `forms`
// item since Wave 1 (it was this package's own file in Wave 0).
export { Tooltip } from '@/components/forms/Tooltip';

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
