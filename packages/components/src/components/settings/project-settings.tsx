import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, radius, space } from '@lody/ui/tokens/scales.stylex';
import { useOpenSettings } from '@/hooks/use-open-settings';
import type { TFunction } from 'i18next';
import { formatDistanceToNow, type Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { zhCN } from 'date-fns/locale/zh-CN';
import {
  AlertCircle,
  BrushCleaning,
  ChevronRight,
  Download,
  Ellipsis,
  ExternalLink,
  FolderPlus,
  FolderOpen,
  Github,
  Info,
  Plus,
  RefreshCw,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { Spinner } from '@lody/ui/spinner';
import {
  getLocalProjectHistoryProviderKey,
  type LocalProjectHistoryCatalogItem,
  type LocalProjectHistoryCatalogResult,
  type LocalProjectHistoryProvider,
  type LocalProjectHistoryProviderKey,
  type LocalProjectHistorySyncSummary,
  type LocalProjectMeta,
  machineSupportsLocalProjectRemovalProtocol,
  type MachineId,
  type WorktreeCleanupScriptConfig,
  type WorktreeSetupScriptConfig,
  type WorktreeSetupShell,
} from '@lody/shared';
import { useAtomValue } from 'jotai';
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  settingsSelectedMachineIdAtom,
  settingsSelectedProjectKeyAtom,
} from '@/atoms';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLocalProjectsAdmin } from '@/hooks/use-local-projects-admin';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import {
  useLocalProjectRemovalResultNotifications,
  usePendingLocalProjectRemovals,
  useRemoveLocalProject,
} from '@/hooks/use-remove-local-project';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import {
  RemoveLocalProjectDialog,
  type LocalProjectRemovalState,
  type PendingLocalProjectRemoval,
} from '@/components/loro-app-sidebar';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { CompactRow, CompactSection } from './compact-layout';
import { Button, type ButtonProps } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Checkbox } from '@lody/ui/checkbox';
import { Menu } from '@/ui/menu';
import { Switch } from '@lody/ui/switch';
import { Tabs } from '@lody/ui/tabs';
import { Badge } from '@lody/ui/badge';
import { Textarea } from '@lody/ui/textarea';
import { Input } from '@lody/ui/input';
import { VList } from 'virtua';

import { AlertDialog } from '@/ui/dialog';
import { Tooltip } from '@lody/ui/tooltip';
import { toIntlLocale } from '@/lib/intl-locale';
import { openExternalUrl } from '@/lib/native-browser';
import { withClassName } from '@/lib/stylex';
import { MobileProjectSettings } from '@/components/mobile/mobile-project-settings';
import { settingsSurface as surface } from './surface';
import { AgentIcon, getAgentDisplayName } from '@/components/icons/agent-icon';
import { useSettingsDataCache } from './settings-data-cache';
import { useGithubProjectWorktreeSaves } from '@/hooks/use-github-project-worktree-admin';
import {
  AddLocalProjectDialogContainer,
  useAddLocalProjectMachines,
} from '@/components/local-projects/add-local-project-dialog-container';
import { ProjectSkillsTab } from './project-skills-tab';
import type { ProjectSkillsSource } from '@/hooks/use-project-skills';
import { useAppCapability } from '@/lib/app-platform';
import { getVisibleLocalProjectHistoryFailures } from '@/lib/local-project-history-catalog';

export type ProjectSettingsRow = {
  key: string;
  machineId: MachineId;
  machineName: string;
  /** Shell this project's machine runs, probed from the machine OS. Local
     projects only edit this shell; the value drives which textarea we show. */
  shell: WorktreeSetupShell;
  project: LocalProjectMeta;
  sharedWithTeam: boolean;
  conversationCount: number;
  isUpdating: boolean;
  canUpdateSharing: boolean;
  worktreeSetup: WorktreeSetupScriptConfig;
  isWorktreeSetupLoading: boolean;
  isWorktreeSetupSaving: boolean;
  worktreeSetupError: string | null;
  worktreeCleanup: WorktreeCleanupScriptConfig;
  isWorktreeCleanupLoading: boolean;
  isWorktreeCleanupSaving: boolean;
  worktreeCleanupError: string | null;
  historyImports: ProjectHistoryImportState[];
};

export type ProjectHistoryImportState = {
  provider: LocalProjectHistoryProvider;
  providerKey: LocalProjectHistoryProviderKey;
  canSync: boolean;
  isSyncing: boolean;
  isImporting: boolean;
  catalog: LocalProjectHistoryCatalogResult | null;
  syncSummary: LocalProjectHistorySyncSummary | null;
  selectedSessionIds: string[];
  resolvingSessionIds: string[];
  errorMessage: string | null;
};

export type ProjectSettingsSection = {
  machineId: MachineId;
  machineName: string;
  sharedWithTeam: boolean;
  rows: ProjectSettingsRow[];
};

export type GithubProjectSettingsRow = {
  key: string;
  owner: string;
  repoFullName: string;
  name: string;
  private: boolean;
  worktreeSetup: WorktreeSetupScriptConfig;
  isWorktreeSetupSaving: boolean;
  worktreeSetupError: string | null;
  worktreeCleanup: WorktreeCleanupScriptConfig;
  isWorktreeCleanupSaving: boolean;
  worktreeCleanupError: string | null;
};

export type GithubProjectSettingsSection = {
  owner: string;
  rows: GithubProjectSettingsRow[];
};

type ProjectSettingsSelection =
  | { key: string; kind: 'local'; row: ProjectSettingsRow }
  | { key: string; kind: 'github'; row: GithubProjectSettingsRow };

/** A machine the current user is allowed to add folders to. */
export type AddableProjectMachine = {
  machineId: MachineId;
  machineName: string;
  online: boolean;
  sharedWithTeam?: boolean;
};

export type ProjectSettingsViewProps = {
  sections: ProjectSettingsSection[];
  githubSections: GithubProjectSettingsSection[];
  isLoading: boolean;
  githubProjectsLoading: boolean;
  initialMachineId?: MachineId | null;
  initialProjectKey?: string | null;
  onSharedWithTeamChange?: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
  onSyncHistory?: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
  onWorktreeSetupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onWorktreeCleanupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
  onGithubWorktreeSetupChange?: (
    row: GithubProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onGithubWorktreeCleanupChange?: (
    row: GithubProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
  /** Machines the current user may add folders to, including ones that have no
      project yet — those still get a pill so the folder can be added here. */
  addableMachines?: readonly AddableProjectMachine[];
  /** Opens the folder picker; a machine id pre-selects that machine. */
  onAddLocalProject?: (machineId?: MachineId | null) => void;
  onAddGitHubProject?: () => void;
  onOpenGitHubSettings?: () => void;
  canRemoveLocalProject?: (row: ProjectSettingsRow) => boolean;
  onRequestRemoveLocalProject?: (row: ProjectSettingsRow) => void;
  localProjectRemovalStateByKey?: ReadonlyMap<string, LocalProjectRemovalState>;
};

/* Desktop settings is itself a dialog: a nested overlay restacks at its z-index
   with a lighter veil. It is handed to the backdrop, which owns both of those
   properties itself, so it stays the class string the other settings dialogs
   (MCP, Agent Roles) pass there. */
const NESTED_SETTINGS_DIALOG_OVERLAY = 'z-[var(--z-dialog)] bg-black/20';

/** The global thin scrollbar; a `::-webkit-scrollbar` rule StyleX cannot state. */
const SCROLLBAR_CLASS = 'scrollbar-pro';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

/* The project editor is a wider panel than a dialog's default column, and its
   body scrolls edge to edge, so the panel drops its own padding and gap. */
/** A project is a window of its own: a rail of pages beside the page. */
const EDITOR_PANEL_STYLE: CSSProperties = {
  width: 'min(960px, 96vw)',
  height: 'min(680px, 88dvh)',
  maxWidth: 'none',
  padding: 0,
  gap: 0,
  overflow: 'hidden',
};

/** A script is code: it reads in the monospace face, a step under the field text. */
const SCRIPT_TEXTAREA_STYLE: CSSProperties = {
  fontFamily: MONO,
  fontSize: '12px',
  lineHeight: 1.625,
};

const styles = stylex.create({
  /* The page column, widened for the two panes and filling the panel height. */
  page: {
    height: '100%',
    minHeight: 0,
    maxWidth: { default: null, '@media (min-width: 768px)': '1152px' },
  },
  pageHeader: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    // On the same edge as the section names and the rows' text below it.
    paddingInline: space[4],
  },
  pageHeading: { minWidth: 0 },
  pageTitle: {
    margin: 0,
    fontSize: '1.125em',
    fontWeight: 400,
    lineHeight: 1.25,
    color: colors.label,
  },
  pageSubtitle: {
    margin: 0,
    marginTop: '2px',
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: '40px',
    fontSize: '0.875em',
    color: colors.secondaryLabel,
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    paddingInline: space[3],
    paddingBlock: '48px',
    textAlign: 'center',
  },
  emptyIcon: { width: '20px', height: '20px', color: colors.tertiaryLabel },
  emptyText: { margin: 0, fontSize: '0.875em', color: colors.secondaryLabel },

  /* The two-pane catalog: sources on the left, the selected source's folders
     on the right, both one sidebar list language; one structural line between. */
  catalog: {
    display: 'flex',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    gap: space[3],
  },
  /** Every source, stacked: one section each. */
  sources: { display: 'flex', flexDirection: 'column', gap: space[6], minWidth: 0 },
  /** One project: a line of its source's card. */
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    paddingInlineEnd: space[2],
  },
  lineButton: {
    display: 'flex',
    flexGrow: 1,
    alignItems: 'center',
    gap: space[3],
    minWidth: 0,
    margin: 0,
    paddingInlineStart: space[4],
    paddingInlineEnd: space[2],
    paddingBlock: '10px',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: '1em',
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
  },
  lineText: { display: 'flex', flexDirection: 'column', gap: '2px', flexGrow: 1, minWidth: 0 },
  lineName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: 1.25,
    color: colors.label,
  },
  lineCaption: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    fontSize: '0.75em',
    lineHeight: 1.3,
    color: colors.secondaryLabel,
  },
  lineMeta: {
    flexShrink: 0,
    fontSize: '0.8em',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  lineChevron: { flexShrink: 0, width: '14px', height: '14px', color: colors.tertiaryLabel },
  sourcePane: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    width: '220px',
    flexShrink: 0,
    overflowY: 'auto',
    paddingBlock: space[1],
  },
  folderPane: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
  },
  folderHeader: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    minHeight: '36px',
    paddingInline: space[2],
    paddingBlock: space[1],
  },
  folderTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    fontSize: '0.875em',
    fontWeight: 400,
    lineHeight: 1.25,
    color: colors.label,
  },
  folderList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: space[2],
  },
  ownerGroup: { display: 'flex', flexDirection: 'column', gap: '2px' },
  ownerGroupSpaced: { marginTop: space[2] },
  ownerLabel: {
    margin: 0,
    paddingInline: space[2],
    paddingTop: space[1],
    paddingBottom: '2px',
    fontSize: '0.75em',
    fontWeight: 400,
    color: colors.secondaryLabel,
  },
  machineEmpty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    paddingInline: space[2],
    paddingBlock: space[4],
  },
  note: { margin: 0, fontSize: '0.8em', lineHeight: 1.375, color: colors.secondaryLabel },

  /* What a list row holds beyond `surface.listRow*`: a caption under the name. */
  rowText: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    flexGrow: 1,
    minWidth: 0,
  },
  rowCaption: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.85em',
    lineHeight: 1.25,
    color: colors.secondaryLabel,
  },
  rowCaptionMono: { fontFamily: MONO },
  rowCaptionAside: { color: colors.tertiaryLabel },
  glyphBox: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
  },
  glyph: { width: '100%', height: '100%' },
  avatar: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
  statusDot: {
    width: '6px',
    height: '6px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.tertiaryLabel,
  },
  statusDotOnline: { backgroundColor: colors.success },
  metaGroup: { display: 'inline-flex', alignItems: 'center', gap: space[2] },
  metaItem: { display: 'inline-flex', alignItems: 'center', gap: space[1] },
  metaIcon: { width: '12px', height: '12px', flexShrink: 0 },
  /* A folder row carries a menu beside its button, so the row is the fill and
     the button inside it spans the row to the menu. */
  folderRow: { paddingBlock: 0, paddingInlineStart: 0, paddingInlineEnd: space[1] },
  folderRowButton: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: space[2],
    flexGrow: 1,
    minWidth: 0,
    margin: 0,
    paddingInlineStart: space[2],
    paddingInlineEnd: 0,
    paddingBlock: space[1],
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
  },
  removalMark: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    marginInlineEnd: space[1],
    color: colors.tertiaryLabel,
  },
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    margin: '-1px',
    padding: 0,
    borderWidth: 0,
  },

  /* Menu rows that say what they add under their name. */
  menuText: { display: 'flex', flexDirection: 'column', minWidth: 0, paddingBlock: space[1] },
  menuHint: { fontSize: '0.85em', color: colors.secondaryLabel },
  buttonIcon: { width: '14px', height: '14px', flexShrink: 0 },

  /* The project editor: a scroll body of stacked settings sections. */
  editorBody: { flexGrow: 1, minHeight: 0, overflowY: 'auto' },
  detail: { display: 'flex', flexDirection: 'column', gap: space[4], padding: space[4] },
  /* The dialog's cross sits in this corner; the header keeps clear of it. */
  detailHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space[2],
    minWidth: 0,
    paddingInlineEnd: '36px',
  },
  detailHeading: { flexGrow: 1, minWidth: 0 },
  detailTitleRow: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  detailTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    fontSize: '1em',
    fontWeight: 400,
    lineHeight: 1.25,
    color: colors.label,
  },
  pathRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    marginTop: '2px',
  },
  path: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    margin: 0,
    fontFamily: MONO,
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  detailNote: {
    margin: 0,
    marginTop: space[1],
    fontSize: '0.75em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  cardLine: { paddingInline: space[4], paddingBlock: space[3] },
  column: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  alignStart: { alignSelf: 'flex-start' },

  /* Worktree script editor. */
  editor: { display: 'flex', flexDirection: 'column', gap: space[3] },
  editorTitle: {
    margin: 0,
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    fontSize: '0.875em',
    fontWeight: 400,
    color: colors.label,
  },
  editorTitleIcon: { width: '16px', height: '16px', flexShrink: 0, color: colors.tertiaryLabel },
  editorDescription: {
    margin: 0,
    marginTop: space[1],
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  /* A link inside prose: the accent, underlined under the pointer. */
  docsLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    verticalAlign: 'baseline',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: colors.accent,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'start',
    textDecoration: { default: 'none', ':hover': 'underline' },
    textUnderlineOffset: '4px',
    cursor: 'pointer',
  },
  linkIcon: { width: '12px', height: '12px', flexShrink: 0 },
  editorLoading: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingBlock: space[6],
    fontSize: '0.8em',
    color: colors.secondaryLabel,
  },
  stack: { display: 'flex', flexDirection: 'column', gap: space[2] },
  scriptField: { display: 'flex', flexDirection: 'column', gap: space[1.5] },
  envHint: {
    margin: 0,
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[1.5],
    fontSize: '0.75em',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  hintIcon: { width: '14px', height: '14px', flexShrink: 0, marginTop: '1px' },
  saving: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[1],
    fontSize: '0.75em',
    color: colors.secondaryLabel,
  },
  error: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    fontSize: '0.8em',
    lineHeight: 1.375,
    color: colors.destructive,
  },
  breakWords: { minWidth: 0, overflowWrap: 'anywhere' },

  /* Conversation sync: the providers as lines of the card, then the panel. */
  providerRow: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    margin: 0,
    paddingInline: space[4],
    paddingBlock: space[2],
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    fontFamily: 'inherit',
    fontSize: '0.875em',
    fontWeight: 400,
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  providerRowActive: {
    backgroundColor: { default: colors.selectedFill, ':hover': colors.selectedFill },
    color: { default: colors.label, ':hover': colors.label },
  },
  providerIcon: { width: '14px', height: '14px', flexShrink: 0, opacity: 0.7 },
  providerLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexGrow: 1,
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    minHeight: 0,
    fontSize: '0.8em',
  },
  panelBar: {
    display: 'flex',
    flexShrink: 0,
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  panelStatus: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  panelActions: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[2] },
  panelError: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'flex-start',
    gap: space[2],
    maxHeight: '112px',
    overflowY: 'auto',
    paddingInline: space[4],
    paddingBlock: space[2],
    color: colors.destructive,
  },
  panelSummary: {
    flexShrink: 0,
    paddingInline: space[4],
    paddingBlock: space[1.5],
    color: colors.secondaryLabel,
  },
  failureList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    margin: 0,
    marginTop: space[1],
    paddingInlineStart: 0,
    listStyleType: 'none',
    color: colors.destructive,
  },
  panelLine: { flexShrink: 0, paddingInline: space[4], paddingBlock: space[2] },
  selectAll: { display: 'flex', minWidth: 0, alignItems: 'center', gap: space[2] },
  selectAllLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
  },
  historyEmpty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: '10px',
  },
  historyEmptyText: { margin: 0, lineHeight: 1.375, color: colors.secondaryLabel },
  sessionList: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  sessionRow: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[4],
    paddingBlock: space[2],
    cursor: 'pointer',
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  sessionRowDisabled: {
    cursor: 'default',
    opacity: 0.7,
    backgroundColor: { default: 'transparent', ':hover': 'transparent' },
  },
  sessionText: { flexGrow: 1, minWidth: 0 },
  sessionTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.label,
  },
  sessionTime: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.85em',
    color: colors.secondaryLabel,
  },
  conflict: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1] },
});

