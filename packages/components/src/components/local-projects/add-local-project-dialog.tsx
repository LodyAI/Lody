import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  FolderGit2,
  FolderPlus,
  HardDrive,
  Home,
  Loader2,
  Lock,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react';
import type {
  LocalProjectBrowseDirectoryEntry,
  LocalProjectBrowseDirectoryResult,
  LocalProjectBrowseRootsResult,
} from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { Input } from '@/ui/input';
import { Skeleton } from '@/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import {
  describeBrowseError,
  getTailPriorityBreadcrumbs,
  splitBreadcrumbs,
  splitPathForTailPriority,
  useRemoteDirectoryPicker,
  type RemoteDirectoryBrowseStatus,
  type RemoteDirectoryOps,
  type RemoteDirectoryPickerArgs,
  type RemoteDirectoryPickerMachine,
} from './use-remote-directory-picker';
import { MobileAddLocalProjectFlow } from './mobile-add-local-project-flow';

export type {
  RemoteDirectoryOpResult,
  RemoteDirectoryOps,
  RemoteDirectoryPickerMachine,
} from './use-remote-directory-picker';

/**
 * Desktop directory picker: a compact dialog body (machine select → browse →
 * confirm). Mobile uses `MobileAddLocalProjectFlow`; both drive the shared
 * `useRemoteDirectoryPicker` controller.
 */
