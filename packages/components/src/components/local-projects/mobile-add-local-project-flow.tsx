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
import * as stylex from '@stylexjs/stylex';
import { clsx } from 'clsx';
import { Spinner } from '@/ui/spinner';
import type { LocalProjectBrowseDirectoryEntry } from '@lody/shared';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Skeleton } from '@lody/ui/skeleton';
import {
  RemoteDirectoryNewFolderAction,
  RemoteDirectoryNewFolderControl,
} from './remote-directory-new-folder-control';
import {
  describeBrowseError,
  getTailPriorityBreadcrumbs,
  splitBreadcrumbs,
  useRemoteDirectoryPicker,
  type RemoteDirectoryPickerArgs,
  type RemoteDirectoryPickerController,
} from './use-remote-directory-picker';
import { localProjectsSurface as surface } from './surface';

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
    <div {...stylex.props(surface.column)}>
      {/* Top bar */}
      <div {...stylex.props(surface.titleRow)}>
        {c.phase === 'machine' ? (
          <div {...stylex.props(surface.iconButtonSpacer)} aria-hidden />
        ) : (
          <button
            type="button"
            onClick={c.back}
            aria-label={t('common.back', 'Back')}
            {...stylex.props(surface.iconButton, surface.iconButtonForeground)}
          >
            <ArrowLeft {...stylex.props(surface.iconGlyph)} />
          </button>
        )}
        <p {...stylex.props(surface.title)}>{title}</p>
        <button
          type="button"
          onClick={c.close}
          aria-label={t('common.cancel', 'Cancel')}
          {...stylex.props(surface.iconButton, surface.iconButtonMuted)}
        >
          <X {...stylex.props(surface.iconGlyph)} />
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
        spinning
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
    <div
      {...stylex.props(surface.scroller, surface.scrollerSafeArea)}
      className={clsx(
        stylex.props(surface.scroller, surface.scrollerSafeArea).className,
        'scrollbar-pro'
      )}
    >
      <p {...stylex.props(surface.hint)}>
        {t('localProjects.add.pickMachineHint', 'Pick where the folder lives.')}
      </p>
      {c.blockedMachine ? (
        <div role="alert" {...stylex.props(surface.notice)}>
          <Lock {...stylex.props(surface.noticeGlyph)} aria-hidden />
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
          {index > 0 ? <div {...stylex.props(surface.separator)} aria-hidden /> : null}
          <button
            type="button"
            disabled={machine.canAddProjects && !machine.online}
            aria-disabled={machine.canAddProjects && !machine.online}
            onClick={() => c.selectMachine(machine.id)}
            {...stylex.props(
              surface.row,
              machine.canAddProjects && !machine.online ? surface.rowDisabled : surface.rowActive
            )}
          >
            <MonitorSmartphone {...stylex.props(surface.rowGlyph)} strokeWidth={1.6} />
            <span {...stylex.props(surface.rowText)}>
              <span {...stylex.props(surface.rowTitle)}>{machine.name}</span>
              <span {...stylex.props(surface.rowName)}>
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
            <span {...stylex.props(surface.rowTrailing)}>
              <span
                {...stylex.props(
                  surface.rowTrailingText,
                  machine.online ? surface.rowTrailingOnline : undefined
                )}
              >
                {machine.online
                  ? t('localProjects.add.online', 'Online')
                  : t('localProjects.add.offline', 'Offline')}
              </span>
              {!machine.canAddProjects ? (
                <span {...stylex.props(surface.rowTrailingNote)}>
                  {t('localProjects.add.ownerOnly', 'Owner only')}
                </span>
              ) : null}
            </span>
            {machine.canAddProjects ? (
              <ChevronRight
                {...stylex.props(surface.rowChevron, !machine.online && surface.rowChevronHidden)}
                aria-hidden
              />
            ) : (
              <Lock {...stylex.props(surface.rowLock)} aria-hidden />
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
      <div {...stylex.props(surface.pathBar)}>
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
              {...stylex.props(surface.pathGoButton)}
            >
              <Check {...stylex.props(surface.pathGoGlyph)} />
            </button>
          </>
        ) : (
          <>
            <div {...stylex.props(surface.pathCrumbs)}>
              {crumbs.length === 0 ? (
                <Skeleton width={128} height={16} className="mx-1.5 shrink-0" />
              ) : (
                <>
                  {breadcrumbTrail.hiddenPrefix ? (
                    <span {...stylex.props(surface.pathCrumbEllipsis)}>…</span>
                  ) : null}
                  {breadcrumbTrail.visibleCrumbs.map((crumb, index) => {
                    const originalIndex = breadcrumbTrail.startIndex + index;
                    const isRoot = originalIndex === 0;
                    return (
                      <span key={crumb.path} {...stylex.props(surface.pathCrumbGroup)}>
                        {index > 0 || breadcrumbTrail.hiddenPrefix ? (
                          <span {...stylex.props(surface.pathCrumbSeparator)}>/</span>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => c.navigate(crumb.path)}
                          aria-label={isRoot ? t('localProjects.add.root', 'Root') : undefined}
                          {...stylex.props(
                            surface.pathCrumb,
                            originalIndex === crumbs.length - 1 && surface.pathCrumbCurrent
                          )}
                        >
                          {isRoot ? (
                            <Home {...stylex.props(surface.pathCrumbGlyph)} />
                          ) : (
                            <span {...stylex.props(surface.truncate)}>{crumb.label}</span>
                          )}
                        </button>
                      </span>
                    );
                  })}
                </>
              )}
            </div>
            {c.status === 'loading' ? (
              <div {...stylex.props(surface.pathSpinnerBox)}>
                <Spinner {...stylex.props(surface.pathSpinner)} aria-hidden />
              </div>
            ) : (
              <>
                <RemoteDirectoryNewFolderAction controller={c} />
                <button
                  type="button"
                  onClick={c.startEditPath}
                  disabled={!c.current}
                  aria-label={t('localProjects.add.editPath', 'Edit path')}
                  {...stylex.props(surface.pathEditButton)}
                >
                  <Pencil {...stylex.props(surface.pathEditGlyph)} />
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Drives (Windows) */}
      {c.roots?.drives && c.roots.drives.length > 1 ? (
        <div {...stylex.props(surface.drives)}>
          {c.roots.drives.map((drive) => (
            <button
              key={drive}
              type="button"
              onClick={() => c.navigate(drive)}
              {...stylex.props(surface.drive)}
            >
              <HardDrive {...stylex.props(surface.driveGlyph)} />
              {drive}
            </button>
          ))}
        </div>
      ) : null}

      {/* List */}
      <div
        {...stylex.props(surface.scroller, surface.scrollerOverscroll)}
        className={clsx(
          stylex.props(surface.scroller, surface.scrollerOverscroll).className,
          'scrollbar-pro'
        )}
      >
        {initialLoading ? (
          <MobileDirectorySkeleton />
        ) : c.status === 'error' && errorView ? (
          <MobileStatusPanel
            icon={errorView.icon}
            title={errorView.title}
            description={errorView.description}
            action={
              <Button type="button" variant="secondary" size="large" onClick={c.retry}>
                <RefreshCw {...stylex.props(surface.glyphSm)} />
                {t('common.retry', 'Retry')}
              </Button>
            }
          />
        ) : c.current ? (
          <div {...stylex.props(surface.listing, navigating && surface.listingNavigating)}>
            {c.current.parentPath ? (
              <button
                type="button"
                onClick={() => c.current?.parentPath && c.navigate(c.current.parentPath)}
                {...stylex.props(surface.parentRow)}
              >
                <ArrowUp {...stylex.props(surface.parentGlyph)} />
                <span {...stylex.props(surface.parentLabel)}>
                  {t('localProjects.add.parent', '..')}
                </span>
              </button>
            ) : null}
            {c.current.entries.length === 0 ? (
              <p {...stylex.props(surface.emptyListing)}>
                {t('localProjects.add.emptyFolder', 'This folder has no subfolders.')}
              </p>
            ) : (
              c.current.entries.map((entry, index) => (
                <Fragment key={entry.absolutePath}>
                  {index > 0 || c.current?.parentPath ? (
                    <div {...stylex.props(surface.separator)} aria-hidden />
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
                {...stylex.props(surface.loadMoreRow)}
              >
                {c.loadingMore ? (
                  <Spinner {...stylex.props(surface.glyphSm)} />
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

      {/* Footer — the creation form appears only after invoking the path-bar action. */}
      <div {...stylex.props(surface.footer)}>
        <RemoteDirectoryNewFolderControl controller={c} />
        {c.addError ? <p {...stylex.props(surface.footerError)}>{c.addError}</p> : null}
        <Button
          type="button"
          size="large"
          width="100%"
          disabled={!c.canAddCurrentFolder}
          onClick={() => void c.addCurrentFolder()}
        >
          {c.adding ? <Spinner {...stylex.props(surface.glyphMd)} /> : null}
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
      {...stylex.props(surface.row, unreadable ? surface.rowDisabled : surface.rowActive)}
    >
      <Icon {...stylex.props(surface.rowGlyph)} strokeWidth={1.6} />
      <span
        {...stylex.props(
          surface.rowText,
          surface.rowNameLarge,
          entry.hidden && surface.rowNameHidden
        )}
      >
        {entry.name}
      </span>
      {registered ? (
        <Badge tone="success" icon={<Check size="100%" />}>
          {t('localProjects.add.added', 'Added')}
        </Badge>
      ) : unreadable ? (
        <Lock {...stylex.props(surface.rowChevron)} aria-hidden />
      ) : (
        <ChevronRight {...stylex.props(surface.rowChevron)} aria-hidden />
      )}
    </button>
  );
}

function MobileDirectorySkeleton() {
  return (
    <div {...stylex.props(surface.skeletonBody)}>
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} {...stylex.props(surface.skeletonRow)}>
          <Skeleton width={28} height={28} className="shrink-0" />
          <Skeleton height={16} className="flex-1" style={{ maxWidth: `${64 - index * 5}%` }} />
        </div>
      ))}
    </div>
  );
}

function MobileStatusPanel({
  icon: Icon,
  spinning = false,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  /**
   * Rotates the icon: the panel is a loading state. Defaults to false, and
   * MUST keep a default here — `Spinner` treats an omitted `spinning` as a
   * loading indicator, so forwarding this prop while it is `undefined` would
   * spin the resting states' icons forever.
   */
  spinning?: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div {...stylex.props(surface.statusPanel)}>
      <Spinner
        icon={Icon}
        spinning={spinning}
        {...stylex.props(surface.statusGlyph)}
        aria-hidden
        strokeWidth={1.6}
      />
      <span {...stylex.props(surface.statusTitle)}>{title}</span>
      {description ? <span {...stylex.props(surface.statusDescription)}>{description}</span> : null}
      {action ? <div {...stylex.props(surface.statusAction)}>{action}</div> : null}
    </div>
  );
}
