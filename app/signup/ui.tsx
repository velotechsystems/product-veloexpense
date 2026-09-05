/**
 * VX5-2b — the chrome the two signup pages share.
 *
 * Local to `app/signup/`, and not reusing `app/expenses/ui.tsx`'s card, for the
 * reason `app/approve/page.tsx` gives about its own local `Shell`: the workbench
 * chrome links to authenticated routes, and every one of them would bounce a
 * stranger to `/login`. A signed-out page owns its own frame.
 *
 * Server components, no client JS — the whole signup flow is plain forms, same
 * as the rest of this product. Classes are the vendored lib-ui-kit tokens, so
 * dark mode comes free and there is no second palette to keep in step.
 */
import type { ReactNode } from 'react';

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-4 p-6">
      {children}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border bg-background p-6">
      {children}
    </section>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <h1 className="text-lg font-semibold text-foreground">{children}</h1>;
}

export function Lede({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * The text input. `Input` from `components/ui` would do, but every field here
 * wants the same label pairing and the same hint slot, and three copies of that
 * markup is where a `htmlFor` stops matching an `id` — which is invisible until
 * an e2e's `getByLabel` fails or somebody using a screen reader cannot tell
 * which box is which.
 */
export function Field({
  name,
  label,
  hint,
  type = 'text',
  required = false,
  autoComplete,
  defaultValue,
}: {
  name: string;
  label: string;
  hint?: ReactNode;
  type?: 'text' | 'email';
  required?: boolean;
  autoComplete?: string;
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-foreground" htmlFor={name}>
        {label}
      </label>
      <input
        className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        id={name}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
