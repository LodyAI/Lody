import type { CSSProperties } from 'react';
import { Bot, FolderGit2, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { PromptShortcutScope } from '@lody/shared/prompt-shortcuts';
import { Badge } from '@lody/ui/badge';
import { space } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import type { ShortcutScopeOptions } from './prompt-shortcut-form';

const styles = stylex.create({
  pills: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
  },
  /** Layout only, for the badge: a long project name ends in an ellipsis inside the row. */
  pill: { maxWidth: '100%', minWidth: 0 },
});

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
  style,
}: {
  axis: ShortcutScopeAxis;
  className?: string;
  style?: CSSProperties;
}) {
  const Icon = AXIS_ICONS[axis];
  return <Icon className={className} style={style} aria-hidden="true" />;
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
      {...withClassName(stylex.props(styles.pills), className)}
      aria-label={t('settings.promptShortcuts.scope', 'Applies to')}
    >
      {pills.length === 0 ? (
        <Badge className={stylex.props(styles.pill).className}>
          {t('settings.promptShortcuts.workspaceScope', 'Workspace')}
        </Badge>
      ) : (
        pills.map((pill) => (
          <Badge
            key={`${pill.axis}:${pill.label}`}
            className={stylex.props(styles.pill).className}
            icon={<ScopeAxisIcon axis={pill.axis} />}
          >
            {pill.label}
          </Badge>
        ))
      )}
    </span>
  );
}
