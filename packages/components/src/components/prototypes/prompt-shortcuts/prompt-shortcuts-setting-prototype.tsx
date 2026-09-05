/**
 * PROTOTYPE — Settings → Prompt Shortcuts (§3.1).
 *
 * Deliberately keeps every Shortcut the user can read, including the ones that
 * cannot run right now: Settings is where you FIX a Shortcut, so a row that
 * disappears when its machine sleeps is a row you can never repair.
 */

import * as React from 'react';
import { Plus, Trash2, Zap } from 'lucide-react';

import { cn } from '@/lib/utils';
import { settingContainerClass } from '@/components/settings';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import {
  createBlankShortcut,
  PROTOTYPE_LABELS,
  PROTOTYPE_MENTION_CATALOG,
  PROTOTYPE_SHORTCUTS,
  PROTOTYPE_WORK_CONTEXT,
} from './prompt-shortcut-fixtures';
import {
  resolveEligibility,
  resolveVariableRows,
  type PrototypeEligibility,
  type PrototypeShortcut,
  type PrototypeWorkContext,
} from './prompt-shortcut-model';
import { EligibilityNote, ScopePills, variableCountLabel } from './prompt-shortcut-visuals';
import { PromptShortcutEditorPrototype } from './prompt-shortcut-editor-prototype';

export function PromptShortcutRowPrototype({
  shortcut,
  eligibility,
  variableCount,
  onOpen,
  onRemove,
}: {
  shortcut: PrototypeShortcut;
  eligibility: PrototypeEligibility;
  variableCount: number;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const countLabel = variableCountLabel(variableCount);

  return (
    <div className="overflow-hidden rounded-lg bg-foreground/[0.04]">
      <div className="flex w-full min-w-0 items-center transition-colors hover:bg-hover/40">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Edit ${shortcut.name}`}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-3 py-2.5 text-left focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground/[0.05]">
            <Zap className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="min-w-0 truncate text-sm font-medium leading-tight">
                {shortcut.name}
              </span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                /{shortcut.slug}
              </span>
              {/* Visibility, not scope. The pills below say where a Shortcut can
                  be called; this says who can see it, and calling both of them
                  "Workspace" made one row say it twice. */}
              <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                {shortcut.visibility === 'workspace' ? 'Shared' : 'Private'}
              </Badge>
            </span>
            {shortcut.description ? (
              <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
                {shortcut.description}
              </span>
            ) : null}
            <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <ScopePills scope={shortcut.scope} />
              {countLabel ? (
                <span className="text-[11px] leading-4 text-muted-foreground/80">{countLabel}</span>
              ) : null}
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-2">
              <EligibilityNote eligibility={eligibility} />
              <span className="text-[11px] leading-tight text-muted-foreground/60">
                {shortcut.ownerLabel} · rev {shortcut.revision}
              </span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-1 self-start py-2 pl-2 pr-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Remove ${shortcut.name}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PromptShortcutsSettingPrototype({
  shortcuts = PROTOTYPE_SHORTCUTS,
  context = PROTOTYPE_WORK_CONTEXT,
  className,
}: {
  shortcuts?: readonly PrototypeShortcut[];
  context?: PrototypeWorkContext;
  className?: string;
}) {
  const [editing, setEditing] = React.useState<PrototypeShortcut | null>(null);
  const [removed, setRemoved] = React.useState<readonly string[]>([]);

  const rows = React.useMemo(
    () =>
      shortcuts
        .filter((shortcut) => !removed.includes(shortcut.id))
        .map((shortcut) => ({
          shortcut,
          eligibility: resolveEligibility(
            shortcut,
            PROTOTYPE_MENTION_CATALOG,
            context,
            PROTOTYPE_LABELS
          ),
          variableCount: resolveVariableRows(shortcut, PROTOTYPE_MENTION_CATALOG).length,
        })),
    [context, removed, shortcuts]
  );

  return (
    <div className={cn(settingContainerClass, className)}>
      <p className="text-xs leading-snug text-muted-foreground">
        Saved prompts you can call with a slash command. Each one says where it applies — a Shortcut
        with nothing set works anywhere in this workspace.
      </p>

      <section className="flex flex-col">
        <div className="flex items-center justify-between gap-2 pb-1 pt-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground">Prompt Shortcuts</h3>
            <span className="text-xs tabular-nums text-muted-foreground/70">{rows.length}</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                aria-label="Add Prompt Shortcut"
                onClick={() => setEditing(createBlankShortcut())}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add Prompt Shortcut</TooltipContent>
          </Tooltip>
        </div>

        <div className="space-y-2">
          {rows.map((row) => (
            <PromptShortcutRowPrototype
              key={row.shortcut.id}
              shortcut={row.shortcut}
              eligibility={row.eligibility}
              variableCount={row.variableCount}
              onOpen={() => setEditing(row.shortcut)}
              onRemove={() => setRemoved((current) => [...current, row.shortcut.id])}
            />
          ))}
        </div>
      </section>

      <Dialog open={editing !== null} onOpenChange={(open) => (open ? null : setEditing(null))}>
        <DialogContent className="max-h-[85vh] max-w-[720px] overflow-y-auto p-0">
          <DialogTitle className="sr-only">Edit Prompt Shortcut</DialogTitle>
          <DialogDescription className="sr-only">
            Prototype editor for a workspace Prompt Shortcut.
          </DialogDescription>
          {editing ? (
            <PromptShortcutEditorPrototype
              key={editing.id}
              initialShortcut={editing}
              onClose={() => setEditing(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