export function RemoteDirectoryPicker(props: RemoteDirectoryPickerArgs) {
  const { t } = useTranslation();
  const c = useRemoteDirectoryPicker(props);
  const errorView = c.browseError
    ? describeBrowseError(c.browseError.code, c.browseError.message, t)
    : null;

  const showBack = c.phase === 'browse';
  const headerTitle =
    c.phase === 'machine'
      ? t('localProjects.add.pickMachine', 'Choose a machine')
      : t('localProjects.add.title', 'Add a folder');

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        {showBack ? (
          <button
            type="button"
            onClick={c.back}
            className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        ) : (
          <FolderPlus className="h-4 w-4 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{headerTitle}</p>
          {c.phase === 'browse' && c.selectedMachine ? (
            <p className="truncate text-xs text-muted-foreground">{c.selectedMachine.name}</p>
          ) : null}
        </div>
      </div>

      {/* Body */}
      {c.phase === 'machine' ? (
        <MachineStep
          machines={c.machines}
          machinesLoading={c.machinesLoading}
          blockedMachine={c.blockedMachine}
          onSelect={c.selectMachine}
        />
      ) : (
        <BrowseStep
          roots={c.roots}
          current={c.current}
          status={c.status}
          errorView={errorView}
          loadingMore={c.loadingMore}
          editingPath={c.editingPath}
          pathDraft={c.pathDraft}
          adding={c.adding}
          addError={c.addError}
          sep={c.sep}
          onNavigate={c.navigate}
          onEntryClick={c.entryClick}
          onLoadMore={() => void c.loadMore()}
          onRetry={c.retry}
          onAddCurrentFolder={() => void c.addCurrentFolder()}
          onCancel={c.close}
          onStartEditPath={c.startEditPath}
          onCancelEditPath={c.cancelEditPath}
          onPathDraftChange={c.setPathDraft}
          onPathSubmit={c.submitPath}
        />
      )}
    </div>
  );
}

function MachineStep({
  machines,
  machinesLoading,
  blockedMachine,
  onSelect,
}: {
  machines: RemoteDirectoryPickerMachine[];
  machinesLoading: boolean;
  blockedMachine: RemoteDirectoryPickerMachine | null;
  onSelect: (machineId: RemoteDirectoryPickerMachine['id']) => void;
}) {
  const { t } = useTranslation();
  if (machinesLoading) {
    return (
      <StatusPanel
        icon={Loader2}
        iconClassName="animate-spin"
        title={t('workspace.machines.loadingVisibility', 'Loading machines')}
      />
    );
  }
  if (machines.length === 0) {
    return (
      <StatusPanel
        icon={MonitorSmartphone}
        title={t('localProjects.add.noMachinesTitle', 'No machines available')}
        description={t(
          'localProjects.add.noMachinesDescription',
          'Connect a machine to this workspace with the Lody CLI to add local projects.'
        )}
      />
    );
  }
  return (
    <div className="scrollbar-pro max-h-[min(52vh,420px)] overflow-y-auto p-2">
      <p className="px-2 py-2 text-xs text-muted-foreground">
        {t('localProjects.add.pickMachineHint', 'Pick where the folder lives.')}
      </p>
      {blockedMachine ? <MachineOwnerNotice machine={blockedMachine} /> : null}
      <ul className="flex flex-col gap-1">
        {machines.map((machine) => (
          <li key={machine.id}>
            <button
              type="button"
              disabled={machine.canAddProjects && !machine.online}
              aria-disabled={machine.canAddProjects && !machine.online}
              onClick={() => onSelect(machine.id)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                machine.canAddProjects && machine.online
                  ? 'hover:bg-hover focus-visible:bg-hover focus-visible:outline-none'
                  : machine.canAddProjects
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:bg-hover focus-visible:bg-hover focus-visible:outline-none'
              )}
            >
              <MonitorSmartphone className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{machine.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {machine.canAddProjects
                    ? t('localProjects.add.yourMachine', 'Your machine')
                    : machine.ownerName
                      ? t('localProjects.add.ownedBy', 'Owned by {{owner}}', {
                          owner: machine.ownerName,
                        })
                      : t(
                          'localProjects.add.ownedByWorkspaceMember',
                          'Owned by another workspace member'
                        )}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={cn(
                    'text-xs',
                    machine.online ? 'text-emerald-500' : 'text-muted-foreground'
                  )}
                >
                  {machine.online
                    ? t('localProjects.add.online', 'Online')
                    : t('localProjects.add.offline', 'Offline')}
                </span>
                {!machine.canAddProjects ? (
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {t('localProjects.add.ownerOnly', 'Owner only')}
                  </span>
                ) : null}
              </span>
              {machine.canAddProjects ? (
                <ChevronRight
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground/40',
                    !machine.online && 'invisible'
                  )}
                  aria-hidden
                />
              ) : (
                <Lock className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden />
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MachineOwnerNotice({ machine }: { machine: RemoteDirectoryPickerMachine }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="mx-2 mb-2 flex gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {machine.ownerName
          ? t(
              'localProjects.add.ownerRequired',
              'This machine belongs to {{owner}}. Only {{owner}} can add a project from it.',
              { owner: machine.ownerName }
            )
          : t(
              'localProjects.add.ownerRequiredUnknown',
              'This machine belongs to another workspace member. Only its owner can add a project from it.'
            )}
      </span>
    </div>
  );
}

function BrowseStep({
  roots,
  current,
  status,
  errorView,
  loadingMore,
  editingPath,
  pathDraft,
  adding,
  addError,
  sep,
  onNavigate,
  onEntryClick,
  onLoadMore,
  onRetry,
  onAddCurrentFolder,
  onCancel,
  onStartEditPath,
  onCancelEditPath,
  onPathDraftChange,
  onPathSubmit,
}: {
  roots: LocalProjectBrowseRootsResult | null;
  current: LocalProjectBrowseDirectoryResult | null;
  status: RemoteDirectoryBrowseStatus;
  errorView: { icon: LucideIcon; title: string; description: string } | null;
  loadingMore: boolean;
  editingPath: boolean;
  pathDraft: string;
  adding: boolean;
  addError: string | null;
  sep: '/' | '\\';
  onNavigate: (absolutePath: string) => void;
  onEntryClick: (entry: LocalProjectBrowseDirectoryEntry) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onAddCurrentFolder: () => void;
  onCancel: () => void;
  onStartEditPath: () => void;
  onCancelEditPath: () => void;
  onPathDraftChange: (value: string) => void;
  onPathSubmit: () => void;
}) {
  const { t } = useTranslation();
  const crumbs = current ? splitBreadcrumbs(current.path, sep) : [];
  const breadcrumbTrail = getTailPriorityBreadcrumbs(crumbs);
  const currentPathParts = current ? splitPathForTailPriority(crumbs, sep) : null;
  const initialLoading = status === 'loading' && !current;
  const navigating = status === 'loading' && !!current;

  return (
    <>
      {/* Path bar: breadcrumb (root shown as a home icon) with an edit button
          on the far right that swaps the row for a single-line path input. */}
      <div className="flex items-center gap-1 border-b border-border/40 px-3 py-2">
        {editingPath ? (
          <>
            <Input
              value={pathDraft}
              onChange={(e) => onPathDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onPathSubmit();
                else if (e.key === 'Escape') onCancelEditPath();
              }}
              placeholder={t('localProjects.add.pathPlaceholder', 'Type an absolute path')}
              className="h-7 flex-1 text-xs"
              autoFocus
            />
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              className="shrink-0"
              title={t('localProjects.add.go', 'Go')}
              onClick={onPathSubmit}
            >
              <Check className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
              {breadcrumbTrail.hiddenPrefix ? (
                <span className="shrink-0 px-1 py-0.5 text-muted-foreground/60">…</span>
              ) : null}
              {breadcrumbTrail.visibleCrumbs.map((crumb, index) => {
                const originalIndex = breadcrumbTrail.startIndex + index;
                const isRoot = originalIndex === 0;
                return (
                  <span key={crumb.path} className="flex min-w-0 items-center">
                    {index > 0 || breadcrumbTrail.hiddenPrefix ? (
                      <span className="shrink-0 px-0.5 text-muted-foreground/40">/</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onNavigate(crumb.path)}
                      aria-label={isRoot ? t('localProjects.add.root', 'Root') : undefined}
                      className={cn(
                        'flex min-w-0 max-w-28 items-center rounded px-1 py-0.5 transition-colors hover:bg-hover hover:text-foreground',
                        originalIndex === crumbs.length - 1 &&
                          'max-w-36 font-medium text-foreground'
                      )}
                    >
                      {isRoot ? (
                        <Home className="h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <span className="truncate">{crumb.label}</span>
                      )}
                    </button>
                  </span>
                );
              })}
            </div>
            {status === 'loading' ? (
              <Loader2
                className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                aria-hidden
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              className="shrink-0"
              title={t('localProjects.add.editPath', 'Edit path')}
              onClick={onStartEditPath}
              disabled={!current}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      {/* Drives (Windows) */}
      {roots?.drives && roots.drives.length > 1 ? (
        <div className="flex flex-wrap gap-1 border-b border-border/40 px-3 py-1.5">
          {roots.drives.map((drive) => (
            <Button
              key={drive}
              type="button"
              variant="secondary"
              size="small"
              onClick={() => onNavigate(drive)}
            >
              <HardDrive className="h-3 w-3" />
              {drive}
            </Button>
          ))}
        </div>
      ) : null}

      {/* List */}
      <div className="scrollbar-pro max-h-[min(52vh,420px)] overflow-y-auto">
        {initialLoading ? (
          <DirectorySkeleton />
        ) : status === 'error' && errorView ? (
          <StatusPanel
            icon={errorView.icon}
            tone="muted"
            title={errorView.title}
            description={errorView.description}
            action={
              <Button type="button" variant="secondary" size="small" onClick={onRetry}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t('common.retry', 'Retry')}
              </Button>
            }
          />
        ) : current ? (
          <ul
            className={cn(
              'py-1 transition-opacity',
              navigating && 'pointer-events-none opacity-50'
            )}
            aria-busy={navigating}
          >
            {current.parentPath ? (
              <li>
                <button
                  type="button"
                  onClick={() => current.parentPath && onNavigate(current.parentPath)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-hover"
                >
                  <ArrowUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {t('localProjects.add.parent', '..')}
                  </span>
                </button>
              </li>
            ) : null}
            {current.entries.length === 0 ? (
              <li className="px-4 py-10 text-center text-sm text-muted-foreground">
                {t('localProjects.add.emptyFolder', 'This folder has no subfolders.')}
              </li>
            ) : (
              current.entries.map((entry) => (
                <li key={entry.absolutePath}>
                  <EntryRow entry={entry} onClick={() => onEntryClick(entry)} />
                </li>
              ))
            )}
            {current.truncated ? (
              <li className="px-4 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  className="w-full"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    t('localProjects.add.loadMore', 'Load more')
                  )}
                </Button>
              </li>
            ) : null}
          </ul>
        ) : (
          <DirectorySkeleton />
        )}
      </div>

      {/* Footer */}
      <div className="flex w-full min-w-0 flex-col gap-2 overflow-hidden border-t border-border/60 px-4 py-3">
        {addError ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {addError}
          </p>
        ) : null}
        <div className="flex w-full min-w-0 items-center justify-between gap-3 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="text-[0.7rem] tracking-wide text-muted-foreground/70">
              {t('localProjects.add.currentFolder', 'Current folder')}
            </p>
            {currentPathParts ? (
              <p
                className="flex min-w-0 items-center overflow-hidden text-xs font-medium text-foreground"
                title={current?.path}
              >
                {currentPathParts.head ? (
                  <span className="min-w-[1ch] shrink truncate">{currentPathParts.head}</span>
                ) : null}
                <span className="shrink-0">{currentPathParts.tail}</span>
              </p>
            ) : (
              <p className="truncate text-xs font-medium text-foreground">…</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="ghost" size="small" onClick={onCancel} disabled={adding}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="small"
              disabled={!current || status !== 'ready' || adding}
              onClick={onAddCurrentFolder}
            >
              {adding ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4" />
              )}
              {t('localProjects.add.useThisFolder', 'Add')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function EntryRow({
  entry,
  onClick,
}: {
  entry: LocalProjectBrowseDirectoryEntry;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const registered = Boolean(entry.registeredProjectId);
  const unreadable = entry.error === 'unreadable';
  const Icon = entry.hints?.git ? FolderGit2 : Folder;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={unreadable}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors',
        unreadable
          ? 'cursor-not-allowed opacity-50'
          : 'hover:bg-hover focus-visible:bg-hover focus-visible:outline-none'
      )}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
      <span className={cn('min-w-0 flex-1 truncate', entry.hidden && 'text-muted-foreground')}>
        {entry.name}
      </span>
      {registered ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.7rem] font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="h-3 w-3" />
          {t('localProjects.add.added', 'Added')}
        </span>
      ) : unreadable ? (
        <Lock className="h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />
      ) : (
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />
      )}
    </button>
  );
}

function DirectorySkeleton() {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-2 py-2">
          <Skeleton className="h-5 w-5 rounded" />
          <Skeleton className="h-4 flex-1 rounded" style={{ maxWidth: `${60 - index * 4}%` }} />
        </div>
      ))}
    </div>
  );
}

function StatusPanel({
  icon: Icon,
  iconClassName,
  title,
  description,
  action,
  tone = 'muted',
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: 'muted' | 'destructive';
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center',
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      <Icon className={cn('h-7 w-7', iconClassName)} aria-hidden />
      <span className="text-sm font-medium text-foreground">{title}</span>
      {description ? <span className="max-w-xs text-[0.8125rem]">{description}</span> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export interface AddLocalProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile?: boolean;
  machines: RemoteDirectoryPickerMachine[];
  machinesLoading?: boolean;
  initialMachineId?: RemoteDirectoryPickerArgs['initialMachineId'];
  ops: RemoteDirectoryOps;
  onAdded: RemoteDirectoryPickerArgs['onAdded'];
  onLocateRegistered?: RemoteDirectoryPickerArgs['onLocateRegistered'];
}

/**
 * Shell that renders the directory picker as a centered Dialog on desktop and a
 * full-height mobile flow inside a bottom Drawer on mobile.
 */
export function AddLocalProjectDialog({
  open,
  onOpenChange,
  isMobile,
  machines,
  machinesLoading,
  initialMachineId,
  ops,
  onAdded,
  onLocateRegistered,
}: AddLocalProjectDialogProps) {
  const { t } = useTranslation();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const a11yTitle = t('localProjects.add.title', 'Add a folder');
  const a11yDescription = t(
    'localProjects.add.dialogDescription',
    'Browse the machine and choose a folder to add as a local project.'
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          // Full-height sheet anchored to the bottom. We deliberately do NOT
          // lift the whole sheet for the keyboard: the path/name inputs live near
          // the top (already above the keyboard), and each step decides what to
          // do with its footer — browse lets the keyboard cover it (and disables
          // Add), confirm lifts its action with `mb-[--native-keyboard-height]`.
          className="h-[92dvh] max-h-[92dvh]"
        >
          <DrawerTitle className="sr-only">{a11yTitle}</DrawerTitle>
          <DrawerDescription className="sr-only">{a11yDescription}</DrawerDescription>
          <MobileAddLocalProjectFlow
            machines={machines}
            machinesLoading={machinesLoading}
            initialMachineId={initialMachineId}
            ops={ops}
            onAdded={onAdded}
            onLocateRegistered={onLocateRegistered}
            onClose={close}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">{a11yTitle}</DialogTitle>
        <DialogDescription className="sr-only">{a11yDescription}</DialogDescription>
        <RemoteDirectoryPicker
          machines={machines}
          machinesLoading={machinesLoading}
          initialMachineId={initialMachineId}
          ops={ops}
          onAdded={onAdded}
          onLocateRegistered={onLocateRegistered}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  );
}
