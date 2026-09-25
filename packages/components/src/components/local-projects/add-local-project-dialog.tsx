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
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { withClassName } from '@/lib/stylex';
import { Spinner } from '@/ui/spinner';
import type {
  LocalProjectBrowseDirectoryEntry,
  LocalProjectBrowseDirectoryResult,
  LocalProjectBrowseRootsResult,
} from '@lody/shared';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Skeleton } from '@lody/ui/skeleton';
import { Dialog } from '@/ui/dialog';
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

/** Inside the panel a block is the region rung: a fill with no edge. */
const REGION = `color-mix(in oklab, transparent, ${colors.label} 3%)`;
/** A row's answer to the pointer, a film over whatever it sits on. */
const ROW_HOVER = `color-mix(in oklab, transparent, ${colors.label} 5%)`;
const LIST_MAX_HEIGHT = 'min(52vh, 420px)';

const styles = stylex.create({
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
  icon16: { flexShrink: 0, width: '16px', height: '16px' },
  icon20: { flexShrink: 0, width: '20px', height: '20px' },
  iconFill: { width: '100%', height: '100%' },
  hint: { color: colors.tertiaryLabel },
  secondary: { color: colors.secondaryLabel },
  invisible: { visibility: 'hidden' },

  picker: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    gap: space[3],
    width: '100%',
    minWidth: 0,
    minHeight: 0,
  },
  /** Clears the panel's close cross, which sits in this row's end corner. */
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: '28px',
    paddingInlineEnd: '36px',
  },
  headerText: { flexGrow: 1, minWidth: 0 },
  headerTitle: {
    margin: 0,
    fontSize: text.headlineSize,
    lineHeight: text.headlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  headerSubtitle: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },

  scroll: { maxHeight: LIST_MAX_HEIGHT, overflowY: 'auto' },
  machineStep: { display: 'flex', flexDirection: 'column', gap: space[2] },
  stepHint: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    margin: 0,
    padding: 0,
    listStyleType: 'none',
  },
  machineList: { gap: space[1.5] },
  /** A machine is an option inside the panel: a region fill, no card. */
  machineRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    margin: 0,
    paddingInline: space[3],
    paddingBlock: '10px',
    borderWidth: 0,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: {
      default: REGION,
      ':hover': `color-mix(in oklab, transparent, ${colors.label} 6%)`,
    },
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
    outlineStyle: 'none',
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  machineRowDisabled: {
    backgroundColor: { default: REGION, ':hover': REGION },
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  machineText: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 },
  machineName: { fontSize: text.bodySize, lineHeight: text.bodyLeading, fontWeight: 500 },
  machineMeta: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  machineStatus: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: space[1],
    flexShrink: 0,
  },
  machineOnline: { fontSize: text.footnoteSize, color: colors.success },
  machineOffline: { fontSize: text.footnoteSize, color: colors.secondaryLabel },
  ownerOnly: { fontSize: text.captionSize, color: colors.secondaryLabel },

  /** A message is a tint and a mark, never a bordered box. */
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  messageWarning: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.warning} 10%)`,
    color: colors.label,
  },
  messageError: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)`,
    color: colors.destructive,
  },
  messageMark: { marginTop: '1px' },
  markWarning: { color: colors.warning },

  pathBar: { display: 'flex', alignItems: 'center', gap: space[1], minHeight: '28px' },
  pathInput: { flexGrow: 1, minWidth: 0 },
  crumbs: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: '2px',
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: text.footnoteSize,
    color: colors.secondaryLabel,
  },
  crumbEllipsis: {
    flexShrink: 0,
    paddingInline: space[1],
    paddingBlock: '2px',
    color: colors.tertiaryLabel,
  },
  crumb: { display: 'flex', alignItems: 'center', minWidth: 0 },
  crumbSeparator: { flexShrink: 0, paddingInline: '2px', color: colors.tertiaryLabel },
  crumbButton: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '112px',
    margin: 0,
    paddingInline: space[1],
    paddingBlock: '2px',
    borderWidth: 0,
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': ROW_HOVER },
    color: { default: 'inherit', ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: 'inherit',
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  crumbCurrent: { maxWidth: '144px', fontWeight: 500, color: colors.label },
  drives: { display: 'flex', flexWrap: 'wrap', gap: space[1] },

  /** The folder list: one region inside the panel, its rows set apart by fill. */
  directory: {
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: REGION,
  },
  entries: {
    padding: space[1],
    opacity: 1,
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  entriesNavigating: { pointerEvents: 'none', opacity: 0.5 },
  entryRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[2],
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: {
      default: 'transparent',
      ':hover': ROW_HOVER,
      ':focus-visible': ROW_HOVER,
    },
    outlineStyle: 'none',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  entryRowDisabled: {
    backgroundColor: { default: 'transparent', ':hover': 'transparent' },
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  entryName: { flexGrow: 1 },
  emptyFolder: {
    paddingInline: space[4],
    paddingBlock: '40px',
    textAlign: 'center',
    fontSize: text.bodySize,
    color: colors.secondaryLabel,
  },
  loadMore: { paddingInline: space[3], paddingBlock: space[2] },
  fullWidth: { width: '100%' },

  footer: { display: 'flex', flexDirection: 'column', gap: space[2], minWidth: 0 },
  footerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    minWidth: 0,
  },
  currentFolder: { flexGrow: 1, minWidth: 0, overflow: 'hidden' },
  currentFolderLabel: {
    margin: 0,
    fontSize: text.captionSize,
    letterSpacing: '0.025em',
    color: colors.tertiaryLabel,
  },
  currentPath: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    margin: 0,
    overflow: 'hidden',
    fontSize: text.footnoteSize,
    fontWeight: 500,
    color: colors.label,
  },
  currentPathEmpty: { display: 'block' },
  pathHead: { flexShrink: 1, minWidth: '1ch' },
  pathTail: { flexShrink: 0 },
  actions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[2] },

  skeleton: { display: 'flex', flexDirection: 'column', gap: space[1], padding: space[2] },
  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[2],
    paddingBlock: space[2],
  },
  skeletonLine: (maxWidth: string) => ({ flexGrow: 1, minWidth: 0, maxWidth }),

  status: {
    display: 'flex',
    flexGrow: 1,
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    minHeight: 0,
    padding: space[8],
    textAlign: 'center',
    color: colors.secondaryLabel,
  },
  statusDestructive: { color: colors.destructive },
  statusIcon: { width: '28px', height: '28px' },
  statusTitle: {
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  statusDescription: {
    maxWidth: '320px',
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
  },
  statusAction: { marginTop: space[2] },
});

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
    <div {...stylex.props(styles.picker)}>
      {/* Header */}
      <div {...stylex.props(styles.header)}>
        {showBack ? (
          <Button
            type="button"
            variant="ghost"
            size="small"
            icon
            onClick={c.back}
            aria-label={t('common.back', 'Back')}
          >
            <ArrowLeft {...stylex.props(styles.iconFill)} />
          </Button>
        ) : (
          <FolderPlus {...stylex.props(styles.icon16, styles.secondary)} />
        )}
        <div {...stylex.props(styles.headerText)}>
          <p {...stylex.props(styles.headerTitle, styles.truncate)}>{headerTitle}</p>
          {c.phase === 'browse' && c.selectedMachine ? (
            <p {...stylex.props(styles.headerSubtitle, styles.truncate)}>
              {c.selectedMachine.name}
            </p>
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
        spinning
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
    // `scrollbar-pro` is the global sheet's scrollbar skin (pseudo-elements).
    <div {...withClassName(stylex.props(styles.machineStep, styles.scroll), 'scrollbar-pro')}>
      <p {...stylex.props(styles.stepHint)}>
        {t('localProjects.add.pickMachineHint', 'Pick where the folder lives.')}
      </p>
      {blockedMachine ? <MachineOwnerNotice machine={blockedMachine} /> : null}
      <ul {...stylex.props(styles.list, styles.machineList)}>
        {machines.map((machine) => {
          const unavailable = machine.canAddProjects && !machine.online;
          return (
            <li key={machine.id}>
              <button
                type="button"
                disabled={unavailable}
                aria-disabled={unavailable}
                onClick={() => onSelect(machine.id)}
                {...stylex.props(styles.machineRow, unavailable && styles.machineRowDisabled)}
              >
                <MonitorSmartphone {...stylex.props(styles.icon20, styles.secondary)} />
                <span {...stylex.props(styles.machineText)}>
                  <span {...stylex.props(styles.machineName, styles.truncate)}>{machine.name}</span>
                  <span {...stylex.props(styles.machineMeta, styles.truncate)}>
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
                <span {...stylex.props(styles.machineStatus)}>
                  <span
                    {...stylex.props(machine.online ? styles.machineOnline : styles.machineOffline)}
                  >
                    {machine.online
                      ? t('localProjects.add.online', 'Online')
                      : t('localProjects.add.offline', 'Offline')}
                  </span>
                  {!machine.canAddProjects ? (
                    <span {...stylex.props(styles.ownerOnly)}>
                      {t('localProjects.add.ownerOnly', 'Owner only')}
                    </span>
                  ) : null}
                </span>
                {machine.canAddProjects ? (
                  <ChevronRight
                    {...stylex.props(
                      styles.icon16,
                      styles.hint,
                      !machine.online && styles.invisible
                    )}
                    aria-hidden
                  />
                ) : (
                  <Lock {...stylex.props(styles.icon16, styles.hint)} aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MachineOwnerNotice({ machine }: { machine: RemoteDirectoryPickerMachine }) {
  const { t } = useTranslation();
  return (
    <div role="alert" {...stylex.props(styles.message, styles.messageWarning)}>
      <Lock {...stylex.props(styles.icon14, styles.messageMark, styles.markWarning)} aria-hidden />
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
      <div {...stylex.props(styles.pathBar)}>
        {editingPath ? (
          <>
            <div {...stylex.props(styles.pathInput)}>
              <Input
                size="small"
                value={pathDraft}
                onChange={(e) => onPathDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onPathSubmit();
                  else if (e.key === 'Escape') onCancelEditPath();
                }}
                placeholder={t('localProjects.add.pathPlaceholder', 'Type an absolute path')}
                autoFocus
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              title={t('localProjects.add.go', 'Go')}
              onClick={onPathSubmit}
            >
              <Check {...stylex.props(styles.iconFill)} />
            </Button>
          </>
        ) : (
          <>
            <div {...stylex.props(styles.crumbs)}>
              {breadcrumbTrail.hiddenPrefix ? (
                <span {...stylex.props(styles.crumbEllipsis)}>…</span>
              ) : null}
              {breadcrumbTrail.visibleCrumbs.map((crumb, index) => {
                const originalIndex = breadcrumbTrail.startIndex + index;
                const isRoot = originalIndex === 0;
                return (
                  <span key={crumb.path} {...stylex.props(styles.crumb)}>
                    {index > 0 || breadcrumbTrail.hiddenPrefix ? (
                      <span {...stylex.props(styles.crumbSeparator)}>/</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onNavigate(crumb.path)}
                      aria-label={isRoot ? t('localProjects.add.root', 'Root') : undefined}
                      {...stylex.props(
                        styles.crumbButton,
                        originalIndex === crumbs.length - 1 && styles.crumbCurrent
                      )}
                    >
                      {isRoot ? (
                        <Home {...stylex.props(styles.icon14)} />
                      ) : (
                        <span {...stylex.props(styles.truncate)}>{crumb.label}</span>
                      )}
                    </button>
                  </span>
                );
              })}
            </div>
            {status === 'loading' ? (
              <Spinner {...stylex.props(styles.icon14, styles.hint)} aria-hidden />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="small"
              icon
              title={t('localProjects.add.editPath', 'Edit path')}
              onClick={onStartEditPath}
              disabled={!current}
            >
              <Pencil {...stylex.props(styles.iconFill)} />
            </Button>
          </>
        )}
      </div>

      {/* Drives (Windows) */}
      {roots?.drives && roots.drives.length > 1 ? (
        <div {...stylex.props(styles.drives)}>
          {roots.drives.map((drive) => (
            <Button
              key={drive}
              type="button"
              variant="ghost"
              size="small"
              onClick={() => onNavigate(drive)}
            >
              <HardDrive {...stylex.props(styles.icon14)} />
              {drive}
            </Button>
          ))}
        </div>
      ) : null}

      {/* List */}
      <div {...withClassName(stylex.props(styles.directory, styles.scroll), 'scrollbar-pro')}>
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
                <RefreshCw {...stylex.props(styles.icon14)} />
                {t('common.retry', 'Retry')}
              </Button>
            }
          />
        ) : current ? (
          <ul
            {...stylex.props(styles.list, styles.entries, navigating && styles.entriesNavigating)}
            aria-busy={navigating}
          >
            {current.parentPath ? (
              <li>
                <button
                  type="button"
                  onClick={() => current.parentPath && onNavigate(current.parentPath)}
                  {...stylex.props(styles.entryRow)}
                >
                  <ArrowUp {...stylex.props(styles.icon16, styles.secondary)} />
                  <span {...stylex.props(styles.secondary)}>
                    {t('localProjects.add.parent', '..')}
                  </span>
                </button>
              </li>
            ) : null}
            {current.entries.length === 0 ? (
              <li {...stylex.props(styles.emptyFolder)}>
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
              <li {...stylex.props(styles.loadMore)}>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  {...stylex.props(styles.fullWidth)}
                  disabled={loadingMore}
                  onClick={onLoadMore}
                >
                  {loadingMore ? (
                    <Spinner {...stylex.props(styles.icon14)} />
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
      <div {...stylex.props(styles.footer)}>
        {addError ? (
          <p {...stylex.props(styles.message, styles.messageError)}>
            <AlertTriangle {...stylex.props(styles.icon14, styles.messageMark)} />
            {addError}
          </p>
        ) : null}
        <div {...stylex.props(styles.footerRow)}>
          <div {...stylex.props(styles.currentFolder)}>
            <p {...stylex.props(styles.currentFolderLabel)}>
              {t('localProjects.add.currentFolder', 'Current folder')}
            </p>
            {currentPathParts ? (
              <p {...stylex.props(styles.currentPath)} title={current?.path}>
                {currentPathParts.head ? (
                  <span {...stylex.props(styles.truncate, styles.pathHead)}>
                    {currentPathParts.head}
                  </span>
                ) : null}
                <span {...stylex.props(styles.pathTail)}>{currentPathParts.tail}</span>
              </p>
            ) : (
              <p {...stylex.props(styles.currentPath, styles.currentPathEmpty, styles.truncate)}>
                …
              </p>
            )}
          </div>
          <div {...stylex.props(styles.actions)}>
            <Button
              type="button"
              variant="secondary"
              size="small"
              onClick={onCancel}
              disabled={adding}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="small"
              disabled={!current || status !== 'ready' || adding}
              onClick={onAddCurrentFolder}
            >
              {adding ? (
                <Spinner {...stylex.props(styles.icon16)} />
              ) : (
                <FolderPlus {...stylex.props(styles.icon16)} />
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
      {...stylex.props(styles.entryRow, unreadable && styles.entryRowDisabled)}
    >
      <Icon {...stylex.props(styles.icon20, styles.secondary)} />
      <span {...stylex.props(styles.entryName, styles.truncate, entry.hidden && styles.secondary)}>
        {entry.name}
      </span>
      {registered ? (
        <Badge tone="success" icon={<Check {...stylex.props(styles.iconFill)} />}>
          {t('localProjects.add.added', 'Added')}
        </Badge>
      ) : unreadable ? (
        <Lock {...stylex.props(styles.icon16, styles.hint)} aria-hidden />
      ) : (
        <ChevronRight {...stylex.props(styles.icon16, styles.hint)} aria-hidden />
      )}
    </button>
  );
}

function DirectorySkeleton() {
  return (
    <div {...stylex.props(styles.skeleton)}>
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} {...stylex.props(styles.skeletonRow)}>
          <Skeleton width={20} height={20} />
          <div {...stylex.props(styles.skeletonLine(`${60 - index * 4}%`))}>
            <Skeleton width="100%" height={16} />
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusPanel({
  icon: Icon,
  spinning = false,
  title,
  description,
  action,
  tone = 'muted',
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
  tone?: 'muted' | 'destructive';
}) {
  return (
    <div {...stylex.props(styles.status, tone === 'destructive' && styles.statusDestructive)}>
      <Spinner icon={Icon} spinning={spinning} {...stylex.props(styles.statusIcon)} aria-hidden />
      <span {...stylex.props(styles.statusTitle)}>{title}</span>
      {description ? <span {...stylex.props(styles.statusDescription)}>{description}</span> : null}
      {action ? <div {...stylex.props(styles.statusAction)}>{action}</div> : null}
    </div>
  );
}

export interface AddLocalProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMobile?: boolean;
  /** Nested inside another dialog (desktop settings). Matches MCP's overlay. */
  backdropClassName?: string;
  machines: RemoteDirectoryPickerMachine[];
  machinesLoading?: boolean;
  initialMachineId?: RemoteDirectoryPickerArgs['initialMachineId'];
  ops: RemoteDirectoryOps;
  onAdded: RemoteDirectoryPickerArgs['onAdded'];
  onLocateRegistered?: RemoteDirectoryPickerArgs['onLocateRegistered'];
}

/**
 * Shell that renders the directory picker as a centered Dialog.Root on desktop and a
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
  backdropClassName,
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content backdropClassName={backdropClassName}>
        <Dialog.Title {...stylex.props(styles.srOnly)}>{a11yTitle}</Dialog.Title>
        <Dialog.Description {...stylex.props(styles.srOnly)}>{a11yDescription}</Dialog.Description>
        <RemoteDirectoryPicker
          machines={machines}
          machinesLoading={machinesLoading}
          initialMachineId={initialMachineId}
          ops={ops}
          onAdded={onAdded}
          onLocateRegistered={onLocateRegistered}
          onClose={close}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}