const EMPTY_WORKTREE_SETUP: WorktreeSetupScriptConfig = {
  scripts: {},
};

export function sortProjectRows(rows: ProjectSettingsRow[]): ProjectSettingsRow[] {
  return [...rows].sort((left, right) => {
    const createdAtDiff = (left.project.createdAtMs ?? 0) - (right.project.createdAtMs ?? 0);
    if (createdAtDiff !== 0) return createdAtDiff;
    return left.project.name.localeCompare(right.project.name);
  });
}

export function sortGithubProjectRows(
  rows: GithubProjectSettingsRow[]
): GithubProjectSettingsRow[] {
  return [...rows].sort((left, right) => left.repoFullName.localeCompare(right.repoFullName));
}

function projectPathTail(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

export function getHistoryProviderLabel(provider: LocalProjectHistoryProvider): string {
  return getAgentDisplayName(provider.cliType, provider.agentType) ?? provider.agentType;
}

function getHistoryCatalogFromProject(
  project: LocalProjectMeta,
  provider: LocalProjectHistoryProvider
) {
  return project.history?.[getLocalProjectHistoryProviderKey(provider)];
}

function sortHistoryCatalogItems(
  sessions: LocalProjectHistoryCatalogItem[]
): LocalProjectHistoryCatalogItem[] {
  return [...sessions].sort((left, right) => {
    const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (leftUpdatedAt !== rightUpdatedAt) return rightUpdatedAt - leftUpdatedAt;
    return left.title.localeCompare(right.title);
  });
}

export function catalogFromProject(
  project: LocalProjectMeta,
  provider: LocalProjectHistoryProvider
): LocalProjectHistoryCatalogResult | null {
  const catalog = getHistoryCatalogFromProject(project, provider);
  if (!catalog) return null;
  return {
    listed: Object.keys(catalog.sessions).length,
    lastListedAt: catalog.lastListedAt,
    sessions: sortHistoryCatalogItems(Object.values(catalog.sessions)),
  };
}

export function formatHistorySyncSummary(
  summary: LocalProjectHistorySyncSummary,
  t: TFunction
): string {
  return t('workspace.projects.historySyncSummary', {
    defaultValue:
      'Imported {{imported}}, refreshed {{refreshed}}, skipped {{skipped}}, conflicts {{conflicted}}, failed {{failed}}',
    imported: summary.imported,
    refreshed: summary.refreshed,
    skipped: summary.skipped,
    conflicted: summary.conflicted,
    failed: summary.failed,
  });
}

export function parseHistoryUpdatedAt(updatedAt: string | undefined): Date | null {
  if (!updatedAt) return null;
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function formatHistoryUpdatedAt(
  updatedAt: string | undefined,
  locale: Locale,
  t: TFunction
): string {
  const date = parseHistoryUpdatedAt(updatedAt);
  if (!date) {
    return t('workspace.projects.historyUnknownTime', 'Unknown time');
  }
  return formatDistanceToNow(date, { addSuffix: true, locale });
}

export function historyStateKey(projectKey: string, provider: LocalProjectHistoryProvider): string {
  return `${getLocalProjectHistoryProviderKey(provider)}:${projectKey}`;
}

export function ProjectSettingsComponent({
  initialMachineId,
  initialProjectKey,
}: {
  initialMachineId?: MachineId | null;
  initialProjectKey?: string | null;
} = {}) {
  const { openSettings } = useOpenSettings();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const modalMachineTarget = useAtomValue(settingsSelectedMachineIdAtom);
  const modalProjectTarget = useAtomValue(settingsSelectedProjectKeyAtom);
  const resolvedInitialMachineId =
    initialMachineId !== undefined ? initialMachineId : modalMachineTarget;
  const resolvedInitialProjectKey =
    initialProjectKey !== undefined ? initialProjectKey : modalProjectTarget;
  const [addLocalProjectDialogOpen, setAddLocalProjectDialogOpen] = useState(false);
  const [addLocalProjectMachineId, setAddLocalProjectMachineId] = useState<MachineId | null>(null);
  /* Same ownership rule the picker itself applies, so a machine the user may
     add to shows up here even before it has a single project. */
  const { machines: pickerMachines } = useAddLocalProjectMachines();
  const addableMachines = useMemo<AddableProjectMachine[]>(
    () =>
      pickerMachines
        .filter((machine) => machine.canAddProjects)
        .map((machine) => ({
          machineId: machine.id,
          machineName: machine.name,
          online: machine.online,
        })),
    [pickerMachines]
  );
  const handleAddLocalProject = useCallback((machineId?: MachineId | null) => {
    setAddLocalProjectMachineId(machineId ?? null);
    setAddLocalProjectDialogOpen(true);
  }, []);
  /* All state + handlers live in `useLocalProjectsAdmin` so the mobile
     per-project surface (`MobileLocalProjectSettings`) can drive the
     same data model without duplicating mutations / catalog state. */
  const {
    sections,
    isLoading,
    onSharedWithTeamChange,
    onSyncHistory,
    onImportHistory,
    onResolveHistoryConflict,
    onHistorySelectionChange,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
  } = useLocalProjectsAdmin();
  const { workspaceReposWithStatus, workspaceReposLoading } = useSettingsDataCache();
  const {
    setupSavingByKey: githubSetupSavingByKey,
    setupErrorByKey: githubSetupErrorByKey,
    cleanupSavingByKey: githubCleanupSavingByKey,
    cleanupErrorByKey: githubCleanupErrorByKey,
    onWorktreeSetupChange: saveGithubWorktreeSetup,
    onWorktreeCleanupChange: saveGithubWorktreeCleanup,
  } = useGithubProjectWorktreeSaves();

  const githubSections = useMemo(() => {
    const grouped = new Map<string, GithubProjectSettingsSection>();
    for (const repo of workspaceReposWithStatus ?? []) {
      const [owner] = repo.repoFullName.split('/');
      const ownerName = owner?.trim() || 'GitHub';
      const row: GithubProjectSettingsRow = {
        key: `github:${repo.repoFullName}`,
        owner: ownerName,
        repoFullName: repo.repoFullName,
        name: repo.name,
        private: repo.private,
        worktreeSetup: repo.worktreeSetup ?? EMPTY_WORKTREE_SETUP,
        isWorktreeSetupSaving: githubSetupSavingByKey[repo.repoFullName] === true,
        worktreeSetupError: githubSetupErrorByKey[repo.repoFullName] ?? null,
        worktreeCleanup: repo.worktreeCleanup ?? EMPTY_WORKTREE_SETUP,
        isWorktreeCleanupSaving: githubCleanupSavingByKey[repo.repoFullName] === true,
        worktreeCleanupError: githubCleanupErrorByKey[repo.repoFullName] ?? null,
      };
      const section = grouped.get(ownerName);
      if (section) {
        section.rows.push(row);
      } else {
        grouped.set(ownerName, { owner: ownerName, rows: [row] });
      }
    }
    return Array.from(grouped.values())
      .map((section) => ({ ...section, rows: sortGithubProjectRows(section.rows) }))
      .sort((left, right) => left.owner.localeCompare(right.owner));
  }, [
    githubCleanupErrorByKey,
    githubCleanupSavingByKey,
    githubSetupErrorByKey,
    githubSetupSavingByKey,
    workspaceReposWithStatus,
  ]);

  const onGithubWorktreeSetupChange = async (
    row: GithubProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => {
    await saveGithubWorktreeSetup(row.repoFullName, config);
  };

  const onGithubWorktreeCleanupChange = async (
    row: GithubProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => {
    await saveGithubWorktreeCleanup(row.repoFullName, config);
  };

  const handleAddGitHubProject = useCallback(() => {
    if (!workspaceSlug) return;
    openSettings('github');
  }, [openSettings, workspaceSlug]);

  const localMachineId = useAtomValue(localMachineIdAtom);
  const machineMetaMap = useAtomValue(getMachineMetaMapAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const visibleMachineIds = useMemo(() => sections.map((section) => section.machineId), [sections]);
  const pendingRemovals = usePendingLocalProjectRemovals(visibleMachineIds);
  useLocalProjectRemovalResultNotifications(visibleMachineIds);
  const { removeLocalProject, preflightLocalProjectRemoval, getRemoveLocalProjectImpact } =
    useRemoveLocalProject();
  const [pendingRemoval, setPendingRemoval] = useState<PendingLocalProjectRemoval | null>(null);
  const [isRemovingLocalProject, setIsRemovingLocalProject] = useState(false);

  const canRemoveLocalProject = useCallback((_row: ProjectSettingsRow) => {
    // This catalog is already owner-scoped. Protocol capability only gates
    // worktree cleanup inside the existing confirm dialog.
    return true;
  }, []);

  const localProjectRemovalStateByKey = useMemo(() => {
    const next = new Map<string, LocalProjectRemovalState>();
    for (const [key, pending] of pendingRemovals) {
      next.set(key, onlineMachineIds.has(pending.machineId) ? 'removing' : 'waiting_for_device');
    }
    return next;
  }, [onlineMachineIds, pendingRemovals]);

  const handleRequestRemoveLocalProject = useCallback(
    (row: ProjectSettingsRow) => {
      const impact = getRemoveLocalProjectImpact({
        machineId: row.machineId,
        localProjectId: row.project.id,
      });
      const rootPath = typeof row.project.rootPath === 'string' ? row.project.rootPath : null;
      setPendingRemoval({
        machineId: row.machineId,
        localProjectId: row.project.id,
        name: row.project.name,
        pathLabel: rootPath,
        originalRootPath: rootPath,
        conversationCount: impact.conversationCount,
        runningSessionCount: impact.runningSessionCount,
      });
    },
    [getRemoveLocalProjectImpact]
  );

  const handleConfirmRemoveLocalProject = useCallback(
    async (options: { cleanupWorktrees: boolean }) => {
      if (!pendingRemoval) return;
      setIsRemovingLocalProject(true);
      try {
        const removed = await removeLocalProject(
          {
            machineId: pendingRemoval.machineId,
            localProjectId: pendingRemoval.localProjectId,
            projectName: pendingRemoval.name,
            originalRootPath: pendingRemoval.originalRootPath ?? undefined,
          },
          options
        );
        if (removed) setPendingRemoval(null);
      } finally {
        setIsRemovingLocalProject(false);
      }
    },
    [pendingRemoval, removeLocalProject]
  );

  return (
    <>
      <ProjectSettingsView
        sections={sections}
        githubSections={githubSections}
        isLoading={isLoading}
        githubProjectsLoading={workspaceReposLoading}
        initialMachineId={resolvedInitialMachineId}
        initialProjectKey={resolvedInitialProjectKey}
        onSharedWithTeamChange={onSharedWithTeamChange}
        onSyncHistory={onSyncHistory}
        onImportHistory={onImportHistory}
        onResolveHistoryConflict={onResolveHistoryConflict}
        onHistorySelectionChange={onHistorySelectionChange}
        onWorktreeSetupChange={onWorktreeSetupChange}
        onWorktreeCleanupChange={onWorktreeCleanupChange}
        onGithubWorktreeSetupChange={onGithubWorktreeSetupChange}
        onGithubWorktreeCleanupChange={onGithubWorktreeCleanupChange}
        addableMachines={addableMachines}
        onAddLocalProject={handleAddLocalProject}
        onAddGitHubProject={workspaceSlug ? handleAddGitHubProject : undefined}
        onOpenGitHubSettings={workspaceSlug ? handleAddGitHubProject : undefined}
        canRemoveLocalProject={canRemoveLocalProject}
        onRequestRemoveLocalProject={handleRequestRemoveLocalProject}
        localProjectRemovalStateByKey={localProjectRemovalStateByKey}
      />
      <AddLocalProjectDialogContainer
        open={addLocalProjectDialogOpen}
        onOpenChange={setAddLocalProjectDialogOpen}
        initialMachineId={addLocalProjectMachineId}
        backdropClassName={NESTED_SETTINGS_DIALOG_OVERLAY}
      />
      <RemoveLocalProjectDialog
        open={pendingRemoval != null}
        target={pendingRemoval}
        isRemote={
          pendingRemoval != null && (!localMachineId || pendingRemoval.machineId !== localMachineId)
        }
        machineName={pendingRemoval ? machineMetaMap.get(pendingRemoval.machineId)?.name : null}
        deviceOnline={pendingRemoval != null && onlineMachineIds.has(pendingRemoval.machineId)}
        canCleanupWorktrees={
          pendingRemoval != null &&
          onlineMachineIds.has(pendingRemoval.machineId) &&
          machineSupportsLocalProjectRemovalProtocol(machineMetaMap.get(pendingRemoval.machineId))
        }
        isRemoving={isRemovingLocalProject}
        backdropClassName={NESTED_SETTINGS_DIALOG_OVERLAY}
        onOpenChange={(open) => {
          if (!open && !isRemovingLocalProject) setPendingRemoval(null);
        }}
        onPreflightCleanup={() => {
          if (!pendingRemoval) {
            return Promise.reject(new Error('No project selected.'));
          }
          return preflightLocalProjectRemoval({
            machineId: pendingRemoval.machineId,
            localProjectId: pendingRemoval.localProjectId,
          });
        }}
        onConfirm={(options) => {
          void handleConfirmRemoveLocalProject(options);
        }}
      />
    </>
  );
}

export function ProjectSettingsView(props: ProjectSettingsViewProps) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileProjectSettings {...props} /> : <ProjectSettingsDesktop {...props} />;
}

function ProjectSettingsDesktop({
  sections,
  githubSections,
  isLoading,
  githubProjectsLoading,
  onSharedWithTeamChange,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
  onGithubWorktreeSetupChange,
  onGithubWorktreeCleanupChange,
  addableMachines,
  onAddLocalProject,
  onAddGitHubProject,
  onOpenGitHubSettings,
  canRemoveLocalProject,
  onRequestRemoveLocalProject,
  localProjectRemovalStateByKey,
  initialMachineId,
  initialProjectKey,
}: ProjectSettingsViewProps) {
  const { t } = useTranslation();
  const onlineMachineIds = useOnlineMachineIds();
  const localMachineId = useAtomValue(localMachineIdAtom);

  const totalProjects = sections.reduce((sum, section) => sum + section.rows.length, 0);
  const totalGithubProjects = githubSections.reduce((sum, section) => sum + section.rows.length, 0);
  const totalCount = totalProjects + totalGithubProjects;
  const isAnyLoading = isLoading || githubProjectsLoading;

  /* One entry per machine that has local projects OR that the user may add a
     folder to, so a machine connected but still empty is reachable here
     instead of only from the generic add menu. */
  const machineEntries = useMemo<AddableProjectMachine[]>(() => {
    const byId = new Map<MachineId, AddableProjectMachine>();
    for (const section of sections) {
      byId.set(section.machineId, {
        machineId: section.machineId,
        machineName: section.machineName,
        online: onlineMachineIds.has(section.machineId),
        sharedWithTeam: section.sharedWithTeam,
      });
    }
    for (const machine of addableMachines ?? []) {
      if (byId.has(machine.machineId)) continue;
      byId.set(machine.machineId, {
        ...machine,
        online: machine.online || onlineMachineIds.has(machine.machineId),
      });
    }
    return [...byId.values()];
  }, [sections, addableMachines, onlineMachineIds]);

  const allSelections = useMemo<ProjectSettingsSelection[]>(() => {
    const github = githubSections.flatMap((section) =>
      section.rows.map((row) => ({ key: row.key, kind: 'github' as const, row }))
    );
    const local = sections.flatMap((section) =>
      section.rows.map((row) => ({ key: row.key, kind: 'local' as const, row }))
    );
    return [...github, ...local];
  }, [githubSections, sections]);

  const [editingProjectKey, setEditingProjectKey] = useState<string | null>(
    () => initialProjectKey ?? null
  );
  const editingProject =
    allSelections.find((selection) => selection.key === editingProjectKey) ?? null;

  const addProjectActions =
    onAddLocalProject || onAddGitHubProject ? (
      <ProjectAddMenu
        onAddLocalProject={onAddLocalProject ? () => onAddLocalProject() : undefined}
        onAddGitHubProject={onAddGitHubProject}
        variant="secondary"
      />
    ) : null;

  const addableMachineIds = useMemo(
    () => new Set((addableMachines ?? []).map((machine) => machine.machineId)),
    [addableMachines]
  );
  const addFolderLabel = t('workspace.projects.addFolder', 'Add folder');

  /* Arriving for one machine (from its "Add folder" elsewhere) scrolls its
     section into view rather than hiding every other source. */
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    if (!initialMachineId) return;
    sectionRefs.current.get(initialMachineId)?.scrollIntoView({ block: 'start' });
  }, [initialMachineId]);

  const detailHandlers = {
    onSharedWithTeamChange,
    onSyncHistory,
    onImportHistory,
    onResolveHistoryConflict,
    onHistorySelectionChange,
    onWorktreeSetupChange,
    onWorktreeCleanupChange,
    onGithubWorktreeSetupChange,
    onGithubWorktreeCleanupChange,
    onOpenGitHubSettings,
    canRemoveLocalProject,
    onRequestRemoveLocalProject,
    localProjectRemovalStateByKey,
    localMachineId,
    onlineMachineIds,
  };

  return (
    <>
      <div {...stylex.props(surface.container, styles.page)}>
        <div {...stylex.props(styles.pageHeader)}>
          <div {...stylex.props(styles.pageHeading)}>
            <h2 {...stylex.props(styles.pageTitle)}>{t('settings.tabs.projects', 'Projects')}</h2>
            <p {...stylex.props(styles.pageSubtitle)}>
              {t(
                'workspace.projects.settingsSubtitle',
                'Local folders and GitHub repositories available in this workspace.'
              )}
            </p>
          </div>
          {addProjectActions}
        </div>

        {isAnyLoading && totalCount === 0 ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner size="small" />
            {t('workspace.projects.loading', 'Loading projects')}
          </div>
        ) : totalCount === 0 && machineEntries.length === 0 ? (
          <div {...stylex.props(styles.empty)}>
            <FolderOpen {...stylex.props(styles.emptyIcon)} aria-hidden="true" />
            <p {...stylex.props(styles.emptyText)}>
              {t('workspace.projects.empty', 'No projects yet')}
            </p>
          </div>
        ) : (
          /* Every source at once, each a section: its name above, its projects
             as the ruled rows of one card. Nothing is hidden behind a picked
             source, and a project opens its editor in place. */
          <div {...stylex.props(styles.sources)}>
            {machineEntries.map((machine) => {
              const rows =
                sections.find((section) => section.machineId === machine.machineId)?.rows ?? [];
              const isThisMachine = Boolean(localMachineId && machine.machineId === localMachineId);
              const online = machine.online || isThisMachine;
              const canAdd = Boolean(onAddLocalProject && addableMachineIds.has(machine.machineId));
              const status = [
                isThisMachine
                  ? t('workspace.projects.thisMachine', 'This machine')
                  : online
                    ? t('workspace.machines.online', 'Online')
                    : t('workspace.machines.offline', 'Offline'),
                machine.sharedWithTeam ? t('workspace.projects.sharedBadge', 'Shared') : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <div
                  key={machine.machineId}
                  ref={(node) => {
                    if (node) sectionRefs.current.set(machine.machineId, node);
                    else sectionRefs.current.delete(machine.machineId);
                  }}
                >
                  <CompactSection
                    title={`${machine.machineName} · ${status}`}
                    headerRight={
                      canAdd ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="small"
                          title={t(
                            'workspace.projects.addFolderOnMachine',
                            'Add a folder on {{machine}}',
                            { machine: machine.machineName }
                          )}
                          onClick={() => onAddLocalProject?.(machine.machineId)}
                        >
                          <FolderPlus {...stylex.props(styles.buttonIcon)} />
                          {addFolderLabel}
                        </Button>
                      ) : null
                    }
                  >
                    {rows.length === 0 ? (
                      <p {...stylex.props(surface.cardNote)}>
                        {t(
                          'workspace.projects.machineEmpty',
                          'No folders added on this machine yet.'
                        )}
                      </p>
                    ) : (
                      rows.map((row) => (
                        <ProjectLine
                          key={row.key}
                          title={row.project.name}
                          caption={projectPathTail(row.project.rootPath)}
                          shared={row.sharedWithTeam}
                          conversationCount={row.conversationCount}
                          removalState={localProjectRemovalStateByKey?.get(row.key) ?? null}
                          canRemove={canRemoveLocalProject?.(row) === true}
                          onRemove={() => onRequestRemoveLocalProject?.(row)}
                          onOpen={() => setEditingProjectKey(row.key)}
                        />
                      ))
                    )}
                  </CompactSection>
                </div>
              );
            })}
            {githubSections.map((section, index) => (
              <CompactSection
                key={section.owner}
                title={`${section.owner} · ${t('chat.contextSwitch.github', 'GitHub')}`}
                headerRight={
                  index === 0 && onOpenGitHubSettings ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="small"
                      onClick={onOpenGitHubSettings}
                    >
                      <Github {...stylex.props(styles.buttonIcon)} />
                      {t('workspace.projects.manageInGithubSettings', 'Manage in GitHub settings')}
                    </Button>
                  ) : null
                }
              >
                {section.rows.map((row) => (
                  <ProjectLine
                    key={row.key}
                    title={row.name}
                    caption={row.repoFullName}
                    privateRepo={row.private}
                    onOpen={() => setEditingProjectKey(row.key)}
                  />
                ))}
              </CompactSection>
            ))}
          </div>
        )}
      </div>
      <Dialog.Root
        open={editingProject != null}
        onOpenChange={(open) => {
          if (!open) setEditingProjectKey(null);
        }}
      >
        <Dialog.Content
          backdropClassName={NESTED_SETTINGS_DIALOG_OVERLAY}
          style={EDITOR_PANEL_STYLE}
        >
          <Dialog.Title className={stylex.props(styles.srOnly).className}>
            {editingProject?.kind === 'local'
              ? editingProject.row.project.name
              : editingProject?.kind === 'github'
                ? editingProject.row.name
                : t('settings.tabs.projects', 'Projects')}
          </Dialog.Title>
          <Dialog.Description className={stylex.props(styles.srOnly).className}>
            {t(
              'workspace.projects.settingsSubtitle',
              'Local folders and GitHub repositories available in this workspace.'
            )}
          </Dialog.Description>
          {editingProject ? (
            <ProjectWindow
              key={editingProject.key}
              selection={editingProject}
              {...detailHandlers}
            />
          ) : null}
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

/**
 * A project as one line of its source's card: its name, where it lives, what
 * is true of it, and the way into its editor. The whole line opens it; the
 * trailing menu holds the one destructive action.
 */
function ProjectLine({
  title,
  caption,
  shared = false,
  privateRepo = false,
  conversationCount,
  removalState = null,
  canRemove = false,
  onRemove,
  onOpen,
}: {
  readonly title: string;
  readonly caption: string;
  readonly shared?: boolean;
  readonly privateRepo?: boolean;
  readonly conversationCount?: number;
  readonly removalState?: LocalProjectRemovalState | null;
  readonly canRemove?: boolean;
  readonly onRemove?: () => void;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation();
  const removalLabel =
    removalState === 'waiting_for_device'
      ? t('sidebar.localProjects.remove.waitingForDevice', 'Waiting for device…')
      : removalState === 'removing'
        ? t('sidebar.localProjects.remove.removing', 'Removing…')
        : null;
  const meta = [
    removalLabel,
    shared ? t('workspace.projects.sharedBadge', 'Shared') : null,
    privateRepo ? t('workspace.projects.privateRepo', 'Private') : null,
    conversationCount != null && conversationCount > 0
      ? t('workspace.projects.conversationCount', '{{count}} conversations', {
          count: conversationCount,
        })
      : null,
  ].filter(Boolean);
  return (
    <div {...stylex.props(styles.line, surface.pressableLine)}>
      <button type="button" onClick={onOpen} {...stylex.props(styles.lineButton)}>
        <span {...stylex.props(styles.lineText)}>
          <span {...stylex.props(styles.lineName)}>{title}</span>
          <span {...stylex.props(styles.lineCaption)}>{caption}</span>
        </span>
        {meta.length > 0 ? (
          <span {...stylex.props(styles.lineMeta)}>{meta.join(' · ')}</span>
        ) : null}
        {removalState === 'removing' ? <Spinner size="small" /> : null}
        <ChevronRight aria-hidden="true" {...stylex.props(styles.lineChevron)} />
      </button>
      {canRemove && onRemove && !removalLabel ? (
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="small"
                icon
                aria-label={t('sessions.moreActions', 'More actions')}
              />
            }
          >
            <Ellipsis {...stylex.props(styles.glyph)} />
          </Menu.Trigger>
          <Menu.Content align="end">
            <Menu.Item tone="destructive" onClick={() => onRemove()}>
              {t('workspace.projects.delete', 'Delete project')}
            </Menu.Item>
          </Menu.Content>
        </Menu.Root>
      ) : null}
    </div>
  );
}

function ProjectAddMenu({
  onAddLocalProject,
  onAddGitHubProject,
  size,
  variant,
}: {
  readonly onAddLocalProject?: () => void;
  readonly onAddGitHubProject?: () => void;
  readonly size?: ButtonProps['size'];
  readonly variant?: ButtonProps['variant'];
}) {
  const { t } = useTranslation();
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            type="button"
            variant={variant ?? 'ghost'}
            size={size ?? 'small'}
            icon
            aria-label={t('workspace.projects.addProjectMenu', 'Add project')}
            title={t('workspace.projects.addProjectMenu', 'Add project')}
          />
        }
      >
        <Plus {...stylex.props(styles.glyph)} />
      </Menu.Trigger>
      <Menu.Content align="end">
        {onAddLocalProject ? (
          <Menu.Item
            icon={<FolderPlus {...stylex.props(styles.glyph)} />}
            onClick={() => onAddLocalProject()}
          >
            <span {...stylex.props(styles.menuText)}>
              <span>{t('chat.contextSwitch.addProject', 'Add a folder')}</span>
              <span {...stylex.props(styles.menuHint)}>
                {t(
                  'chat.contextSwitch.addLocalProjectHint',
                  'Browse the machine and pick a folder'
                )}
              </span>
            </span>
          </Menu.Item>
        ) : null}
        {onAddGitHubProject ? (
          <Menu.Item
            icon={<Github {...stylex.props(styles.glyph)} />}
            onClick={() => onAddGitHubProject()}
          >
            <span {...stylex.props(styles.menuText)}>
              <span>{t('chat.contextSwitch.addGitHubRepo', 'Add a GitHub repository')}</span>
              <span {...stylex.props(styles.menuHint)}>
                {t('chat.contextSwitch.addGitHubRepoHint', 'Connect a GitHub repository')}
              </span>
            </span>
          </Menu.Item>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}

function ProjectWindow({
  selection,
  onSharedWithTeamChange,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
  onWorktreeSetupChange,
  onWorktreeCleanupChange,
  onGithubWorktreeSetupChange,
  onGithubWorktreeCleanupChange,
  onOpenGitHubSettings,
  canRemoveLocalProject,
  onRequestRemoveLocalProject,
  localProjectRemovalStateByKey,
  localMachineId,
  onlineMachineIds,
}: {
  readonly selection: ProjectSettingsSelection;
} & Omit<ProjectRowProps, 'row'> & {
    onGithubWorktreeSetupChange?: (
      row: GithubProjectSettingsRow,
      config: WorktreeSetupScriptConfig
    ) => Promise<void>;
    onGithubWorktreeCleanupChange?: (
      row: GithubProjectSettingsRow,
      config: WorktreeCleanupScriptConfig
    ) => Promise<void>;
    onOpenGitHubSettings?: () => void;
    canRemoveLocalProject?: (row: ProjectSettingsRow) => boolean;
    onRequestRemoveLocalProject?: (row: ProjectSettingsRow) => void;
    localProjectRemovalStateByKey?: ReadonlyMap<string, LocalProjectRemovalState>;
    localMachineId?: MachineId | null;
    onlineMachineIds?: ReadonlySet<MachineId>;
  }) {
  const { t } = useTranslation();
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const isLocal = selection.kind === 'local';
  const localRow = selection.kind === 'local' ? selection.row : null;
  const githubRow = selection.kind === 'github' ? selection.row : null;
  const [page, setPage] = useState<ProjectWindowPage>('general');

  const machineReachable = localRow
    ? (localMachineId != null && localRow.machineId === localMachineId) ||
      Boolean(onlineMachineIds?.has(localRow.machineId))
    : true;
  const removalState = localRow ? (localProjectRemovalStateByKey?.get(localRow.key) ?? null) : null;
  const skillsSource: ProjectSkillsSource | null = workspaceId
    ? localRow
      ? {
          kind: 'local',
          workspaceId,
          machineId: localRow.machineId,
          localProjectId: localRow.project.id,
        }
      : githubRow
        ? { kind: 'github', workspaceId, repoFullName: githubRow.repoFullName }
        : null
    : null;

  const historyCounts = useMemo(() => {
    const sessions = (localRow?.historyImports ?? []).flatMap(
      (state) => state.catalog?.sessions ?? []
    );
    return {
      available: sessions.filter((session) => historyStatusOf(session) === 'available').length,
      conflicts: sessions.filter((session) => historyStatusOf(session) === 'sync_conflict').length,
    };
  }, [localRow?.historyImports]);

  const pages: { id: ProjectWindowPage; label: string; count?: number; warn?: boolean }[] = [
    { id: 'general', label: t('workspace.projects.window.general', 'General') },
    { id: 'worktree', label: t('workspace.projects.window.worktree', 'Worktree') },
    { id: 'skills', label: t('workspace.projects.window.skills', 'Skills') },
    ...(isLocal
      ? [
          {
            id: 'conversations' as const,
            label: t('workspace.projects.window.conversations', 'Conversations'),
            // What needs the person: conflicts first, else what waits to import.
            count: historyCounts.conflicts || historyCounts.available || undefined,
            warn: historyCounts.conflicts > 0,
          },
        ]
      : []),
  ];

  // Where the project lives, split so its last segment can be the lit part.
  const location = localRow?.project.rootPath ?? githubRow?.repoFullName ?? '';
  const trimmedLocation = location.replace(/[\\/]+$/, '');
  const locationCut = trimmedLocation.search(/[^\\/]+$/);
  const locationHead = locationCut > 0 ? trimmedLocation.slice(0, locationCut) : '';
  const locationTail = locationCut > 0 ? trimmedLocation.slice(locationCut) : trimmedLocation;

  const offlineNote =
    localRow && !machineReachable ? (
      <p {...stylex.props(win.note)}>
        {t(
          'workspace.projects.selectedMachineOffline',
          '{{name}} is offline. Worktree setup and skills will load when it comes online.',
          { name: localRow.machineName }
        )}
      </p>
    ) : null;

  const pageDescription =
    page === 'general'
      ? t(
          'workspace.projects.window.generalDescription',
          'Where this project lives and who can use it.'
        )
      : page === 'worktree'
        ? t(
            'workspace.projects.window.worktreeDescription',
            'Scripts that run when a conversation gets its own worktree, and when it is archived.'
          )
        : page === 'skills'
          ? t(
              'workspace.projects.window.skillsDescription',
              'Skills the agent finds in this project.'
            )
          : t(
              'workspace.projects.window.conversationsDescription',
              'Bring conversations you had with an agent outside Lody into this workspace.'
            );

  return (
    <Tooltip.Provider delay={200}>
      <div {...stylex.props(win.window)}>
        {/* Four views of one project are a strip, not a sidebar: the name and
            where it lives above, the views under it, the page at full width. */}
        <header {...stylex.props(win.head)}>
          <h2 {...stylex.props(win.headName)} title={localRow?.project.name ?? githubRow?.name}>
            {localRow?.project.name ?? githubRow?.name}
          </h2>
          <p {...stylex.props(win.headMeta)}>
            <span {...stylex.props(win.headPath)} title={location}>
              <span {...stylex.props(win.headPathDim)}>{locationHead}</span>
              {locationTail}
            </span>
            {localRow ? (
              <>
                <span aria-hidden="true" {...stylex.props(win.headSep)}>
                  ·
                </span>
                <span
                  aria-hidden="true"
                  {...stylex.props(win.statusDot, machineReachable && win.statusDotOnline)}
                />
                <span {...stylex.props(win.headMachine)}>
                  {localRow.machineName} ·{' '}
                  {machineReachable
                    ? t('workspace.machines.online', 'Online')
                    : t('workspace.machines.offline', 'Offline')}
                </span>
              </>
            ) : (
              <>
                <span aria-hidden="true" {...stylex.props(win.headSep)}>
                  ·
                </span>
                <span {...stylex.props(win.headMachine)}>
                  {githubRow?.private
                    ? t('workspace.projects.privateRepo', 'Private')
                    : t('workspace.projects.window.public', 'Public')}
                </span>
              </>
            )}
          </p>
          <PageTabs pages={pages} current={page} onChange={setPage} />
        </header>

        <section {...stylex.props(win.main)}>
          <p {...stylex.props(win.pageDescription)}>{pageDescription}</p>

          {page === 'conversations' && localRow ? (
            <ConversationsPage
              row={localRow}
              onSyncHistory={onSyncHistory}
              onImportHistory={onImportHistory}
              onResolveHistoryConflict={onResolveHistoryConflict}
              onHistorySelectionChange={onHistorySelectionChange}
            />
          ) : (
            <div {...withClassName(stylex.props(win.pageBody), SCROLLBAR_CLASS)}>
              {page === 'general' && localRow ? (
                <>
                  {offlineNote}
                  <CompactSection>
                    <CompactRow
                      label={t('workspace.projects.window.folder', 'Folder')}
                      helper={<span {...stylex.props(win.mono)}>{localRow.project.rootPath}</span>}
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={() => copyProjectPath(localRow.project.rootPath, t)}
                      >
                        {t('sessions.copyPath', 'Copy path')}
                      </Button>
                      {getIpcServices() ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="small"
                          onClick={() => revealProjectPath(localRow.project.rootPath, t)}
                        >
                          {t('sidebar.localProjects.reveal', 'Reveal in file manager')}
                        </Button>
                      ) : null}
                    </CompactRow>
                    <CompactRow
                      label={t('workspace.projects.window.machine', 'Machine')}
                      helper={
                        removalState === 'waiting_for_device'
                          ? t(
                              'sidebar.localProjects.remove.waitingForDevice',
                              'Waiting for device…'
                            )
                          : removalState === 'removing'
                            ? t('sidebar.localProjects.remove.removing', 'Removing…')
                            : undefined
                      }
                    >
                      <span {...stylex.props(win.value)}>
                        {localRow.machineName} ·{' '}
                        {machineReachable
                          ? t('workspace.machines.online', 'Online')
                          : t('workspace.machines.offline', 'Offline')}
                      </span>
                    </CompactRow>
                  </CompactSection>
                  <ProjectShareControl
                    row={localRow}
                    onSharedWithTeamChange={onSharedWithTeamChange}
                  />
                  {canRemoveLocalProject?.(localRow) && onRequestRemoveLocalProject ? (
                    <CompactSection tone="danger">
                      <CompactRow
                        label={t('workspace.projects.delete', 'Delete project')}
                        helper={t(
                          'sidebar.localProjects.remove.originalDirectorySafe',
                          'Lody never deletes the original project folder or its files.'
                        )}
                      >
                        <Button
                          type="button"
                          variant="destructive"
                          size="small"
                          disabled={removalState != null}
                          onClick={() => onRequestRemoveLocalProject(localRow)}
                        >
                          {t('workspace.projects.delete', 'Delete project')}
                        </Button>
                      </CompactRow>
                    </CompactSection>
                  ) : null}
                </>
              ) : null}

              {page === 'general' && githubRow ? (
                <CompactSection>
                  <CompactRow
                    label={t('workspace.projects.window.repository', 'Repository')}
                    helper={<span {...stylex.props(win.mono)}>{githubRow.repoFullName}</span>}
                  >
                    {onOpenGitHubSettings ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="small"
                        onClick={onOpenGitHubSettings}
                      >
                        {t(
                          'workspace.projects.manageInGithubSettings',
                          'Manage in GitHub settings'
                        )}
                      </Button>
                    ) : null}
                  </CompactRow>
                  <CompactRow label={t('workspace.projects.window.visibility', 'Visibility')}>
                    <span {...stylex.props(win.value)}>
                      {githubRow.private
                        ? t('workspace.projects.privateRepo', 'Private')
                        : t('workspace.projects.window.public', 'Public')}
                    </span>
                  </CompactRow>
                </CompactSection>
              ) : null}

              {page === 'worktree' ? (
                <>
                  {offlineNote}
                  <CompactSection>
                    <div {...stylex.props(styles.cardLine)}>
                      {localRow ? (
                        <WorktreeSetupEditor
                          phase="setup"
                          config={localRow.worktreeSetup}
                          shell={localRow.shell}
                          isLoading={machineReachable && localRow.isWorktreeSetupLoading}
                          isSaving={localRow.isWorktreeSetupSaving}
                          errorMessage={
                            machineReachable &&
                            !isUnreachableMachineError(localRow.worktreeSetupError)
                              ? localRow.worktreeSetupError
                              : null
                          }
                          onSave={
                            machineReachable
                              ? (config) => onWorktreeSetupChange?.(localRow, config)
                              : undefined
                          }
                        />
                      ) : githubRow ? (
                        <WorktreeSetupEditor
                          phase="setup"
                          config={githubRow.worktreeSetup}
                          isSaving={githubRow.isWorktreeSetupSaving}
                          errorMessage={githubRow.worktreeSetupError}
                          onSave={(config) => onGithubWorktreeSetupChange?.(githubRow, config)}
                        />
                      ) : null}
                    </div>
                  </CompactSection>
                  <CompactSection>
                    <div {...stylex.props(styles.cardLine)}>
                      {localRow ? (
                        <WorktreeSetupEditor
                          phase="cleanup"
                          config={localRow.worktreeCleanup}
                          shell={localRow.shell}
                          isLoading={machineReachable && localRow.isWorktreeCleanupLoading}
                          isSaving={localRow.isWorktreeCleanupSaving}
                          errorMessage={
                            machineReachable &&
                            !isUnreachableMachineError(localRow.worktreeCleanupError)
                              ? localRow.worktreeCleanupError
                              : null
                          }
                          onSave={
                            machineReachable
                              ? (config) => onWorktreeCleanupChange?.(localRow, config)
                              : undefined
                          }
                        />
                      ) : githubRow ? (
                        <WorktreeSetupEditor
                          phase="cleanup"
                          config={githubRow.worktreeCleanup}
                          isSaving={githubRow.isWorktreeCleanupSaving}
                          errorMessage={githubRow.worktreeCleanupError}
                          onSave={(config) => onGithubWorktreeCleanupChange?.(githubRow, config)}
                        />
                      ) : null}
                    </div>
                  </CompactSection>
                </>
              ) : null}

              {page === 'skills' ? (
                localRow && !machineReachable ? (
                  <CompactSection>
                    <p {...stylex.props(surface.cardNote)}>
                      {t(
                        'workspace.projects.machineUnreachable',
                        'This machine isn’t connected. Worktree setup and skills will load when it comes online.'
                      )}
                    </p>
                  </CompactSection>
                ) : (
                  <CompactSection>
                    <div {...stylex.props(styles.cardLine)}>
                      <ProjectSkillsTab source={skillsSource} />
                    </div>
                  </CompactSection>
                )
              ) : null}
            </div>
          )}
        </section>
      </div>
    </Tooltip.Provider>
  );
}

