import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Folder,
  FolderGit2,
  HardDrive,
  Home,
  Loader2,
  Lock,
  MonitorSmartphone,
  Pencil,
  RefreshCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { LocalProjectBrowseDirectoryEntry } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Skeleton } from '@/ui/skeleton';
import {
  describeBrowseError,
  getTailPriorityBreadcrumbs,
  splitBreadcrumbs,
  useRemoteDirectoryPicker,
  type RemoteDirectoryPickerArgs,
  type RemoteDirectoryPickerController,
} from './use-remote-directory-picker';

const MOBILE_SHEET_TITLE_TEXT_CLASS = 'text-[0.95rem] font-semibold leading-6 text-foreground';

/**
 * Mobile-optimized add-local-project flow (machine → browse → confirm). Large
 * tap targets, full-bleed rows, and the same row/skeleton/status look as the
 * project file browser. Drives the shared `useRemoteDirectoryPicker` controller
 * so behavior matches the desktop dialog.
 */
export function MobileAddLocalProjectFlow(args: RemoteDirectoryPickerArgs) {
  const { t } = useTranslation();
  const c = useRemoteDirectoryPicker(args);

  const title =
    c.phase === 'machine'
      ? t('localProjects.add.pickMachine', 'Choose a machine')
      : (c.selectedMachine?.name ?? t('localProjects.add.title', 'Add a folder'));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-1 px-2 pb-1.5 pt-1">
        {c.phase === 'machine' ? (
          <div className="h-11 w-11 shrink-0" aria-hidden />
        ) : (
          <button
            type="button"
            onClick={c.back}
            aria-label={t('common.back', 'Back')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-foreground active:bg-muted/60"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <p className={cn('min-w-0 flex-1 truncate text-center', MOBILE_SHEET_TITLE_TEXT_CLASS)}>
          {title}
        </p>
        <button
          type="button"
          onClick={c.close}
          aria-label={t('common.cancel', 'Cancel')}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted/60"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {c.phase === 'machine' ? (
        <MobileMachineList controller={c} />
      ) : (
        <MobileBrowse controller={c} />
      )}
    </div>
  );
}

