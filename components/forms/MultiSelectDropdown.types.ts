/**
 * Props for the MultiSelectDropdown component — the canonical multi-select
 * across forms (RJSF enum arrays route through this via CheckboxesWidget).
 */
export interface MultiSelectDropdownItem {
  value: string;
  label: string;
}

export interface MultiSelectDropdownProps {
  /** Available options. */
  items: MultiSelectDropdownItem[];
  /** Currently selected values (controlled). */
  value: string[];
  /** Callback when selection changes. */
  onValueChange: (next: string[]) => void;
  /** Placeholder shown in the trigger when nothing is selected. */
  placeholder?: string;
  /** Placeholder for the in-popover search input. */
  searchPlaceholder?: string;
  /** Text shown when the search matches no options. */
  emptyText?: string;
  /** Disable interaction. */
  disabled?: boolean;
  /** id forwarded to the trigger (for label association). */
  id?: string;
  /** Optional class merged into the trigger button. */
  className?: string;
}
