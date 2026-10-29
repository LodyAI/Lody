import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  ArrowUpRight,
  Folders,
  ChevronDown,
  CircleSlash2,
  FolderOpen,
  FolderPlus,
  Github,
  LockKeyhole,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { tooltip } from '@lody/ui/tooltip/tooltip.tokens.stylex';
import { toast } from '@/lib/toast';

import { useConvexErrorMessage } from '@/hooks/use-convex-error-message';
import { useVisibleLocalProjects } from '@/hooks/use-visible-local-projects';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { getSessionSharingDescription, ProjectShareDialog } from '@/components/session-sharing';
import { getGitHubOwnerAvatarUrl } from '@/lib/github-avatar';
import {
  resolveLocalProjectSharingState,
  shouldShowPrivateSharingStatus,
  type SessionSharingState,
} from '@/lib/session-sharing';
import type { MachineVisibilityAccess } from '@/lib/visible-machine-index';
import type { VisibleLocalProjectIndex } from '@/lib/visible-local-project-index';
import { cn } from '@/lib/utils';
import { contextPill } from './context-pill-class';
import { Menu, MenuSearchInput } from '@/ui/menu';
import { Tooltip } from '@lody/ui/tooltip';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeRadius, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  projectPathTooltip: { [tooltip.maxWidth]: '22rem', wordBreak: 'break-all' },
  tooltipPadding: {
    [tooltip.paddingX]: 'calc(var(--spacing) * 2.5)',
    [tooltip.paddingY]: 'calc(var(--spacing) * 2)',
  },
  groupGlyph: {
    width: 'calc(var(--spacing) * 4)',
    height: 'calc(var(--spacing) * 4)',
    opacity: 0.7,
  },
  groupOwnerGlyph: { flexShrink: 0 },
  /* The owner mark beside a project name. */
  ownerGlyph: { width: themeSpace[4], height: themeSpace[4], flexShrink: 0, opacity: 0.7 },
  ownerAvatar: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    borderRadius: themeRadius.sm,
    objectFit: 'cover',
  },
  folderGlyph: { width: themeSpace[4], height: themeSpace[4], opacity: 0.7 },
  lockGlyph: { width: themeSpace[3], height: themeSpace[3] },

  /* The access badge: "Private", and the action that shares the project. */
  accessStatus: {
    display: 'inline-flex',
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    color: 'hsl(var(--foreground) / 0.75)',
  },
  accessStatusTrigger: {
    height: themeSpace[6],
    borderTopRightRadius: themeRadius.md,
    borderBottomRightRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    fontSize: '0.8em',
    fontWeight: themeFontWeight.medium,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  accessStatusOption: { fontSize: '0.8em', fontWeight: themeFontWeight.medium },
  accessStatusAction: {
    cursor: 'pointer',
    color: { default: 'hsl(var(--foreground) / 0.75)', ':hover': themeColors.foreground },
  },
  /**
   * The focus state: the badge comes forward so its own ring is not clipped.
   * The focus ring itself is a Tailwind `focus-visible:ring-*`, which paints
   * nothing (the app zeroes Tailwind's ring shadow on focus), so it is not
   * restated here.
   */
  accessStatusFocus: {
    position: { default: 'static', ':focus-visible': 'relative' },
    zIndex: { default: 'auto', ':focus-visible': 20 },
  },
  accessTitle: { fontWeight: themeFontWeight.medium },
  accessDescription: {
    marginTop: themeSpace[0.5],
    fontSize: '0.8em',
    color: themeColors.mutedForeground,
  },

  /* The selector's own row. */
  row: { position: 'relative', display: 'flex', minWidth: 0, alignItems: 'center' },
  rowFull: { width: '100%' },
  clear: {
    position: 'absolute',
    left: themeSpace[2],
    zIndex: 10,
    display: 'flex',
    height: themeSpace[4],
    width: themeSpace[4],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
    backgroundColor: { default: 'transparent', ':hover': themeColors.hover },
    opacity: {
      default: 0,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-unified-project-row]):hover')]: 1,
      },
      [stylex.when.ancestor(':is([data-unified-project-row]):focus-within')]: 1,
    },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  clearGlyph: { width: themeSpace[3], height: themeSpace[3] },

  /* The trigger's own face. */
  triggerPropertyRow: {
    display: 'flex',
    height: themeSpace[8],
    width: '100%',
    minWidth: 0,
    maxWidth: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    fontSize: '1em',
    fontWeight: themeFontWeight.normal,
    color: themeColors.foreground,
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The first property-row face: the pointer's fill, and the same while open. */
  triggerPropertyRowHover: {
    backgroundColor: {
      default: 'transparent',
      ':hover': themeColors.hover,
      ':is([data-state="open"])': themeColors.hover,
    },
  },
  /**
   * The second property-row face: a faint ink wash instead of the pointer's
   * fill. Its dark step is a hard-coded white, so it stays a Tailwind class.
   */
  triggerPropertyRowInk: {
    backgroundColor: {
      default: 'transparent',
      ':hover': 'hsl(var(--foreground) / 0.05)',
      ':is([data-state="open"])': 'hsl(var(--foreground) / 0.05)',
    },
  },
  triggerChip: {
    display: 'flex',
    height: themeSpace[6],
    minWidth: 0,
    maxWidth: '18rem',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    fontSize: '0.9em',
    fontWeight: themeFontWeight.normal,
    color: { default: 'hsl(var(--foreground) / 0.8)', ':hover': themeColors.foreground },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The chip shares the badge's half, so it loses its right corners. */
  triggerChipShared: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
  triggerEmpty: { color: themeColors.mutedForeground },
  triggerGlyph: {
    display: 'flex',
    height: themeSpace[4],
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  triggerGlyphFade: {
    opacity: {
      default: 1,
      '@media (hover: hover)': {
        [stylex.when.ancestor(':is([data-unified-project-row]):hover')]: 0,
      },
      [stylex.when.ancestor(':is([data-unified-project-row]):focus-within')]: 0,
    },
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  triggerLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  triggerChevron: { width: themeSpace[3.5], height: themeSpace[3.5], flexShrink: 0 },

  /* The list the trigger opens. */
  list: { maxHeight: 'min(50vh, 13rem)', overflowY: 'auto' },
  optionLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  optionLabelSelected: { fontWeight: themeFontWeight.medium },
  optionIcon: { flexShrink: 0 },
  optionIconWithDescription: { marginTop: '0.5px' },
  optionBody: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
  },
  optionDescription: {
    overflow: 'hidden',
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    fontSize: '0.8em',
    lineHeight: '1.375',
    color: themeColors.mutedForeground,
  },
  empty: {
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[5],
    textAlign: 'center',
    fontSize: '0.9em',
    color: themeColors.mutedForeground,
  },
});

function GitHubOwnerAvatarIcon({ repoFullName }: { repoFullName: string }) {
  const ownerHandle = (repoFullName.split('/')[0] ?? '').trim();
  const [failed, setFailed] = useState(false);

  if (!ownerHandle || failed) {
    return <Github {...stylex.props(styles.ownerGlyph)} />;
  }

  return (
    <CachedAvatarImg
      src={getGitHubOwnerAvatarUrl(ownerHandle)}
      alt=""
      aria-hidden="true"
      className={stylex.props(styles.ownerAvatar).className}
      onError={() => setFailed(true)}
    />
  );
}

export interface LocalProjectSelection {
  machineId: MachineId;
  localProjectId: LocalProjectId;
}

export type UnifiedProjectSelection =
  | { kind: 'none' }
  | ({ kind: 'local' } & LocalProjectSelection)
  | { kind: 'github'; repoFullName: string }
  | { kind: 'group'; projectId: string };

/** A Project group offered beside single projects. */
export type UnifiedProjectGroupOption = {
  projectId: string;
  name: string;
  /** Number of repositories, shown as the option's description. */
  memberCount: number;
  lastUsedAt?: number;
  /** Why this group cannot start a conversation on the selected machine. */
  disabledReason?: string;
  /** What the selected machine lacks, e.g. "2 cloned on start". */
  availability?: string;
};

type UnifiedProjectOption = {
  value: string;
  label: string;
  description?: string;
  icon: ReactNode;
  selection: Exclude<UnifiedProjectSelection, { kind: 'none' }>;
  lastUsedAt?: number;
  sharing?: SessionSharingState;
  disabledReason?: string;
};

export const UNIFIED_PROJECT_OPTION_RENDER_LIMIT = 20;

export type UnifiedLocalProjectOption = {
  key: string;
  machineId: MachineId;
  localProjectId: LocalProjectId;
  name: string;
  rootPath: string;
  lastUsedAt?: number;
  sharing?: SessionSharingState;
};

export function compareUnifiedProjectOptions(
  left: Pick<UnifiedProjectOption, 'label' | 'value' | 'lastUsedAt'>,
  right: Pick<UnifiedProjectOption, 'label' | 'value' | 'lastUsedAt'>
): number {
  if (left.lastUsedAt !== undefined && right.lastUsedAt !== undefined) {
    if (left.lastUsedAt !== right.lastUsedAt) return right.lastUsedAt - left.lastUsedAt;
  } else if (left.lastUsedAt !== undefined) {
    return -1;
  } else if (right.lastUsedAt !== undefined) {
    return 1;
  }
  const labelComparison = left.label.localeCompare(right.label);
  return labelComparison !== 0 ? labelComparison : left.value.localeCompare(right.value);
}

function selectUnifiedProjectOptionsForRender<
  TOption extends Pick<UnifiedProjectOption, 'label' | 'description' | 'selection'>,
>(options: readonly TOption[], query: string, limit?: number): TOption[] {
  if (limit !== undefined && limit <= 0) return [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible: TOption[] = [];
  for (const option of options) {
    if (
      normalizedQuery &&
      !`${option.label} ${option.description ?? ''} ${option.selection.kind}`
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    ) {
      continue;
    }
    visible.push(option);
  }
  if (limit === undefined || visible.length <= limit) return visible;

  const selectedIndexes = new Set(Array.from({ length: limit }, (_, index) => index));
  if (!normalizedQuery) {
    const selectedKindCounts = new Map<string, number>();
    for (const index of selectedIndexes) {
      const kind = visible[index]?.selection.kind;
      if (kind) selectedKindCounts.set(kind, (selectedKindCounts.get(kind) ?? 0) + 1);
    }

    const firstIndexByKind = new Map<string, number>();
    visible.forEach((option, index) => {
      if (!firstIndexByKind.has(option.selection.kind)) {
        firstIndexByKind.set(option.selection.kind, index);
      }
    });
    for (const [missingKind, missingIndex] of firstIndexByKind) {
      if ((selectedKindCounts.get(missingKind) ?? 0) > 0) continue;
      const replaceIndex = Array.from(selectedIndexes)
        .reverse()
        .find((index) => {
          const selectedKind = visible[index]?.selection.kind;
          return selectedKind && (selectedKindCounts.get(selectedKind) ?? 0) > 1;
        });
      if (replaceIndex === undefined) continue;
      const replacedKind = visible[replaceIndex]?.selection.kind;
      selectedIndexes.delete(replaceIndex);
      selectedIndexes.add(missingIndex);
      if (replacedKind) {
        selectedKindCounts.set(replacedKind, (selectedKindCounts.get(replacedKind) ?? 1) - 1);
      }
      selectedKindCounts.set(missingKind, 1);
    }
  }

  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => visible[index]!);
}

interface UnifiedProjectSelectorProps {
  value: UnifiedProjectSelection;
  onChange: (selection: UnifiedProjectSelection) => void;
  selectedMachineId: MachineId | null;
  repositories?: ReadonlyArray<{ fullName: string; description?: string | null }>;
  className?: string;
  latestMessageAtByRepo?: ReadonlyMap<string, number>;
  latestMessageAtByLocalProject?: ReadonlyMap<string, number>;
  onAddLocalProject: () => void;
  onConnectGitRepo: () => void;
  projectSharing?: {
    currentUserId: string | null;
    machineAccessByMachineId: ReadonlyMap<MachineId, MachineVisibilityAccess>;
    onShareWithTeam: (selection: LocalProjectSelection) => Promise<void>;
  };
}

type UnifiedProjectSharingContext = Pick<
  NonNullable<UnifiedProjectSelectorProps['projectSharing']>,
  'currentUserId' | 'machineAccessByMachineId'
>;

export function buildUnifiedLocalProjectOptions({
  visibleLocalProjects,
  selectedMachineId,
  latestMessageAtByLocalProject,
  projectSharing,
}: {
  visibleLocalProjects: Pick<
    VisibleLocalProjectIndex,
    'projects' | 'accessByProjectKey' | 'isLoading'
  >;
  selectedMachineId: MachineId | null;
  latestMessageAtByLocalProject?: ReadonlyMap<string, number>;
  projectSharing?: UnifiedProjectSharingContext;
}): UnifiedLocalProjectOption[] {
  const visible: UnifiedLocalProjectOption[] = [];
  for (const entry of visibleLocalProjects.projects.values()) {
    if (entry.machineId !== selectedMachineId) continue;
    visible.push({
      key: entry.key,
      machineId: entry.machineId,
      localProjectId: entry.project.id,
      name: entry.project.name,
      rootPath: entry.project.rootPath,
      lastUsedAt:
        latestMessageAtByLocalProject?.get(entry.key) ??
        entry.project.lastOpenedAtMs ??
        entry.project.createdAtMs ??
        undefined,
      sharing: projectSharing
        ? resolveLocalProjectSharingState({
            machineId: entry.machineId,
            localProjectId: entry.project.id,
            currentUserId: projectSharing.currentUserId,
            machineAccessByMachineId: projectSharing.machineAccessByMachineId,
            localProjectAccessByKey: visibleLocalProjects.accessByProjectKey,
            machineName: entry.machine.name,
            projectName: entry.project.name,
            isLoading: visibleLocalProjects.isLoading,
          })
        : undefined,
    });
  }
  return visible;
}

export interface UnifiedProjectSelectorViewProps extends Omit<
  UnifiedProjectSelectorProps,
  'selectedMachineId' | 'latestMessageAtByLocalProject' | 'projectSharing'
> {
  localProjects: ReadonlyArray<UnifiedLocalProjectOption>;
  /** Project groups; omitted by surfaces that cannot start multi-repository work. */
  projectGroups?: ReadonlyArray<UnifiedProjectGroupOption>;
  onShareLocalProjectWithTeam?: (selection: LocalProjectSelection) => Promise<void>;
  getShareErrorMessage?: (error: unknown, fallback: string) => string;
  /**
   * Where the menu opens relative to the trigger. Chat landing keeps `top`
   * (footer chrome); task surfaces open `bottom` so the list falls into the
   * page rather than covering the property rail above.
   */
  contentSide?: 'top' | 'bottom';
  /**
   * `chip` — compact pill used on chat landing.
   * `property-row` — full-width ghost row matching Linear-style property rails
   * (task detail sidebar). Same searchable menu either way.
   */
  triggerVariant?: 'chip' | 'property-row';
  /** Extra classes for the portaled menu (e.g. Tasks cooler menu surface). */
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  /**
   * Maximum rendered options. The default view reserves a slot for every
   * available source, while search still evaluates the complete option list.
   */
  renderLimit?: number;
  /** Opens the project creator; omitted by surfaces that cannot start multi-repository work. */
  onCreateProject?: () => void;
}

function ProjectAccessStatus({
  state,
  variant,
  onShare,
}: {
  state: SessionSharingState;
  variant: 'trigger' | 'option';
  onShare?: () => void;
}) {
  const { t } = useTranslation();

  if (!shouldShowPrivateSharingStatus(state)) {
    return null;
  }

  const label = t('sessions.sharing.private', 'Private');
  const title = t('sessions.sharing.privateToYou', 'Private to you');
  const description = getSessionSharingDescription(t, state);
  const isAction = variant === 'trigger' && Boolean(onShare);
  // The badge's own face. The focus ring is a Tailwind `focus-visible:ring-*`,
  // which paints nothing, so it is not restated; the focus state that raises
  // the badge is.
  const accessTrigger = variant === 'trigger' && styles.accessStatusTrigger;
  const accessOption = variant === 'option' && styles.accessStatusOption;
  const accessFocus = variant === 'trigger' && styles.accessStatusFocus;
  const accessAction = isAction && styles.accessStatusAction;
  const content = isAction ? (
    <button
      type="button"
      {...stylex.props(
        contextPill.surface,
        contextPill.interactive,
        styles.accessStatus,
        accessTrigger,
        accessOption,
        accessAction,
        accessFocus
      )}
      aria-label={`${title}: ${description}. ${t(
        'workspace.projects.shareProjectAction',
        'Share project'
      )}`}
      onClick={onShare}
    >
      <LockKeyhole {...stylex.props(styles.lockGlyph)} aria-hidden="true" />
      <span>{label}</span>
    </button>
  ) : (
    <span
      tabIndex={variant === 'trigger' ? 0 : undefined}
      {...stylex.props(
        variant === 'trigger' && contextPill.surface,
        styles.accessStatus,
        accessTrigger,
        accessOption,
        accessAction,
        accessFocus
      )}
    >
      <LockKeyhole {...stylex.props(styles.lockGlyph)} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );

  return (
    <Tooltip.Root>
      <Tooltip.Trigger delay={300} render={content} />
      <Tooltip.Content
        side={variant === 'trigger' ? 'top' : 'right'}
        className={cn(stylex.props(styles.tooltipPadding).className, 'max-w-72')}
      >
        <div {...stylex.props(styles.accessTitle)}>{title}</div>
        <div {...stylex.props(styles.accessDescription)}>{description}</div>
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

function getSelectionValue(selection: UnifiedProjectSelection): string | null {
  switch (selection.kind) {
    case 'local':
      return `local:${selection.machineId}:${selection.localProjectId}`;
    case 'github':
      return `github:${selection.repoFullName}`;
    case 'group':
      return `group:${selection.projectId}`;
    case 'none':
      return null;
  }
  return null;
}

export function UnifiedProjectSelector({
  value,
  onChange,
  selectedMachineId,
  repositories,
  className,
  latestMessageAtByRepo,
  latestMessageAtByLocalProject,
  onAddLocalProject,
  onConnectGitRepo,
  projectSharing,
}: UnifiedProjectSelectorProps) {
  const visibleLocalProjects = useVisibleLocalProjects();
  const getShareErrorMessage = useConvexErrorMessage();
  const localProjects = useMemo(
    () =>
      buildUnifiedLocalProjectOptions({
        visibleLocalProjects,
        selectedMachineId,
        latestMessageAtByLocalProject,
        projectSharing,
      }),
    [latestMessageAtByLocalProject, projectSharing, selectedMachineId, visibleLocalProjects]
  );

  return (
    <UnifiedProjectSelectorView
      value={value}
      onChange={onChange}
      localProjects={localProjects}
      repositories={repositories}
      className={className}
      latestMessageAtByRepo={latestMessageAtByRepo}
      onAddLocalProject={onAddLocalProject}
      onConnectGitRepo={onConnectGitRepo}
      onShareLocalProjectWithTeam={projectSharing?.onShareWithTeam}
      getShareErrorMessage={getShareErrorMessage}
    />
  );
}

export function UnifiedProjectSelectorView({
  value,
  onChange,
  localProjects,
  projectGroups,
  repositories,
  className,
  latestMessageAtByRepo,
  onAddLocalProject,
  onConnectGitRepo,
  onShareLocalProjectWithTeam,
  getShareErrorMessage,
  contentSide = 'top',
  triggerVariant = 'chip',
  contentClassName,
  contentStyle,
  renderLimit,
  onCreateProject,
}: UnifiedProjectSelectorViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingProjectShare, setPendingProjectShare] = useState<UnifiedProjectOption | null>(null);
  const [isSharingProject, setIsSharingProject] = useState(false);
  const deferredQuery = useDeferredValue(query);

  const options = useMemo<UnifiedProjectOption[]>(() => {
    const combined: UnifiedProjectOption[] = [];
    for (const group of projectGroups ?? []) {
      combined.push({
        value: `group:${group.projectId}`,
        label: group.name,
        description:
          group.disabledReason ??
          [
            t('chat.projectPicker.groupMembers', '{{count}} repositories', {
              count: group.memberCount,
            }),
            group.availability,
          ]
            .filter(Boolean)
            .join(' · '),
        icon: <Folders {...stylex.props(styles.groupGlyph, styles.groupOwnerGlyph)} />,
        selection: { kind: 'group', projectId: group.projectId },
        lastUsedAt: group.lastUsedAt,
        disabledReason: group.disabledReason,
      });
    }
    for (const project of localProjects) {
      combined.push({
        value: `local:${project.machineId}:${project.localProjectId}`,
        label: project.name,
        description: project.rootPath,
        icon: <FolderOpen {...stylex.props(styles.ownerGlyph)} />,
        selection: {
          kind: 'local',
          machineId: project.machineId,
          localProjectId: project.localProjectId,
        },
        lastUsedAt: project.lastUsedAt,
        sharing: project.sharing,
      });
    }
    for (const repository of repositories ?? []) {
      combined.push({
        value: `github:${repository.fullName}`,
        label: repository.fullName,
        description: repository.description ?? undefined,
        icon: <GitHubOwnerAvatarIcon repoFullName={repository.fullName} />,
        selection: { kind: 'github', repoFullName: repository.fullName },
        lastUsedAt: latestMessageAtByRepo?.get(repository.fullName),
      });
    }
    return combined.sort(compareUnifiedProjectOptions);
  }, [latestMessageAtByRepo, localProjects, projectGroups, repositories, t]);

  const selectedValue = getSelectionValue(value);
  const selectedOption = useMemo(
    () => options.find((option) => option.value === selectedValue),
    [options, selectedValue]
  );
  const filteredOptions = useMemo(() => {
    return selectUnifiedProjectOptionsForRender(options, deferredQuery, renderLimit);
  }, [deferredQuery, options, renderLimit]);

  const clearLabel = t('chat.projectPicker.clear', "Don't work in a project");
  const placeholder = t('chat.projectPicker.placeholder', 'Select a project');
  const triggerIcon =
    selectedOption?.icon ??
    (value.kind === 'github' ? (
      <GitHubOwnerAvatarIcon repoFullName={value.repoFullName} />
    ) : value.kind === 'group' ? (
      <Folders {...stylex.props(styles.groupGlyph)} />
    ) : (
      <FolderOpen {...stylex.props(styles.folderGlyph)} />
    ));
  const triggerLabel =
    selectedOption?.label ??
    (value.kind === 'github'
      ? value.repoFullName
      : value.kind === 'local'
        ? value.localProjectId
        : value.kind === 'group'
          ? t('chat.projectPicker.removedGroup', 'Removed project group')
          : placeholder);
  const selectedSharing =
    selectedOption?.selection.kind === 'local' ? selectedOption.sharing : undefined;
  const selectedPrivateSharing = shouldShowPrivateSharingStatus(selectedSharing)
    ? selectedSharing
    : undefined;
  const canShareSelectedProject = Boolean(
    selectedOption &&
    selectedPrivateSharing?.canManage &&
    selectedPrivateSharing.privateReason !== 'machine-not-registered' &&
    onShareLocalProjectWithTeam
  );

  const isPropertyRow = triggerVariant === 'property-row';

  // Preserve the inherited SVG override for caller/owner glyphs, including
  // avatar fallbacks; these marks are also rendered in the menu's options.
  const triggerTailwind = isPropertyRow
    ? '[&_svg]:text-current [&_svg]:opacity-70'
    : '[&_svg]:text-current [&_svg]:opacity-100';
  return (
    <div
      data-unified-project-row=""
      {...stylex.props(stylex.defaultMarker(), styles.row, isPropertyRow && styles.rowFull)}
    >
      {value.kind !== 'none' && !isPropertyRow ? (
        <button
          type="button"
          onClick={() => {
            onChange({ kind: 'none' });
            setOpen(false);
          }}
          aria-label={clearLabel}
          {...stylex.props(styles.clear)}
        >
          <X {...stylex.props(styles.clearGlyph)} />
        </button>
      ) : null}
      <Menu.Root
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) setQuery('');
        }}
      >
        <Menu.Trigger
          render={
            <button
              type="button"
              className={[
                stylex.props(
                  !isPropertyRow && contextPill.surface,
                  !isPropertyRow && contextPill.interactive,
                  !isPropertyRow && open && contextPill.open,
                  isPropertyRow && styles.triggerPropertyRow,
                  isPropertyRow && styles.triggerPropertyRowHover,
                  !isPropertyRow && styles.triggerChip,
                  !isPropertyRow && selectedPrivateSharing && styles.triggerChipShared,
                  value.kind === 'none' && styles.triggerEmpty
                ).className,
                triggerTailwind,
                className,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <span
                {...stylex.props(
                  styles.triggerGlyph,
                  !isPropertyRow && value.kind !== 'none' && styles.triggerGlyphFade
                )}
              >
                {triggerIcon}
              </span>
              <span {...stylex.props(styles.triggerLabel)}>{triggerLabel}</span>
            </button>
          }
        >
          <button
            type="button"
            className={[
              stylex.props(
                !isPropertyRow && contextPill.surface,
                !isPropertyRow && contextPill.interactive,
                !isPropertyRow && open && contextPill.open,
                isPropertyRow && styles.triggerPropertyRow,
                isPropertyRow && styles.triggerPropertyRowInk,
                !isPropertyRow && styles.triggerChip,
                !isPropertyRow && selectedPrivateSharing && styles.triggerChipShared,
                value.kind === 'none' && styles.triggerEmpty
              ).className,
              triggerTailwind,
              // The ink wash's dark step is a hard-coded white, so it stays a
              // Tailwind class.
              isPropertyRow
                ? 'dark:hover:bg-white/[0.08] dark:data-[state=open]:bg-white/[0.08]'
                : undefined,
              className,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <span
              {...stylex.props(
                styles.triggerGlyph,
                !isPropertyRow && value.kind !== 'none' && styles.triggerGlyphFade
              )}
            >
              {triggerIcon}
            </span>
            <span {...stylex.props(styles.triggerLabel)}>{triggerLabel}</span>
            {isPropertyRow ? (
              <ChevronDown
                // `!opacity-50` is an important utility; StyleX cannot state
                // `!important`, and the parent's own glyph rule would win over
                // a plain opacity.
                className={[stylex.props(styles.triggerChevron).className, '!opacity-50']
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              />
            ) : null}
          </button>
        </Menu.Trigger>
        <Menu.Content
          side={contentSide}
          align="start"
          collisionAvoidance={
            contentSide === 'bottom'
              ? undefined
              : { side: 'none', align: 'none', fallbackAxisSide: 'none' }
          }
          className={cn('w-[min(20rem,calc(100vw-2rem))]', contentClassName)}
          style={contentStyle}
        >
          <MenuSearchInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('chat.projectPicker.searchPlaceholder', 'Search projects')}
            className="mb-1 h-8 rounded-md border border-border/50 bg-input-field py-0"
          />
          <div
            className={['scrollbar-pro', stylex.props(styles.list).className]
              .filter(Boolean)
              .join(' ')}
          >
            {filteredOptions.length > 0 ? (
              <Menu.RadioGroup
                value={selectedValue ?? ''}
                onValueChange={(nextValue) => {
                  const target = filteredOptions.find((option) => option.value === nextValue);
                  if (target) onChange(target.selection);
                }}
              >
                {filteredOptions.map((option) => {
                  // Local and GitHub projects show only the name; local paths
                  // live in a hover tooltip. Groups keep their member summary.
                  const localPath =
                    option.selection.kind === 'local' ? option.description : undefined;
                  const inlineDescription =
                    option.selection.kind === 'group' ? option.description : undefined;
                  const labelNode = (
                    <span
                      {...stylex.props(
                        styles.optionLabel,
                        option.value === selectedValue && styles.optionLabelSelected
                      )}
                    >
                      {option.label}
                    </span>
                  );
                  return (
                    <Menu.RadioItem
                      key={option.value}
                      value={option.value}
                      disabled={option.disabledReason !== undefined}
                      indicator="check"
                      indicatorSide="end"
                      className={cn(
                        'gap-2 py-1.5',
                        inlineDescription ? 'items-start' : 'items-center'
                      )}
                    >
                      <span
                        {...stylex.props(
                          styles.optionIcon,
                          Boolean(inlineDescription) && styles.optionIconWithDescription
                        )}
                      >
                        {option.icon}
                      </span>
                      <span {...stylex.props(styles.optionBody)}>
                        {localPath ? (
                          <Tooltip.Root>
                            <Tooltip.Trigger render={labelNode} />
                            <Tooltip.Content
                              side="right"
                              className={stylex.props(styles.projectPathTooltip).className}
                            >
                              {localPath}
                            </Tooltip.Content>
                          </Tooltip.Root>
                        ) : (
                          labelNode
                        )}
                        {inlineDescription ? (
                          <span {...stylex.props(styles.optionDescription)}>
                            {inlineDescription}
                          </span>
                        ) : null}
                      </span>
                      {shouldShowPrivateSharingStatus(option.sharing) ? (
                        <ProjectAccessStatus state={option.sharing} variant="option" />
                      ) : null}
                    </Menu.RadioItem>
                  );
                })}
              </Menu.RadioGroup>
            ) : (
              <div {...stylex.props(styles.empty)}>
                {t('chat.projectPicker.emptyText', 'No projects found')}
              </div>
            )}
          </div>
          <Menu.Separator />
          <Menu.Item icon={CircleSlash2} onClick={() => onChange({ kind: 'none' })}>
            {clearLabel}
          </Menu.Item>
          {onCreateProject ? (
            <Menu.Item icon={Folders} onClick={onCreateProject}>
              {t('chat.projectPicker.createProject', 'Create project')}
            </Menu.Item>
          ) : null}
          <Menu.Item icon={FolderPlus} onClick={onAddLocalProject}>
            {t('chat.contextSwitch.addProject', 'Add a folder')}
          </Menu.Item>
          <Menu.Item icon={ArrowUpRight} onClick={onConnectGitRepo}>
            {t('repos.connectMore', 'Connect more GitHub projects')}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
      {selectedPrivateSharing ? (
        <ProjectAccessStatus
          state={selectedPrivateSharing}
          variant="trigger"
          onShare={
            canShareSelectedProject && selectedOption
              ? () => setPendingProjectShare(selectedOption)
              : undefined
          }
        />
      ) : null}
      <ProjectShareDialog
        open={pendingProjectShare !== null}
        state={pendingProjectShare?.sharing ?? null}
        isSharing={isSharingProject}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isSharingProject) setPendingProjectShare(null);
        }}
        onConfirm={() => {
          const pending = pendingProjectShare;
          if (!pending || pending.selection.kind !== 'local' || !onShareLocalProjectWithTeam) {
            return;
          }
          setIsSharingProject(true);
          void onShareLocalProjectWithTeam(pending.selection)
            .then(() => {
              toast.success(
                t(
                  'workspace.projects.sharedWithTeamToast',
                  '“{{project}}” is now shared with the team',
                  { project: pending.label }
                )
              );
              setPendingProjectShare(null);
            })
            .catch((error: unknown) => {
              const fallback = t('common.tryAgain', 'Please try again');
              toast.error(t('workspace.projects.shareFailed', 'Failed to update project sharing'), {
                description: getShareErrorMessage?.(error, fallback) ?? fallback,
              });
            })
            .finally(() => setIsSharingProject(false));
        }}
      />
    </div>
  );
}