function MobileMachineList({ controller: c }: { controller: RemoteDirectoryPickerController }) {
  const { t } = useTranslation();
  if (c.machinesLoading) {
    return (
      <MobileStatusPanel
        icon={Loader2}
        iconClassName="animate-spin"
        title={t('workspace.machines.loadingVisibility', 'Loading machines')}
      />
    );
  }
  if (c.machines.length === 0) {
    return (
      <MobileStatusPanel
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
    <div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto pb-[var(--safe-area-bottom,0px)]">
      <p className="px-4 py-2 text-[0.8125rem] text-muted-foreground">
        {t('localProjects.add.pickMachineHint', 'Pick where the folder lives.')}
      </p>
      {c.blockedMachine ? (
        <div
          role="alert"
          className="mx-4 mb-2 flex gap-2 rounded-lg bg-muted/60 px-3 py-2.5 text-[0.8125rem] leading-snug text-muted-foreground"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {c.blockedMachine.ownerName
              ? t(
                  'localProjects.add.ownerRequired',
                  'This machine belongs to {{owner}}. Only {{owner}} can add a project from it.',
                  { owner: c.blockedMachine.ownerName }
                )
              : t(
                  'localProjects.add.ownerRequiredUnknown',
                  'This machine belongs to another workspace member. Only its owner can add a project from it.'
                )}
          </span>
        </div>
      ) : null}
      {c.machines.map((machine, index) => (
        <Fragment key={machine.id}>
          {index > 0 ? <div className="ml-[3.25rem] h-px bg-border/40" aria-hidden /> : null}
          <button
            type="button"
            disabled={machine.canAddProjects && !machine.online}
            aria-disabled={machine.canAddProjects && !machine.online}
            onClick={() => c.selectMachine(machine.id)}
            className={cn(
              'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
              machine.canAddProjects && !machine.online
                ? 'cursor-not-allowed opacity-50'
                : 'active:bg-muted/50'
            )}
          >
            <MonitorSmartphone
              className="h-6 w-6 shrink-0 text-muted-foreground"
              strokeWidth={1.6}
            />
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate', MOBILE_SHEET_TITLE_TEXT_CLASS)}>
                {machine.name}
              </span>
              <span className="block truncate text-[0.8125rem] text-muted-foreground">
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
                  'text-[0.8125rem]',
                  machine.online ? 'text-emerald-500' : 'text-muted-foreground'
                )}
              >
                {machine.online
                  ? t('localProjects.add.online', 'Online')
                  : t('localProjects.add.offline', 'Offline')}
              </span>
              {!machine.canAddProjects ? (
                <span className="text-xs text-muted-foreground">
                  {t('localProjects.add.ownerOnly', 'Owner only')}
                </span>
              ) : null}
            </span>
            {machine.canAddProjects ? (
              <ChevronRight
                className={cn(
                  'h-5 w-5 shrink-0 text-muted-foreground/40',
                  !machine.online && 'invisible'
                )}
                aria-hidden
              />
            ) : (
              <Lock className="h-5 w-5 shrink-0 text-muted-foreground/50" aria-hidden />
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function MobileBrowse({ controller: c }: { controller: RemoteDirectoryPickerController }) {
  const { t } = useTranslation();
  const crumbs = c.current ? splitBreadcrumbs(c.current.path, c.sep) : [];
  const breadcrumbTrail = getTailPriorityBreadcrumbs(crumbs);
  const errorView = c.browseError
    ? describeBrowseError(c.browseError.code, c.browseError.message, t)
    : null;
  const initialLoading = c.status === 'loading' && !c.current;
  const navigating = c.status === 'loading' && !!c.current;

  return (
    <>
      {/* Path bar */}
      <div className="flex min-h-[3.25rem] items-center gap-1 border-y border-border/40 bg-muted/20 px-2 py-1.5">
        {c.editingPath ? (
          <>
            <Input
              value={c.pathDraft}
              onChange={(e) => c.setPathDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') c.submitPath();
                else if (e.key === 'Escape') c.cancelEditPath();
              }}
              placeholder={t('localProjects.add.pathPlaceholder', 'Type an absolute path')}
              className="h-10 flex-1 text-[0.95rem]"
              autoFocus
            />
            <button
              type="button"
              onClick={c.submitPath}
              aria-label={t('localProjects.add.go', 'Go')}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary active:bg-muted/60"
            >
              <Check className="h-5 w-5" />
            </button>
          </>
        ) : (
          <>
            <div className="flex min-h-10 min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap text-[0.9rem] text-muted-foreground">
              {crumbs.length === 0 ? (
                <Skeleton className="mx-1.5 h-4 w-32 shrink-0 rounded" />
              ) : (
                <>
                  {breadcrumbTrail.hiddenPrefix ? (
                    <span className="shrink-0 px-1.5 py-1 text-muted-foreground/60">…</span>
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
                          onClick={() => c.navigate(crumb.path)}
                          aria-label={isRoot ? t('localProjects.add.root', 'Root') : undefined}
                          className={cn(
                            'flex min-w-0 max-w-32 items-center rounded px-1.5 py-1 transition-colors active:bg-muted/60',
                            originalIndex === crumbs.length - 1 &&
                              'max-w-40 font-medium text-foreground'
                          )}
                        >
                          {isRoot ? (
                            <Home className="h-4 w-4 shrink-0" />
                          ) : (
                            <span className="truncate">{crumb.label}</span>
                          )}
                        </button>
                      </span>
                    );
                  })}
                </>
              )}
            </div>
            {c.status === 'loading' ? (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
              </div>
            ) : (
              <button
                type="button"
                onClick={c.startEditPath}
                disabled={!c.current}
                aria-label={t('localProjects.add.editPath', 'Edit path')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-muted/60 disabled:opacity-40"
              >
                <Pencil className="h-4 w-4" />
              </button>
            )}
          </>
        )}
      </div>

      {/* Drives (Windows) */}
      {c.roots?.drives && c.roots.drives.length > 1 ? (
        <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-3 py-2">
          {c.roots.drives.map((drive) => (
            <button
              key={drive}
              type="button"
              onClick={() => c.navigate(drive)}
              className="flex items-center gap-1.5 rounded-full bg-muted/50 px-3 py-1.5 text-[0.8125rem] active:bg-muted/70"
            >
              <HardDrive className="h-3.5 w-3.5" />
              {drive}
            </button>
          ))}
        </div>
      ) : null}

      {/* List */}
      <div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {initialLoading ? (
          <MobileDirectorySkeleton />
        ) : c.status === 'error' && errorView ? (
          <MobileStatusPanel
            icon={errorView.icon}
            title={errorView.title}
            description={errorView.description}
            action={
              <Button type="button" variant="outline" onClick={c.retry} className="h-10 gap-1.5">
                <RefreshCw className="h-4 w-4" />
                {t('common.retry', 'Retry')}
              </Button>
            }
          />
        ) : c.current ? (
          <div className={cn('transition-opacity', navigating && 'pointer-events-none opacity-50')}>
            {c.current.parentPath ? (
              <button
                type="button"
                onClick={() => c.current?.parentPath && c.navigate(c.current.parentPath)}
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-muted-foreground transition-colors active:bg-muted/50"
              >
                <ArrowUp className="h-6 w-6 shrink-0" />
                <span className="text-[1.0625rem]">{t('localProjects.add.parent', '..')}</span>
              </button>
            ) : null}
            {c.current.entries.length === 0 ? (
              <p className="px-4 py-12 text-center text-[0.95rem] text-muted-foreground">
                {t('localProjects.add.emptyFolder', 'This folder has no subfolders.')}
              </p>
            ) : (
              c.current.entries.map((entry, index) => (
                <Fragment key={entry.absolutePath}>
                  {index > 0 || c.current?.parentPath ? (
                    <div className="ml-[3.25rem] h-px bg-border/40" aria-hidden />
                  ) : null}
                  <MobileEntryRow entry={entry} onClick={() => c.entryClick(entry)} />
                </Fragment>
              ))
            )}
            {c.current.truncated ? (
              <button
                type="button"
                onClick={() => void c.loadMore()}
                disabled={c.loadingMore}
                className="flex w-full items-center justify-center gap-2 px-4 py-3.5 text-[0.95rem] text-muted-foreground active:bg-muted/50"
              >
                {c.loadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t('localProjects.add.loadMore', 'Load more')
                )}
              </button>
            ) : null}
          </div>
        ) : (
          <MobileDirectorySkeleton />
        )}
      </div>

      {/* Footer — full-width primary action (adds the current folder directly) */}
      <div className="border-t border-border/60 px-4 pb-[max(0.75rem,var(--safe-area-bottom,0px))] pt-3">
        {c.addError ? (
          <p className="mb-2 text-left text-[0.8rem] text-destructive">{c.addError}</p>
        ) : null}
        <Button
          type="button"
          className="h-12 w-full gap-2 text-[1rem]"
          disabled={!c.current || c.status !== 'ready' || c.editingPath || c.adding}
          onClick={() => void c.addCurrentFolder()}
        >
          {c.adding ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
          {t('localProjects.add.useThisFolder', 'Add')}
        </Button>
      </div>
    </>
  );
}

function MobileEntryRow({
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
        'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors',
        unreadable ? 'cursor-not-allowed opacity-50' : 'active:bg-muted/50'
      )}
    >
      <Icon className="h-6 w-6 shrink-0 text-muted-foreground" strokeWidth={1.6} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[1.0625rem] text-foreground',
          entry.hidden && 'text-muted-foreground'
        )}
      >
        {entry.name}
      </span>
      {registered ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[0.75rem] font-medium text-emerald-600 dark:text-emerald-400">
          <Check className="h-3.5 w-3.5" />
          {t('localProjects.add.added', 'Added')}
        </span>
      ) : unreadable ? (
        <Lock className="h-5 w-5 shrink-0 text-muted-foreground/40" aria-hidden />
      ) : (
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/40" aria-hidden />
      )}
    </button>
  );
}

function MobileDirectorySkeleton() {
  return (
    <div className="py-1">
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3.5">
          <Skeleton className="h-7 w-7 shrink-0 rounded" />
          <Skeleton className="h-4 flex-1 rounded" style={{ maxWidth: `${64 - index * 5}%` }} />
        </div>
      ))}
    </div>
  );
}

function MobileStatusPanel({
  icon: Icon,
  iconClassName,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  iconClassName?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
      <Icon
        className={cn('h-9 w-9 text-muted-foreground', iconClassName)}
        aria-hidden
        strokeWidth={1.6}
      />
      <span className="text-[1.0625rem] font-medium text-foreground">{title}</span>
      {description ? (
        <span className="max-w-xs text-[0.9rem] text-muted-foreground">{description}</span>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
