import { useDeferredValue, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LocalProjectId, MachineId } from '@lody/shared';
import {
  ArrowUpRight,
  Check,
  CircleSlash2,
  FolderOpen,
  FolderPlus,
  Github,
  LockKeyhole,
  Search,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

function GitHubOwnerAvatarIcon({ repoFullName }: { repoFullName: string }) {
  const ownerHandle = (repoFullName.split('/')[0] ?? '').trim();
  const [failed, setFailed] = useState(false);

  if (!ownerHandle || failed) {
    return <Github className="h-4 w-4 shrink-0 opacity-70" />;
  }

  return (
    <CachedAvatarImg
      src={getGitHubOwnerAvatarUrl(ownerHandle)}
      alt=""
      aria-hidden="true"
      className="h-4 w-4 shrink-0 rounded-sm object-cover"
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
  | { kind: 'github'; repoFullName: string };

type UnifiedProjectOption = {
  value: string;
  label: string;
  description?: string;
  icon: ReactNode;
  selection: Exclude<UnifiedProjectSelection, { kind: 'none' }>;
  lastUsedAt?: number;
  sharing?: SessionSharingState;
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
>(
  options: readonly TOption[],
  query: string,
  limit?: number
): TOption[] {
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

export interface UnifiedProjectSelectorViewProps
  extends Omit<
    UnifiedProjectSelectorProps,
    'selectedMachineId' | 'latestMessageAtByLocalProject' | 'projectSharing'
  > {
  localProjects: ReadonlyArray<UnifiedLocalProjectOption>;
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
  const sharedClassName = cn(
    'inline-flex shrink-0 select-none items-center gap-1 text-muted-foreground',
    variant === 'trigger' &&
      'h-6 rounded-r-md border-l border-border/60 bg-input/60 px-2 text-[0.66rem] font-medium transition-colors dark:bg-foreground/[0.08]',
    variant === 'option' && 'text-[0.68rem] font-medium',
    'text-foreground/75',
    isAction &&
      'cursor-pointer hover:bg-input hover:text-foreground dark:hover:bg-foreground/[0.12]',
    variant === 'trigger' &&
      'outline-hidden focus-visible:relative focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring/50'
  );
  const content = isAction ? (
    <button
      type="button"
      className={sharedClassName}
      aria-label={`${title}: ${description}. ${t(
        'workspace.projects.shareProjectAction',
        'Share project'
      )}`}
      onClick={onShare}
    >
      <LockKeyhole className="h-3 w-3" aria-hidden="true" />
      <span>{label}</span>
    </button>
  ) : (
    <span tabIndex={variant === 'trigger' ? 0 : undefined} className={sharedClassName}>
      <LockKeyhole className="h-3 w-3" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent
        side={variant === 'trigger' ? 'top' : 'right'}
        className="max-w-72 px-2.5 py-2"
      >
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </TooltipContent>
    </Tooltip>
  );
}

function getSelectionValue(selection: UnifiedProjectSelection): string | null {
  switch (selection.kind) {
    case 'local':
      return `local:${selection.machineId}:${selection.localProjectId}`;
    case 'github':
      return `github:${selection.repoFullName}`;
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
}: UnifiedProjectSelectorViewProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pendingProjectShare, setPendingProjectShare] = useState<UnifiedProjectOption | null>(null);
  const [isSharingProject, setIsSharingProject] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const options = useMemo<UnifiedProjectOption[]>(() => {
    const combined: UnifiedProjectOption[] = [];
    for (const project of localProjects) {
      combined.push({
        value: `local:${project.machineId}:${project.localProjectId}`,
        label: project.name,
        description: project.rootPath,
        icon: <FolderOpen className="h-4 w-4 shrink-0 opacity-70" />,
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
  }, [latestMessageAtByRepo, localProjects, repositories]);

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
    ) : (
      <FolderOpen className="h-4 w-4 opacity-70" />
    ));
  const triggerLabel =
    selectedOption?.label ??
    (value.kind === 'github'
      ? value.repoFullName
      : value.kind === 'local'
        ? value.localProjectId
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

  return (
    <div
      className={cn(
        'group/project relative flex min-w-0 items-center',
        isPropertyRow && 'w-full'
      )}
    >
      {value.kind !== 'none' && !isPropertyRow ? (
        <button
          type="button"
          onClick={() => {
            onChange({ kind: 'none' });
            setOpen(false);
          }}
          aria-label={clearLabel}
          className={cn(
            'absolute left-2 z-10 flex h-4 w-4 items-center justify-center rounded-full',
            'text-muted-foreground opacity-0 transition-opacity hover:bg-hover hover:text-foreground',
            'group-hover/project:opacity-100 group-focus-within/project:opacity-100'
          )}
        >
          <X className="h-3 w-3" />
        </button>
      ) : null}
      <DropdownMenu
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            requestAnimationFrame(() => searchInputRef.current?.focus());
          } else {
            setQuery('');
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              isPropertyRow
                ? [
                    'flex h-8 w-full min-w-0 max-w-none items-center gap-2 rounded-md px-2',
                    'text-[13px] font-normal transition-colors',
                    'bg-transparent text-foreground hover:bg-hover',
                    'data-[state=open]:bg-hover',
                    '[&_svg]:text-current [&_svg]:opacity-70',
                    value.kind === 'none' && 'text-muted-foreground',
                  ]
                : [
                    'flex h-6 min-w-0 max-w-[18rem] items-center gap-1.5 rounded-md bg-input/60 px-2 dark:bg-foreground/[0.08]',
                    'text-xs font-normal text-foreground/80 transition-colors hover:bg-input hover:text-foreground dark:hover:bg-foreground/[0.12] [&_svg]:text-current [&_svg]:opacity-100',
                    'data-[state=open]:bg-input data-[state=open]:text-foreground dark:data-[state=open]:bg-foreground/[0.12]',
                    selectedPrivateSharing && 'rounded-r-none',
                  ],
              className
            )}
          >
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center',
                !isPropertyRow &&
                  value.kind !== 'none' &&
                  'transition-opacity group-hover/project:opacity-0 group-focus-within/project:opacity-0'
              )}
            >
              {triggerIcon}
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={contentSide}
          align="start"
          avoidCollisions={contentSide === 'bottom'}
          className={cn('w-[min(20rem,calc(100vw-2rem))]', contentClassName)}
          style={contentStyle}
        >
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') event.stopPropagation();
              }}
              placeholder={t('chat.projectPicker.searchPlaceholder', 'Search projects')}
              className="h-8 border-border/50 bg-background/45 pl-8 text-xs shadow-none"
            />
          </div>
          <div className="scrollbar-pro max-h-[min(50vh,13rem)] overflow-y-auto">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                // Local projects show only the name; the path lives in a hover
                // tooltip. GitHub repos keep their inline description line.
                const localPath =
                  option.selection.kind === 'local' ? option.description : undefined;
                const inlineDescription =
                  option.selection.kind === 'github' ? option.description : undefined;
                const labelNode = (
                  <span className={cn('truncate', option.value === selectedValue && 'font-medium')}>
                    {option.label}
                  </span>
                );
                return (
                  <DropdownMenuItem
                    key={option.value}
                    onSelect={() => onChange(option.selection)}
                    className={cn(
                      'gap-2 py-1.5',
                      inlineDescription ? 'items-start' : 'items-center'
                    )}
                  >
                    <span className={cn('shrink-0', inlineDescription && 'mt-0.5')}>
                      {option.icon}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      {localPath ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{labelNode}</TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[22rem] break-all">
                            {localPath}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        labelNode
                      )}
                      {inlineDescription ? (
                        <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                          {inlineDescription}
                        </span>
                      ) : null}
                    </span>
                    {shouldShowPrivateSharingStatus(option.sharing) ? (
                      <ProjectAccessStatus state={option.sharing} variant="option" />
                    ) : null}
                    {option.value === selectedValue ? (
                      <Check
                        className={cn('h-3.5 w-3.5 shrink-0', inlineDescription && 'mt-0.5')}
                        aria-hidden="true"
                      />
                    ) : null}
                  </DropdownMenuItem>
                );
              })
            ) : (
              <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
                {t('chat.projectPicker.emptyText', 'No projects found')}
              </div>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange({ kind: 'none' })}>
            <CircleSlash2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{clearLabel}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddLocalProject}>
            <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{t('chat.contextSwitch.addProject', 'Add a folder')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onConnectGitRepo}>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{t('repos.connectMore', 'Connect more GitHub projects')}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
