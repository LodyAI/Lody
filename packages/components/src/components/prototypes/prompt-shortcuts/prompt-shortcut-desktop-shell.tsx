/**
 * PROTOTYPE — a 1440×900 desktop frame holding both halves of the feature at
 * once: the Settings catalog on the left, the composer that calls it on the
 * right. It exists so the product owner can see that the pills in Settings and
 * the filtering in the `/` menu are the same fact seen twice.
 *
 * Not a route, not a layout: the real Settings surface is a modal/page and the
 * real composer sits under a transcript. This frame only puts them side by side.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';
import { ScrollArea } from '@/ui/scroll-area';
import { Button } from '@/ui/button';
import { PROTOTYPE_MACHINES, PROTOTYPE_WORK_CONTEXT } from './prompt-shortcut-fixtures';
import type { PrototypeWorkContext } from './prompt-shortcut-model';
import { PromptShortcutComposerPrototype } from './prompt-shortcut-composer-prototype';
import { PromptShortcutsSettingPrototype } from './prompt-shortcuts-setting-prototype';

const SETTINGS_ENTRIES = ['Agents', 'Agent Roles', 'Prompt Shortcuts', 'MCP', 'Projects'] as const;

export function PromptShortcutDesktopShell({
  initialSlug,
  initialQuery,
  className,
}: {
  initialSlug?: string;
  initialQuery?: string;
  className?: string;
}) {
  // The composer context is switchable so the "requirements stop being met"
  // path (§2.3) is reachable by clicking rather than by editing a story arg.
  const [context, setContext] = React.useState<PrototypeWorkContext>(PROTOTYPE_WORK_CONTEXT);

  return (
    <div className={cn('flex h-full w-full bg-background text-foreground', className)}>
      <aside className="flex w-56 shrink-0 flex-col gap-1 border-r border-border/60 px-3 py-4">
        <span className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.6px] text-muted-foreground/80">
          Workspace
        </span>
        {SETTINGS_ENTRIES.map((entry) => (
          <span
            key={entry}
            className={cn(
              'rounded-lg px-2 py-1.5 text-sm',
              // §3.1 — the new entry sits between Agent Roles and MCP.
              entry === 'Prompt Shortcuts'
                ? 'bg-hover font-medium text-hover-foreground'
                : 'text-muted-foreground'
            )}
          >
            {entry}
          </span>
        ))}
      </aside>

      <div className="flex min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-border/60">
          <header className="border-b border-border/60 px-5 py-3">
            <h1 className="text-sm font-semibold">Prompt Shortcuts</h1>
          </header>
          <ScrollArea className="min-h-0 flex-1">
            <div className="py-3">
              <PromptShortcutsSettingPrototype context={context} />
            </div>
          </ScrollArea>
        </div>

        <div className="flex w-[520px] shrink-0 flex-col">
          <header className="flex items-center justify-between gap-2 border-b border-border/60 px-5 py-3">
            <h2 className="text-sm font-semibold">Composer</h2>
            <div className="flex items-center gap-1">
              {PROTOTYPE_MACHINES.map((machine) => (
                <Button
                  key={machine.id}
                  type="button"
                  size="sm"
                  variant={context.machineId === machine.id ? 'secondary' : 'ghost'}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setContext((current) => ({ ...current, machineId: machine.id }))}
                >
                  {machine.label}
                </Button>
              ))}
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-5 py-4">
            <p className="text-[11px] text-muted-foreground">
              Type <span className="font-mono">/</span> to open the menu. Switching the machine
              above re-checks every Shortcut — nothing silently retargets.
            </p>
            <PromptShortcutComposerPrototype
              key={`${context.machineId}-${initialSlug ?? 'none'}`}
              context={context}
              initialSlug={initialSlug}
              initialQuery={initialQuery}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