type ProjectWindowPage = 'general' | 'worktree' | 'skills' | 'conversations';

/**
 * The window's views: words with a line under the current one that travels to
 * the next. They are the top of the window's hierarchy, so they are not the
 * tray strips the pages use for their own choices (agent, state) — a strip over
 * a strip reads as one level.
 */
function PageTabs({
  pages,
  current,
  onChange,
}: {
  readonly pages: readonly {
    id: ProjectWindowPage;
    label: string;
    count?: number;
    warn?: boolean;
  }[];
  readonly current: ProjectWindowPage;
  readonly onChange: (page: ProjectWindowPage) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const tab = list.querySelector<HTMLElement>(`[data-page="${current}"]`);
      if (tab) setLine({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    return observeResizeOnAnimationFrame(list, measure);
  }, [current, pages]);

  return (
    <div ref={listRef} role="tablist" {...stylex.props(win.pageTabs)}>
      {pages.map((entry) => {
        const selected = entry.id === current;
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={selected}
            data-page={entry.id}
            onClick={() => onChange(entry.id)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
              event.preventDefault();
              const index = pages.findIndex((page) => page.id === entry.id);
              const next =
                pages[
                  (index + (event.key === 'ArrowRight' ? 1 : -1) + pages.length) % pages.length
                ]!;
              onChange(next.id);
              listRef.current?.querySelector<HTMLElement>(`[data-page="${next.id}"]`)?.focus();
            }}
            tabIndex={selected ? 0 : -1}
            {...stylex.props(win.pageTab, selected && win.pageTabCurrent)}
          >
            {entry.label}
            {entry.count ? (
              <span {...stylex.props(win.tabCount, entry.warn && win.tabCountWarn)}>
                {entry.count}
              </span>
            ) : null}
          </button>
        );
      })}
      {line ? (
        <span
          aria-hidden="true"
          {...stylex.props(win.pageTabLine)}
          style={{ transform: `translateX(${line.left}px)`, width: `${line.width}px` }}
        />
      ) : null}
    </div>
  );
}

