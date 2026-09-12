import { Bot, FolderGit2, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PromptShortcutScope } from '@lody/shared/prompt-shortcuts';
import { cn } from '@/lib/utils';
import type { ShortcutScopeOptions } from './prompt-shortcut-form';

/**
 * The scope axes, shown the same way everywhere.
 *
 * A Radix `Select` cannot hold an empty value, so "unset" needs a sentinel —
 * and the list, which has no selectors, needs the same three labels as read-only
 * pills. Both live here so a pill and its selector can never disagree.
 */
export const SHORTCUT_SCOPE_NONE = '__none__';

export type ShortcutScopeAxis = 'project' | 'machine' | 'agent';

const AXIS_ICONS = { project: FolderGit2, machine: Monitor, agent: Bot } as const;

export function ScopeAxisIcon({
  axis,
  className,
}: {
  axis: ShortcutScopeAxis;
  className?: string;
}) {
  const Icon = AXIS_ICONS[axis];
  return <Icon className={className} aria-hidden="true" />;
}

/** Human label for a saved project reference, falling back to what it stores. */
export function describeShortcutProject(
  project: NonNullable<PromptShortcutScope['project']>,
  options?: ShortcutScopeOptions
): string {
  const match = options?.projects.find(
    (option) => JSON.stringify(option.value) === JSON.stringify(project)
  );
  if (match) return match.label;
  return project.kind === 'github' ? project.repository : project.id;
}

export function describeShortcutScope(
  scope: PromptShortcutScope,
  options?: ShortcutScopeOptions
): { axis: ShortcutScopeAxis; label: string }[] {
  const pills: { axis: ShortcutScopeAxis; label: string }[] = [];
  if (scope.project) {
    pills.push({ axis: 'project', label: describeShortcutProject(scope.project, options) });
  }
  if (scope.machineId) {
    pills.push({
      axis: 'machine',
      label:
        options?.machines.find((option) => option.value === scope.machineId)?.label ??
        scope.machineId,
    });
  }
  if (scope.providerKey) {
    pills.push({
      axis: 'agent',
      label:
        options?.providers.find((option) => option.value === scope.providerKey)?.label ??
        scope.providerKey,
    });
  }
  return pills;
}

/**
 * The author's scope, in the fixed Project → Machine → Agent order.
 *
 * All three unset prints one muted `Workspace` pill rather than nothing:
 * "applies anywhere in this workspace" is a decision, and blank space is not.
 * This is visibility-neutral — a `Workspace` pill never means "shared".
 */
export function ScopePills({
  scope,
  options,
  className,
}: {
  scope: PromptShortcutScope;
  options?: ShortcutScopeOptions;
  className?: string;
}) {
  const { t } = useTranslation();
  const pills = describeShortcutScope(scope, options);
  return (
    <span
      className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}
      aria-label={t('settings.promptShortcuts.scope', 'Applies to')}
    >
      {pills.length === 0 ? (
        <span className="inline-flex max-w-full items-center rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] leading-4 text-muted-foreground/70">
          {t('settings.promptShortcuts.workspaceScope', 'Workspace')}
        </span>
      ) : (
        pills.map((pill) => (
          <span
            key={`${pill.axis}:${pill.label}`}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] leading-4 text-muted-foreground"
          >
            <ScopeAxisIcon axis={pill.axis} className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{pill.label}</span>
          </span>
        ))
      )}
    </span>
  );
}
