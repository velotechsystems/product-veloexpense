// The generic `<ScopeChip>` lives in `@expenseos/design-system`. This
// shim re-exports it pinned to the user-domain `DirectoryScope` union
// so existing call sites (EmployeeDirectory, ViewsBar) keep their
// previous types without threading the type parameter.
import { ScopeChip as GenericScopeChip } from '@expenseos/design-system';
import type { DirectoryScope } from '@/server/lib/userScope';

export function ScopeChip(props: {
  availableScopes: DirectoryScope[];
  current: DirectoryScope;
  onChange: (s: DirectoryScope) => void;
  scopeLabel: (s: DirectoryScope) => string;
}) {
  return <GenericScopeChip<DirectoryScope> {...props} />;
}