type HistoryStatus = 'available' | 'imported' | 'sync_conflict';
type HistoryFilter = 'all' | HistoryStatus;

const historyStatusOf = (session: LocalProjectHistoryCatalogItem): HistoryStatus =>
  session.status === 'imported' || session.status === 'sync_conflict'
    ? session.status
    : 'available';

/**
 * A project's conversations in another agent's history, at any size: one
 * agent at a time, found by search and narrowed by state, the list windowed so
 * five thousand scroll like five. "Select all" means what is shown, and the
 * import states how many it will bring in.
 */
function ConversationsPage({
  row,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
}: Pick<
  ProjectRowProps,
  | 'row'
  | 'onSyncHistory'
  | 'onImportHistory'
  | 'onResolveHistoryConflict'
  | 'onHistorySelectionChange'
>) {
  const { t, i18n } = useTranslation();
  const localeObj: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const intlLocale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language);
  const states = row.historyImports.filter((state) => state.canSync || state.catalog);
  const [providerKey, setProviderKey] = useState<string | null>(states[0]?.providerKey ?? null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [conflictToResolve, setConflictToResolve] = useState<LocalProjectHistoryCatalogItem | null>(
    null
  );
  const state = states.find((entry) => entry.providerKey === providerKey) ?? states[0] ?? null;

  const catalogSessions = state?.catalog?.sessions;
  const sessions = useMemo(() => catalogSessions ?? [], [catalogSessions]);
  const counts = useMemo(() => {
    const byStatus = { available: 0, imported: 0, sync_conflict: 0 };
    for (const session of sessions) byStatus[historyStatusOf(session)] += 1;
    return byStatus;
  }, [sessions]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sessions.filter(
      (session) =>
        (filter === 'all' || historyStatusOf(session) === filter) &&
        (!needle || session.title.toLowerCase().includes(needle))
    );
  }, [sessions, query, filter]);

  if (!state) {
    return (
      <div {...stylex.props(win.pageBody)}>
        <div {...stylex.props(win.empty)}>
          <p {...stylex.props(win.emptyText)}>
            {t(
              'workspace.projects.historySyncEmptyHint',
              'No agents detected on this machine yet. Conversation sync becomes available once an ACP agent has run here.'
            )}
          </p>
        </div>
      </div>
    );
  }

  const providerLabel = getHistoryProviderLabel(state.provider);
  const selected = new Set(state.selectedSessionIds);
  const canManage = state.canSync && !state.isImporting;
  const shownSelectable = canManage
    ? shown.filter((session) => historyStatusOf(session) === 'available')
    : [];
  const allShownSelected =
    shownSelectable.length > 0 &&
    shownSelectable.every((session) => selected.has(session.acpSessionId));
  const someShownSelected = shownSelectable.some((session) => selected.has(session.acpSessionId));
  const setSelection = (ids: Iterable<string>) =>
    onHistorySelectionChange?.(row, state.provider, [...new Set(ids)]);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  };
  const toggleShown = () => {
    const next = new Set(selected);
    for (const session of shownSelectable) {
      if (allShownSelected) next.delete(session.acpSessionId);
      else next.add(session.acpSessionId);
    }
    setSelection(next);
  };
  const sync = () => void onSyncHistory?.(row, state.provider);
  const lastListed =
    typeof state.catalog?.lastListedAt === 'number' ? new Date(state.catalog.lastListedAt) : null;
  const failures = state.syncSummary
    ? getVisibleLocalProjectHistoryFailures(state.syncSummary)
    : null;
  const syncButton = state.canSync ? (
    <Button
      type="button"
      variant="secondary"
      size="small"
      disabled={state.isSyncing || state.isImporting || !onSyncHistory}
      onClick={sync}
    >
      {state.isSyncing ? (
        <Spinner size="small" />
      ) : (
        <RefreshCw {...stylex.props(styles.buttonIcon)} />
      )}
      {state.catalog
        ? t('workspace.projects.syncHistoryAgain', 'Sync again')
        : t('workspace.projects.syncHistory', 'Sync')}
    </Button>
  ) : null;

  return (
    <div {...stylex.props(win.conversations)}>
      <div {...stylex.props(win.sourceRow)}>
        {states.length > 1 ? (
          <div {...stylex.props(win.hug)}>
            <Tabs.Root
              value={state.providerKey}
              onValueChange={(value) => setProviderKey(String(value))}
            >
              <Tabs.List size="small">
                {states.map((entry) => (
                  <Tabs.Tab key={entry.providerKey} value={entry.providerKey}>
                    <AgentIcon
                      cliType={entry.provider.cliType}
                      agentType={entry.provider.agentType}
                      className={stylex.props(win.agentGlyph).className}
                    />
                    {getHistoryProviderLabel(entry.provider)}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.Root>
          </div>
        ) : null}
        {sessions.length > 0 ? (
          <div {...stylex.props(win.toolbarEnd)}>
            <span {...stylex.props(win.status)}>
              {lastListed
                ? t('workspace.projects.historyLastSynced', {
                    defaultValue: 'Last synced {{relative}}',
                    relative: formatDistanceToNow(lastListed, {
                      addSuffix: true,
                      locale: localeObj,
                    }),
                  })
                : t('workspace.projects.historyNotSyncedYet', 'Not synced yet')}
            </span>
            {syncButton}
          </div>
        ) : null}
      </div>

      {sessions.length === 0 ? (
        <div {...stylex.props(win.empty)}>
          <p {...stylex.props(win.emptyText)}>
            {state.catalog
              ? t('workspace.projects.historyEmptyHint', {
                  defaultValue:
                    'Start a conversation for this project in {{provider}}, then sync again.',
                  provider: providerLabel,
                })
              : t('workspace.projects.historyInitialSyncHint', {
                  defaultValue:
                    "Find this project's conversations in {{provider}}, then choose which ones to import.",
                  provider: providerLabel,
                })}
          </p>
          {syncButton}
          {state.errorMessage ? <p {...stylex.props(win.error)}>{state.errorMessage}</p> : null}
        </div>
      ) : (
        <>
          <div {...stylex.props(win.toolbar)}>
            <div {...stylex.props(win.search)}>
              <Input
                size="small"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t(
                  'workspace.projects.history.searchPlaceholder',
                  'Search conversations'
                )}
                leading={<Search aria-hidden="true" {...stylex.props(styles.buttonIcon)} />}
              />
            </div>
            <Tabs.Root value={filter} onValueChange={(value) => setFilter(value as HistoryFilter)}>
              <Tabs.List size="small">
                <Tabs.Tab value="all">
                  {t('workspace.projects.history.filterAll', 'All')} {sessions.length}
                </Tabs.Tab>
                <Tabs.Tab value="available">
                  {t('workspace.projects.history.filterAvailable', 'To import')} {counts.available}
                </Tabs.Tab>
                <Tabs.Tab value="imported">
                  {t('workspace.projects.history.filterImported', 'Imported')} {counts.imported}
                </Tabs.Tab>
                {counts.sync_conflict > 0 ? (
                  <Tabs.Tab value="sync_conflict">
                    {t('workspace.projects.history.filterConflicts', 'Conflicts')}{' '}
                    {counts.sync_conflict}
                  </Tabs.Tab>
                ) : null}
              </Tabs.List>
            </Tabs.Root>
          </div>

          {state.errorMessage || state.syncSummary ? (
            <div {...stylex.props(win.report, Boolean(state.errorMessage) && win.reportError)}>
              {state.errorMessage ?? formatHistorySyncSummary(state.syncSummary!, t)}
              {failures && failures.failures.length > 0 ? (
                <ul {...stylex.props(styles.failureList)}>
                  {failures.failures.map((failure) => (
                    <li key={failure.acpSessionId} {...stylex.props(styles.breakWords)}>
                      {failure.acpSessionId}: {failure.message}
                    </li>
                  ))}
                  {failures.remaining > 0 ? (
                    <li>
                      {t('workspace.projects.historySyncMoreFailures', {
                        defaultValue: '{{count}} more failures',
                        count: failures.remaining,
                      })}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div {...stylex.props(surface.card, win.listCard)}>
            <div {...stylex.props(win.listHead)}>
              <label {...stylex.props(win.selectShown)}>
                <Checkbox
                  checked={allShownSelected}
                  indeterminate={someShownSelected && !allShownSelected}
                  disabled={shownSelectable.length === 0}
                  onCheckedChange={toggleShown}
                />
                {t('workspace.projects.history.selectShown', 'Select all {{count}} shown', {
                  count: shownSelectable.length,
                })}
              </label>
              <Button
                type="button"
                variant="primary"
                size="small"
                disabled={selected.size === 0 || !canManage || !onImportHistory}
                onClick={() => void onImportHistory?.(row, state.provider)}
              >
                {state.isImporting ? <Spinner size="small" /> : null}
                {selected.size > 0
                  ? t('workspace.projects.history.importCount', 'Import {{count}}', {
                      count: selected.size,
                    })
                  : t('workspace.projects.importSelectedHistory', 'Import')}
              </Button>
            </div>
            {shown.length === 0 ? (
              <p {...stylex.props(surface.cardNote, surface.lineRuled)}>
                {t('workspace.projects.history.noMatches', 'No conversations match.')}
              </p>
            ) : (
              <VList {...withClassName(stylex.props(win.list, surface.lineRuled), SCROLLBAR_CLASS)}>
                {shown.map((session, index) => {
                  const status = historyStatusOf(session);
                  const selectable = status === 'available' && canManage;
                  const isSelected = selected.has(session.acpSessionId);
                  const resolving = state.resolvingSessionIds.includes(session.acpSessionId);
                  const updated = parseHistoryUpdatedAt(session.updatedAt);
                  return (
                    <div
                      key={session.acpSessionId}
                      role="checkbox"
                      aria-checked={status === 'imported' || isSelected}
                      aria-disabled={!selectable}
                      tabIndex={selectable ? 0 : -1}
                      onClick={() => selectable && toggle(session.acpSessionId)}
                      onKeyDown={(event) => {
                        if (!selectable) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggle(session.acpSessionId);
                        }
                      }}
                      {...stylex.props(
                        win.session,
                        index > 0 && surface.lineRuled,
                        selectable && surface.pressableLine
                      )}
                    >
                      <Checkbox
                        checked={status === 'imported' || isSelected}
                        disabled={!selectable}
                        tabIndex={-1}
                        onClick={(event) => event.stopPropagation()}
                        onCheckedChange={() => selectable && toggle(session.acpSessionId)}
                      />
                      <span {...stylex.props(win.sessionText)}>
                        <span {...stylex.props(win.sessionTitle)}>{session.title}</span>
                        <span
                          {...stylex.props(win.sessionTime)}
                          title={updated ? updated.toLocaleString(intlLocale) : undefined}
                        >
                          {formatHistoryUpdatedAt(session.updatedAt, localeObj, t)}
                        </span>
                      </span>
                      {status === 'imported' ? (
                        <Badge>{t('workspace.projects.historyImported', 'Imported')}</Badge>
                      ) : null}
                      {status === 'sync_conflict' ? (
                        <span {...stylex.props(win.conflict)}>
                          <Badge tone="danger">
                            {t('workspace.projects.historyConflict', 'Conflict')}
                          </Badge>
                          <Button
                            type="button"
                            variant="ghost"
                            size="small"
                            disabled={
                              resolving ||
                              !state.canSync ||
                              state.isSyncing ||
                              state.isImporting ||
                              !session.importedSessionId ||
                              !onResolveHistoryConflict
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              setConflictToResolve(session);
                            }}
                          >
                            {resolving ? <Spinner size="small" /> : null}
                            {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
                          </Button>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </VList>
            )}
          </div>
        </>
      )}

      <AlertDialog.Root
        open={conflictToResolve !== null}
        onOpenChange={(open) => {
          if (!open) setConflictToResolve(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('workspace.projects.resolveHistoryConflictTitle', 'Re-import conversation?')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.projects.resolveHistoryConflictConfirm', {
                defaultValue:
                  'Re-import this conversation from {{provider}}? This replaces the current imported history with the latest source history and may discard local-only turns.',
                provider: providerLabel,
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              variant="destructive"
              onClick={() => {
                const session = conflictToResolve;
                setConflictToResolve(null);
                if (session) void onResolveHistoryConflict?.(row, state.provider, session);
              }}
            >
              {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}

/** The project window's own layout: a rail of pages beside the page. */
const win = stylex.create({
  window: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 },
  head: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flexShrink: 0,
    paddingTop: space[4],
    paddingInlineStart: space[6],
    // The dialog's close cross sits in this corner.
    paddingInlineEnd: '56px',
  },
  headName: {
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '17px',
    fontWeight: 600,
    lineHeight: 1.3,
    letterSpacing: '-0.01em',
    color: colors.label,
  },
  headMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.4,
    color: colors.secondaryLabel,
  },
  headPath: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: MONO,
    fontSize: '11.5px',
    color: colors.label,
  },
  headPathDim: { color: colors.tertiaryLabel },
  headSep: { flexShrink: 0, color: colors.tertiaryLabel },
  headMachine: { flexShrink: 0, whiteSpace: 'nowrap' },
  pageTabs: {
    position: 'relative',
    display: 'flex',
    alignItems: 'stretch',
    gap: '20px',
    marginTop: space[3],
  },
  pageTab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    height: '36px',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: '13.5px',
    fontWeight: 500,
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
    borderRadius: '4px',
    transitionProperty: 'color',
    transitionDuration: '150ms',
  },
  pageTabCurrent: { color: { default: colors.label, ':hover': colors.label } },
  /** The current view's line: it travels to the next rather than blinking. */
  pageTabLine: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: '2px',
    borderRadius: '9999px',
    backgroundColor: colors.label,
    transitionProperty: 'transform, width',
    transitionDuration: '240ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  },
  tabCount: {
    marginInlineStart: '2px',
    fontSize: '11px',
    fontWeight: 500,
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  tabCountWarn: { color: `color-mix(in oklab, ${colors.warning} 80%, ${colors.label})` },
  statusDot: {
    flexShrink: 0,
    width: '6px',
    height: '6px',
    borderRadius: '9999px',
    backgroundColor: colors.tertiaryLabel,
  },
  statusDotOnline: { backgroundColor: colors.success },
  main: { display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 },
  pageDescription: {
    flexShrink: 0,
    margin: 0,
    paddingTop: space[4],
    paddingBottom: space[3],
    paddingInline: space[6],
    fontSize: '12px',
    lineHeight: 1.45,
    color: colors.secondaryLabel,
  },
  pageBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[4],
    flexGrow: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingInline: space[6],
    paddingBottom: space[6],
  },
  note: { margin: 0, fontSize: '12px', lineHeight: 1.45, color: colors.secondaryLabel },
  mono: { fontFamily: MONO, overflowWrap: 'anywhere' },
  value: { fontSize: '0.9em', color: colors.secondaryLabel },

  conversations: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[3],
    flexGrow: 1,
    minHeight: 0,
    paddingInline: space[6],
    paddingBottom: space[6],
  },
  agentGlyph: { width: '14px', height: '14px' },
  /** A strip hugs its tabs instead of taking the column. */
  hug: { display: 'flex', alignSelf: 'flex-start' },
  toolbar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  search: { width: '220px', maxWidth: '100%' },
  /** Which agent's history, and when it was last read, with the way to re-read it. */
  sourceRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  toolbarEnd: { display: 'flex', alignItems: 'center', gap: space[2], marginInlineStart: 'auto' },
  status: { fontSize: '12px', color: colors.tertiaryLabel, whiteSpace: 'nowrap' },
  report: {
    fontSize: '12px',
    lineHeight: 1.45,
    color: colors.secondaryLabel,
    paddingInline: space[3],
    paddingBlock: space[2],
    backgroundColor: `color-mix(in oklab, transparent, ${colors.label} 3%)`,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
  reportError: { color: colors.destructive },
  listCard: { display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: '160px' },
  listHead: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: space[2],
  },
  selectShown: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[2],
    fontSize: '0.85em',
    color: colors.secondaryLabel,
    cursor: 'pointer',
  },
  list: { flexGrow: 1, minHeight: 0 },
  session: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: '10px',
    cursor: 'default',
    outlineStyle: 'none',
  },
  sessionText: { display: 'flex', flexDirection: 'column', gap: '2px', flexGrow: 1, minWidth: 0 },
  sessionTitle: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    lineHeight: 1.3,
    color: colors.label,
  },
  sessionTime: { fontSize: '0.8em', color: colors.tertiaryLabel },
  conflict: { display: 'inline-flex', alignItems: 'center', gap: space[1], flexShrink: 0 },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
    flexGrow: 1,
    minHeight: '200px',
    textAlign: 'center',
  },
  emptyText: {
    margin: 0,
    maxWidth: '380px',
    fontSize: '13px',
    lineHeight: 1.5,
    color: colors.secondaryLabel,
  },
  error: { margin: 0, maxWidth: '420px', fontSize: '12px', color: colors.destructive },
});

function isUnreachableMachineError(message: string | null | undefined): boolean {
  if (!message) return false;
  return (
    message.includes('machine_rpc_unavailable') || message.includes('CLI is not accepting RPC')
  );
}

function copyProjectPath(path: string, t: TFunction) {
  void navigator.clipboard
    .writeText(path)
    .then(() => toast.success(t('sessions.pathCopied', 'Path copied to clipboard')))
    .catch(() => toast.error(t('sessions.copyFailed', 'Unable to copy')));
}

function revealProjectPath(path: string, t: TFunction) {
  const services = getIpcServices();
  if (!services) {
    copyProjectPath(path, t);
    return;
  }
  void services.app.revealLocalPath(path).then((result) => {
    if (!result.revealed) {
      toast.error(t('sessions.fileActions.revealFailed', 'Unable to show this folder'));
    }
  });
}

function ProjectShareControl({
  row,
  onSharedWithTeamChange,
}: {
  readonly row: ProjectSettingsRow;
  readonly onSharedWithTeamChange?: (
    row: ProjectSettingsRow,
    sharedWithTeam: boolean
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  // Sharing is a cloud team surface; hide the control entirely on the local
  // (open-source) platform instead of rendering a permanently disabled switch.
  const teamSharingAvailable = useAppCapability('teamSharing');
  const tooltipLabel = !row.canUpdateSharing
    ? t(
        'workspace.projects.sharePreparing',
        'Sharing will be available when this machine finishes connecting.'
      )
    : row.sharedWithTeam
      ? t('workspace.projects.sharedWithTeam', 'Shared with team')
      : t('workspace.projects.private', 'Private to you');
  const scopeDescription = t(
    'workspace.projects.shareScopeDescription',
    'Sharing a project also shares its device, which teammates need to open and continue conversations.'
  );

  if (!teamSharingAvailable) {
    return null;
  }

  return (
    <CompactSection title={t('workspace.projects.shareLabel', 'Share project')}>
      <CompactRow label={tooltipLabel} helper={scopeDescription}>
        {row.isUpdating ? <Spinner size="small" /> : null}
        <Switch
          checked={row.sharedWithTeam}
          disabled={row.isUpdating || !row.canUpdateSharing || !onSharedWithTeamChange}
          aria-label={t('workspace.projects.shareToggle', {
            defaultValue: 'Share project with team',
          })}
          onCheckedChange={(checked) => {
            void onSharedWithTeamChange?.(row, checked);
          }}
        />
      </CompactRow>
    </CompactSection>
  );
}

export type ProjectRowProps = {
  row: ProjectSettingsRow;
  onSharedWithTeamChange?: (row: ProjectSettingsRow, sharedWithTeam: boolean) => Promise<void>;
  onSyncHistory?: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
  onWorktreeSetupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeSetupScriptConfig
  ) => Promise<void>;
  onWorktreeCleanupChange?: (
    row: ProjectSettingsRow,
    config: WorktreeCleanupScriptConfig
  ) => Promise<void>;
};

function buildWorktreeSetupConfig(args: {
  bash: string;
  powershell: string;
  timeoutMs?: number;
}): WorktreeSetupScriptConfig {
  const scripts = {
    ...(args.bash.trim() ? { bash: args.bash } : {}),
    ...(args.powershell.trim() ? { powershell: args.powershell } : {}),
  };
  return {
    scripts,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  };
}

function getWorktreeShellLabel(shell: WorktreeSetupShell): string {
  return shell === 'powershell' ? 'PowerShell' : 'Bash';
}

type WorktreeScriptPhase = 'setup' | 'cleanup';

function getWorktreeShellPlaceholder(
  shell: WorktreeSetupShell,
  phase: WorktreeScriptPhase
): string {
  if (phase === 'cleanup') {
    return shell === 'powershell'
      ? 'Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue'
      : 'rm -rf node_modules';
  }
  return shell === 'powershell'
    ? 'Copy-Item .env.example .env\npnpm install'
    : 'cp .env.example .env\npnpm install';
}

/* Each setup/cleanup run owns a child shell session: lines in the same script
   share env/cwd state with each other, but that shell still exits before the
   agent starts. Detect env assignment intent so the UI can explain that the
   value will not reach the agent process. */
function scriptSetsEphemeralEnv(shell: WorktreeSetupShell, script: string): boolean {
  if (shell === 'powershell') {
    return (
      /\$env:[A-Za-z_]\w*\s*=/.test(script) ||
      /\[Environment\]::SetEnvironmentVariable/i.test(script)
    );
  }
  return /(^|[\n;&|])\s*export\s+[A-Za-z_]/.test(script);
}

function getWorktreeScriptEnvDocsUrl(language: string | undefined): string {
  const isChinese = language?.toLowerCase().startsWith('zh') ?? false;
  const path = isChinese ? '/zh/docs/worktrees' : '/docs/worktrees';
  return `https://lody.ai${path}#available-environment-variables`;
}

export function WorktreeSetupEditor({
  phase = 'setup',
  config,
  isLoading,
  isSaving,
  errorMessage,
  onSave,
  shell,
}: {
  phase?: WorktreeScriptPhase;
  config: WorktreeSetupScriptConfig;
  isLoading?: boolean;
  isSaving?: boolean;
  errorMessage?: string | null;
  onSave?: (config: WorktreeSetupScriptConfig) => Promise<void> | void;
  /* When set, the project's machine runs exactly this shell (local
     projects, probed from the OS), so we render only that shell's
     textarea and leave the other shell's stored script untouched. When
     omitted (GitHub projects, clonable on either OS) we render Bash /
     PowerShell tabs so both can be edited. */
  shell?: WorktreeSetupShell;
}) {
  const { t, i18n } = useTranslation();
  const [bash, setBash] = useState(config.scripts.bash ?? '');
  const [powershell, setPowershell] = useState(config.scripts.powershell ?? '');
  /* Track the last config we received or wrote so the sync effect can
     tell an external/refetched config (adopt it) apart from the parent
     echoing back our own save (ignore it). Without this, a blur-save on
     one shell would reset an unsaved edit in the other shell's textarea.
     The parent only swaps the config reference on a successful save, so a
     failed save keeps the in-progress edits. */
  const committedRef = useRef(config);

  useEffect(() => {
    if (JSON.stringify(config) === JSON.stringify(committedRef.current)) return;
    committedRef.current = config;
    setBash(config.scripts.bash ?? '');
    setPowershell(config.scripts.powershell ?? '');
  }, [config]);

  const readOnly = isLoading || !onSave;
  /* Distinct glyph per phase so the stacked setup + cleanup editors read as
     two different steps at a glance. Cleanup uses a broom (not a trash can),
     which reads as "tidy up after the run" rather than "delete this section". */
  const PhaseIcon = phase === 'cleanup' ? BrushCleaning : Wrench;
  const title =
    phase === 'cleanup'
      ? t('workspace.projects.worktreeCleanupTitle', 'Worktree cleanup')
      : t('workspace.projects.worktreeSetupTitle', 'Worktree setup');
  const description =
    phase === 'cleanup'
      ? t(
          'workspace.projects.worktreeCleanupDescription',
          'Runs when the conversation is archived, before the worktree is removed from disk.'
        )
      : t(
          'workspace.projects.worktreeSetupDescription',
          'Runs after the git worktree is created and before the agent starts.'
        );
  const loadingLabel =
    phase === 'cleanup'
      ? t('workspace.projects.worktreeCleanupLoading', 'Loading cleanup script')
      : t('workspace.projects.worktreeSetupLoading', 'Loading setup script');
  const savingLabel =
    phase === 'cleanup'
      ? t('workspace.projects.worktreeCleanupSaving', 'Saving…')
      : t('workspace.projects.worktreeSetupSaving', 'Saving…');
  const envDocsUrl = getWorktreeScriptEnvDocsUrl(i18n.resolvedLanguage ?? i18n.language);
  const handleOpenEnvDocs = () => {
    void openExternalUrl(envDocsUrl);
  };

  const persist = (override: Partial<{ bash: string; powershell: string }>) => {
    const nextConfig = buildWorktreeSetupConfig({
      bash: override.bash ?? bash,
      powershell: override.powershell ?? powershell,
      timeoutMs: config.timeoutMs,
    });
    if (JSON.stringify(nextConfig) === JSON.stringify(config)) return;
    committedRef.current = nextConfig;
    void onSave?.(nextConfig);
  };

  const renderShellTextarea = (target: WorktreeSetupShell) => {
    const value = target === 'powershell' ? powershell : bash;
    const setValue = target === 'powershell' ? setPowershell : setBash;
    const showsEphemeralEnvHint = scriptSetsEphemeralEnv(target, value);
    return (
      <div {...stylex.props(styles.scriptField)}>
        <Textarea
          value={value}
          disabled={readOnly}
          rows={8}
          spellCheck={false}
          style={SCRIPT_TEXTAREA_STYLE}
          placeholder={getWorktreeShellPlaceholder(target, phase)}
          onChange={(event) => setValue(event.target.value)}
          onBlur={(event) =>
            persist(
              target === 'powershell'
                ? { powershell: event.target.value }
                : { bash: event.target.value }
            )
          }
        />
        {showsEphemeralEnvHint ? (
          <p {...stylex.props(styles.envHint)}>
            <Info {...stylex.props(styles.hintIcon)} aria-hidden="true" />
            <span {...stylex.props(styles.breakWords)}>
              {t(
                'workspace.projects.worktreeSetupEnvHint',
                "Environment variables set here only live inside this script — the agent process can't read them. Set the agent's environment variables in the agent config."
              )}
            </span>
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <div {...stylex.props(styles.editor)}>
      <div>
        <p {...stylex.props(styles.editorTitle)}>
          <PhaseIcon {...stylex.props(styles.editorTitleIcon)} aria-hidden="true" />
          {title}
        </p>
        <p {...stylex.props(styles.editorDescription)}>
          {description}{' '}
          <button type="button" {...stylex.props(styles.docsLink)} onClick={handleOpenEnvDocs}>
            {t(
              'workspace.projects.worktreeScriptEnvDocsLink',
              'Script environment variables are available'
            )}
            <ExternalLink {...stylex.props(styles.linkIcon)} aria-hidden="true" />
          </button>
        </p>
      </div>

      {isLoading ? (
        <div {...stylex.props(surface.formBlock, styles.editorLoading)}>
          <Spinner size="small" />
          {loadingLabel}
        </div>
      ) : shell ? (
        <div {...stylex.props(styles.stack)}>
          <Badge
            icon={<TerminalSquare {...stylex.props(styles.glyph)} />}
            {...stylex.props(styles.alignStart)}
          >
            {getWorktreeShellLabel(shell)}
          </Badge>
          {renderShellTextarea(shell)}
        </div>
      ) : (
        <Tabs.Root defaultValue="bash" {...stylex.props(styles.stack)}>
          <Tabs.List size="small" {...stylex.props(styles.alignStart)}>
            <Tabs.Tab value="bash">
              <TerminalSquare {...stylex.props(styles.buttonIcon)} aria-hidden="true" />
              Bash
            </Tabs.Tab>
            <Tabs.Tab value="powershell">
              <TerminalSquare {...stylex.props(styles.buttonIcon)} aria-hidden="true" />
              PowerShell
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="bash">{renderShellTextarea('bash')}</Tabs.Panel>
          <Tabs.Panel value="powershell">{renderShellTextarea('powershell')}</Tabs.Panel>
        </Tabs.Root>
      )}

      {isSaving ? (
        <div aria-live="polite" {...stylex.props(styles.saving)}>
          <Spinner size="small" />
          {savingLabel}
        </div>
      ) : null}

      {errorMessage ? (
        <div {...stylex.props(styles.error)}>
          <AlertCircle {...stylex.props(styles.hintIcon)} aria-hidden="true" />
          <span {...stylex.props(styles.breakWords)}>{errorMessage}</span>
        </div>
      ) : null}
    </div>
  );
}

type ProjectHistoryImportPanelProps = {
  row: ProjectSettingsRow;
  state: ProjectHistoryImportState;
  onSyncHistory?: (row: ProjectSettingsRow, provider: LocalProjectHistoryProvider) => Promise<void>;
  onImportHistory?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider
  ) => Promise<void>;
  onResolveHistoryConflict?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    session: LocalProjectHistoryCatalogItem
  ) => Promise<void>;
  onHistorySelectionChange?: (
    row: ProjectSettingsRow,
    provider: LocalProjectHistoryProvider,
    selectedIds: string[]
  ) => void;
};

export function ProjectHistoryImportPanel({
  row,
  state,
  onSyncHistory,
  onImportHistory,
  onResolveHistoryConflict,
  onHistorySelectionChange,
}: ProjectHistoryImportPanelProps) {
  const { t, i18n } = useTranslation();
  const localeObj: Locale = i18n.language?.startsWith('zh') ? zhCN : enUS;
  const intlLocale = toIntlLocale(i18n.resolvedLanguage ?? i18n.language);
  const providerLabel = getHistoryProviderLabel(state.provider);
  const catalogSessions = state.catalog?.sessions ?? [];
  const hasSyncedCatalog = state.catalog !== null;
  const hasCatalogSessions = catalogSessions.length > 0;
  const selectedSet = new Set(state.selectedSessionIds);
  const [conflictSessionToResolve, setConflictSessionToResolve] =
    useState<LocalProjectHistoryCatalogItem | null>(null);
  const canManageCatalog = state.canSync && !state.isImporting;
  const selectableSessions = state.canSync
    ? catalogSessions.filter(
        (session) => session.status !== 'imported' && session.status !== 'sync_conflict'
      )
    : [];
  const allSelectableSelected =
    selectableSessions.length > 0 &&
    selectableSessions.every((session) => selectedSet.has(session.acpSessionId));
  const someSelectableSelected = selectableSessions.some((session) =>
    selectedSet.has(session.acpSessionId)
  );
  const someButNotAllSelected = someSelectableSelected && !allSelectableSelected;
  const lastListedAtDate =
    typeof state.catalog?.lastListedAt === 'number' ? new Date(state.catalog.lastListedAt) : null;
  const statusLabel = lastListedAtDate
    ? t('workspace.projects.historyLastSynced', {
        defaultValue: 'Last synced {{relative}}',
        relative: formatDistanceToNow(lastListedAtDate, { addSuffix: true, locale: localeObj }),
      })
    : t('workspace.projects.historyNotSyncedYet', {
        defaultValue: 'Not synced yet',
      });
  const syncFailures = state.syncSummary
    ? getVisibleLocalProjectHistoryFailures(state.syncSummary)
    : null;

  const updateSelection = (selectedIds: string[]) => {
    onHistorySelectionChange?.(row, state.provider, selectedIds);
  };

  const confirmConflictReplace = () => {
    const session = conflictSessionToResolve;
    if (!session) return;
    setConflictSessionToResolve(null);
    void onResolveHistoryConflict?.(row, state.provider, session);
  };

  const toggleSession = (acpSessionId: string) => {
    const next = new Set(selectedSet);
    if (next.has(acpSessionId)) {
      next.delete(acpSessionId);
    } else {
      next.add(acpSessionId);
    }
    updateSelection([...next]);
  };

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      updateSelection([]);
      return;
    }
    updateSelection(selectableSessions.map((session) => session.acpSessionId));
  };

  /* The panel's blocks are lines of one surface: each one after the first is
     ruled from the one above it, never underlined. */
  const hasError = state.errorMessage !== null && state.errorMessage.length > 0;
  const hasSummary = state.syncSummary !== null;

  return (
    <>
      <div {...stylex.props(styles.panel)}>
        {hasCatalogSessions ? (
          <div {...stylex.props(styles.panelBar)}>
            <span {...stylex.props(styles.panelStatus)}>{statusLabel}</span>
            <div {...stylex.props(styles.panelActions)}>
              {state.canSync && (
                <Tooltip.Root>
                  <Tooltip.Trigger
                    render={
                      <Button
                        type="button"
                        variant="secondary"
                        size="mini"
                        disabled={state.isSyncing || state.isImporting}
                        onClick={() => {
                          void onSyncHistory?.(row, state.provider);
                        }}
                      >
                        {state.isSyncing ? (
                          <Spinner size="small" />
                        ) : (
                          <RefreshCw {...stylex.props(styles.buttonIcon)} />
                        )}
                        <span>{t('workspace.projects.syncHistory', 'Sync')}</span>
                      </Button>
                    }
                  />
                  <Tooltip.Content side="left">
                    {t('workspace.projects.syncHistoryTooltip', {
                      defaultValue: 'Sync {{provider}} history',
                      provider: providerLabel,
                    })}
                  </Tooltip.Content>
                </Tooltip.Root>
              )}
              <Button
                type="button"
                variant="secondary"
                size="mini"
                disabled={
                  state.selectedSessionIds.length === 0 || !canManageCatalog || !onImportHistory
                }
                onClick={() => {
                  void onImportHistory?.(row, state.provider);
                }}
              >
                {state.isImporting ? (
                  <Spinner size="small" />
                ) : (
                  <Download {...stylex.props(styles.buttonIcon)} />
                )}
                {t('workspace.projects.importSelectedHistory', {
                  defaultValue: 'Import',
                })}
              </Button>
            </div>
          </div>
        ) : null}
        {hasError ? (
          <div
            {...withClassName(
              stylex.props(styles.panelError, hasCatalogSessions && surface.lineRuled),
              SCROLLBAR_CLASS
            )}
          >
            <AlertCircle {...stylex.props(styles.hintIcon)} aria-hidden="true" />
            <span {...stylex.props(styles.breakWords)}>{state.errorMessage}</span>
          </div>
        ) : null}
        {state.syncSummary && (
          <div
            {...stylex.props(
              styles.panelSummary,
              (hasCatalogSessions || hasError) && surface.lineRuled
            )}
          >
            <div>{formatHistorySyncSummary(state.syncSummary, t)}</div>
            {syncFailures && syncFailures.failures.length > 0 ? (
              <ul {...stylex.props(styles.failureList)}>
                {syncFailures.failures.map((failure) => (
                  <li key={failure.acpSessionId} {...stylex.props(styles.breakWords)}>
                    {failure.acpSessionId}: {failure.message}
                  </li>
                ))}
                {syncFailures.remaining > 0 ? (
                  <li>
                    {t('workspace.projects.historySyncMoreFailures', {
                      defaultValue: '{{count}} more failures',
                      count: syncFailures.remaining,
                    })}
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}
        {hasCatalogSessions && (
          <div {...stylex.props(styles.panelLine, surface.lineRuled)}>
            <div
              role="button"
              tabIndex={selectableSessions.length === 0 || !canManageCatalog ? -1 : 0}
              aria-disabled={selectableSessions.length === 0 || !canManageCatalog}
              {...stylex.props(styles.selectAll)}
              onClick={() => {
                if (selectableSessions.length > 0 && canManageCatalog) {
                  toggleSelectAll();
                }
              }}
              onKeyDown={(event) => {
                if (selectableSessions.length === 0 || !canManageCatalog) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  toggleSelectAll();
                }
              }}
            >
              <Checkbox
                checked={allSelectableSelected}
                indeterminate={someButNotAllSelected}
                disabled={selectableSessions.length === 0 || !canManageCatalog}
                onCheckedChange={toggleSelectAll}
                onClick={(event) => event.stopPropagation()}
              />
              <span {...stylex.props(styles.selectAllLabel)}>
                {t('workspace.projects.selectAllHistory', {
                  defaultValue: 'Select all available ({{count}})',
                  count: selectableSessions.length,
                })}
              </span>
            </div>
          </div>
        )}
        {!hasCatalogSessions ? (
          <div
            {...stylex.props(styles.historyEmpty, (hasError || hasSummary) && surface.lineRuled)}
          >
            <p {...stylex.props(styles.historyEmptyText)}>
              {hasSyncedCatalog
                ? t('workspace.projects.historyEmptyHint', {
                    defaultValue:
                      'Start a conversation for this project in {{provider}}, then sync again.',
                    provider: providerLabel,
                  })
                : t('workspace.projects.historyInitialSyncHint', {
                    defaultValue:
                      "Find this project's conversations in {{provider}}, then choose which ones to import.",
                    provider: providerLabel,
                  })}
            </p>
            {state.canSync ? (
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={state.isSyncing || state.isImporting || !onSyncHistory}
                onClick={() => {
                  void onSyncHistory?.(row, state.provider);
                }}
              >
                {state.isSyncing ? (
                  <Spinner size="small" />
                ) : (
                  <RefreshCw {...stylex.props(styles.buttonIcon)} />
                )}
                <span>
                  {hasSyncedCatalog
                    ? t('workspace.projects.syncHistoryAgain', 'Sync again')
                    : t('workspace.projects.syncHistory', 'Sync')}
                </span>
              </Button>
            ) : null}
          </div>
        ) : (
          <div
            {...withClassName(stylex.props(styles.sessionList, surface.lineRuled), SCROLLBAR_CLASS)}
          >
            {catalogSessions.map((session, index) => {
              const imported = session.status === 'imported';
              const conflict = session.status === 'sync_conflict';
              const selectionDisabled = imported || conflict || !canManageCatalog;
              const resolving = state.resolvingSessionIds.includes(session.acpSessionId);
              const canResolveConflict =
                conflict &&
                state.canSync &&
                !state.isSyncing &&
                !state.isImporting &&
                !resolving &&
                Boolean(session.importedSessionId) &&
                Boolean(onResolveHistoryConflict);
              const selected = selectedSet.has(session.acpSessionId);
              const updatedAtDate = parseHistoryUpdatedAt(session.updatedAt);
              const updatedAtLabel = formatHistoryUpdatedAt(session.updatedAt, localeObj, t);
              const updatedAtTitle = updatedAtDate
                ? updatedAtDate.toLocaleString(intlLocale)
                : session.acpSessionId;
              return (
                <div
                  key={session.acpSessionId}
                  role="button"
                  tabIndex={selectionDisabled ? -1 : 0}
                  aria-disabled={selectionDisabled}
                  {...stylex.props(
                    styles.sessionRow,
                    index > 0 && surface.lineRuled,
                    selectionDisabled && styles.sessionRowDisabled
                  )}
                  onClick={() => {
                    if (!selectionDisabled) {
                      toggleSession(session.acpSessionId);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (selectionDisabled) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleSession(session.acpSessionId);
                    }
                  }}
                >
                  <Checkbox
                    checked={imported || selected}
                    disabled={selectionDisabled}
                    onClick={(event) => event.stopPropagation()}
                    onCheckedChange={() => {
                      if (!selectionDisabled) toggleSession(session.acpSessionId);
                    }}
                  />
                  <div {...stylex.props(styles.sessionText)}>
                    <div {...stylex.props(styles.sessionTitle)}>{session.title}</div>
                    <div {...stylex.props(styles.sessionTime)} title={updatedAtTitle}>
                      {updatedAtLabel}
                    </div>
                  </div>
                  {imported && <Badge>{t('workspace.projects.historyImported', 'Imported')}</Badge>}
                  {conflict && (
                    <div {...stylex.props(styles.conflict)}>
                      <Badge tone="danger">
                        {t('workspace.projects.historyConflict', 'Conflict')}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="mini"
                        disabled={!canResolveConflict}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (!canResolveConflict) return;
                          setConflictSessionToResolve(session);
                        }}
                      >
                        {resolving ? (
                          <Spinner size="small" />
                        ) : (
                          <RefreshCw {...stylex.props(styles.buttonIcon)} />
                        )}
                        <span>{t('workspace.projects.resolveHistoryConflict', 'Re-import')}</span>
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <AlertDialog.Root
        open={conflictSessionToResolve !== null}
        onOpenChange={(open) => {
          if (!open) setConflictSessionToResolve(null);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('workspace.projects.resolveHistoryConflictTitle', {
                defaultValue: 'Re-import conversation?',
              })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('workspace.projects.resolveHistoryConflictConfirm', {
                defaultValue:
                  'Re-import this conversation from {{provider}}? This replaces the current imported history with the latest source history and may discard local-only turns.',
                provider: providerLabel,
              })}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel', 'Cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action variant="destructive" onClick={confirmConflictReplace}>
              {t('workspace.projects.resolveHistoryConflict', 'Re-import')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );
}
