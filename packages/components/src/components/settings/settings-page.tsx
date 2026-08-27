import type { ReactNode } from 'react';

export const settingContainerClass =
  'space-y-3 px-4 py-2 overflow-x-hidden md:mx-auto md:max-w-4xl md:px-2';

export function SettingsPage({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="overflow-x-hidden px-4 md:mx-auto md:max-w-4xl md:px-2">
      <div className="hidden h-12 items-center md:flex">
        <h2 className="text-xl font-semibold leading-none">{title}</h2>
      </div>
      <div className="flex min-h-8 items-center md:hidden">
        <div className="min-w-0 text-xs leading-snug text-muted-foreground">{description}</div>
      </div>
      <div className="hidden min-h-8 items-center md:flex">
        <div className="min-w-0 text-xs leading-snug text-muted-foreground">{description}</div>
      </div>
      <div className="space-y-3 pb-2 pt-3">{children}</div>
    </div>
  );
}

export function SettingsEmptyState({
  icon,
  message,
  action,
}: {
  icon: ReactNode;
  message: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-border/60 bg-card/30 px-6 py-8 text-center text-sm">
      <div className="text-muted-foreground/70 [&>svg]:h-6 [&>svg]:w-6">{icon}</div>
      <p className="mt-2 text-muted-foreground">{message}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
