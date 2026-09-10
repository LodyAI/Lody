import type { ReactNode } from 'react';
import { Field as UiField } from '@lody/ui/field';

/**
 * The shared grammar of the settings editors.
 *
 * Every settings form — MCP connection, Agent Role — is the same stack of
 * bordered sections holding labelled fields, so the spacing and typography live
 * here once. A local copy per editor is how three dialogs that are supposed to
 * look like one surface drift apart one padding value at a time.
 */

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-border/70 bg-card/60 p-3">
      <header>
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {hint ? (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/90">{hint}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

export function Field({
  htmlFor,
  label,
  hint,
  icon,
  children,
}: {
  /** Associates the label with a control that owns an id; omit for a group. */
  htmlFor?: string;
  label: string;
  hint?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
        <UiField.Label htmlFor={htmlFor} className="text-xs font-medium">
          {label}
        </UiField.Label>
      </div>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
