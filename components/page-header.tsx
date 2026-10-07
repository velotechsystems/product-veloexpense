import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The top of a screen: its name, one line on what it is for, and the screen's
 * own actions on the right. Server-safe.
 *
 * 2026 guidelines, Typography: the page title is heading-1 (30/36, 700 —
 * "Employees" is the guide's own example), the line under it body-sm in
 * muted-foreground. The optional eyebrow is the guide's eyebrow style (Josefin
 * Sans Light, all caps, wide tracking) and is for a short section label only —
 * never a sentence.
 */
function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  ...props
}: Omit<React.ComponentProps<"header">, "title"> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow ? <p className="velo-eyebrow">{eyebrow}</p> : null}
        <h1 className="text-3xl leading-9 font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export { PageHeader };
