declare module '@/components/mobile/mobile-new-chat-sheet' {
  import type { ComponentType, ReactElement, ReactNode } from 'react';

  export type MobileNewChatSheetLabels = Record<string, string | undefined>;

  export interface MobileNewChatSheetContentProps {
    labels?: MobileNewChatSheetLabels;
    machineNode: ReactNode;
    contextTypeNode: ReactNode;
    perTypeNode?: ReactNode | null;
    branchNode?: ReactNode | null;
    secondaryPerTypeNode?: ReactNode | null;
    composer: ReactNode;
    belowComposerNode?: ReactNode;
    coordinator?: ComponentType<{ children: ReactNode }>;
    onClose?: () => void;
    showCloseButton?: boolean;
  }

  export function MobileNewChatSheetContent(props: MobileNewChatSheetContentProps): ReactElement;
}

declare module '@/components/mobile/mobile-inline-picker' {
  import type { ReactElement, ReactNode } from 'react';

  export type MobileInlinePickerOption<T extends string = string> = {
    value: T;
    label: string;
    description?: string;
    icon?: ReactNode;
  };

  export interface MobileInlinePickerProps<T extends string = string> {
    id: string;
    value: T | null | undefined;
    onChange: (value: T) => void;
    options: MobileInlinePickerOption<T>[];
    triggerContent: ReactNode;
    ariaLabel: string;
    emptyText?: ReactNode;
    disabled?: boolean;
    searchable?: boolean;
    searchPlaceholder?: string;
    triggerClassName?: string;
  }

  export function MobileInlinePicker<T extends string = string>(
    props: MobileInlinePickerProps<T>
  ): ReactElement;
  export function MobileInlinePickerCoordinator(props: { children: ReactNode }): ReactElement;
  export function MobileInlinePickerRowSlot(props: {
    children: ReactNode;
    slotClassName?: string;
  }): ReactElement;
}

declare module '@/components/chat/chat-landing-view' {
  import type { ClipboardEvent, KeyboardEvent, ReactElement, ReactNode, Ref } from 'react';

  export type ChatLandingTone = 'light' | 'dark';
  export type ChatLandingHintType = 'no-machine' | 'no-agent-config' | null;

  export interface ChatLandingViewProps {
    tone: ChatLandingTone;
    isMobile?: boolean;
    title: string;
    promptValue: string;
    onPromptChange: (value: string) => void;
    onPromptKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onPromptPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    promptPlaceholder?: string;
    promptEnterKeyHint?: 'send' | 'enter';
    promptRef?: Ref<HTMLTextAreaElement>;
    imageAddDisabled?: boolean;
    imageAddAriaLabel?: string;
    onImageAddClick?: () => void;
    selector?: ReactNode;
    topSelector?: ReactNode;
    footerSelector?: ReactNode;
    bottomBar?: ReactNode;
    composerStatusMessage?: ReactNode;
    composerStatusTone?: 'error' | 'warning' | 'info';
    contextSwitch?: ReactNode;
    submitDisabled?: boolean;
    onSubmit?: () => void;
    submitLabel?: string;
    submittingLabel?: string;
    hintType?: ChatLandingHintType;
    hintNoMachineMessage?: string;
    hintNoAgentConfigMessage?: string;
    hintGoToSettingsLabel?: string;
    hintDiscordMessage?: string;
    hintDiscordLabel?: string;
    onCopyCliCommand?: () => void;
    onGoToAgentSettings?: () => void;
    onOpenMobileDrawer?: () => void;
    leftSidebarExpandSlot?: ReactNode;
    resetKeys?: unknown[];
    errorLabels?: {
      somethingWentWrong?: string;
      composerCrashed?: string;
      tryAgain?: string;
      unavailable?: string;
    };
  }

  export function ChatLandingView(props: ChatLandingViewProps): ReactElement | null;
}

declare module '@/components/chat/visual-annotation-reference-chip' {
  import type { VisualAnnotationReferencePayload } from '@lody/shared';

  export interface VisualAnnotationReferenceChipItem {
    localId: string;
    reference: VisualAnnotationReferencePayload;
  }
}

declare module '@/components/chat/chat-composer' {
  import type {
    ClipboardEvent,
    KeyboardEvent,
    ReactElement,
    ReactNode,
    Ref,
    TextareaHTMLAttributes,
  } from 'react';
  import type { VisualAnnotationReferenceChipItem } from '@/components/chat/visual-annotation-reference-chip';

  export type ChatComposerTone = 'light' | 'dark';
  export type ChatComposerVariant = 'landing' | 'session' | 'dialog';
  export type ChatComposerStatusTone = 'error' | 'warning' | 'info';

  export interface ChatComposerAction {
    label: string;
    onClick: () => void | Promise<void>;
    disabled?: boolean;
    variant?: string;
    className?: string;
  }

  export interface ChatComposerProps {
    title?: ReactNode;
    tone?: ChatComposerTone;
    variant?: ChatComposerVariant;
    promptId?: string;
    promptValue: string;
    onPromptChange: (value: string) => void;
    onPromptKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
    onPromptPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
    promptPlaceholder?: string;
    promptDisabled?: boolean;
    promptRows?: number;
    promptEnterKeyHint?: TextareaHTMLAttributes<HTMLTextAreaElement>['enterKeyHint'];
    promptRef?: Ref<HTMLTextAreaElement>;
    selector?: ReactNode;
    topSelector?: ReactNode;
    footerSelector?: ReactNode;
    bottomBar?: ReactNode;
    statusMessage?: ReactNode;
    statusTone?: ChatComposerStatusTone;
    primaryAction: ReactNode;
    secondaryAction?: ChatComposerAction;
    className?: string;
    autoResize?: boolean;
    maxRows?: number;
    focusOnContainerClick?: boolean;
    onImageAddClick?: () => void;
    onFileAddClick?: () => void;
    imageAddDisabled?: boolean;
    fileAddDisabled?: boolean;
    visualAnnotationReferenceItems?: VisualAnnotationReferenceChipItem[];
    onVisualAnnotationReferenceRemove?: (localId: string) => void;
  }

  export function ChatComposer(props: ChatComposerProps): ReactElement | null;
}

declare module '@/components/chat/context-switch' {
  import type { ReactElement, ReactNode } from 'react';
  import type { ChatLandingTone } from '@/components/chat/chat-landing-view';

  export type SessionContextType = 'local' | 'github' | 'chat';

  export interface DisabledTabOverlay {
    label: ReactNode;
    onClick?: () => void;
  }

  export interface ContextSwitchProps {
    value: SessionContextType;
    onChange: (value: SessionContextType) => void;
    tone: ChatLandingTone;
    localLabel?: string;
    githubLabel?: string;
    chatLabel?: string;
    localDisabled?: DisabledTabOverlay;
    githubDisabled?: DisabledTabOverlay;
    className?: string;
    triggerJustifyClassName?: string;
    iconLeftLabelCentered?: boolean;
  }

  export function ContextSwitch(props: ContextSwitchProps): ReactElement | null;
}

declare module '@/components/chat/unified-project-selector' {
  import type { ReactElement } from 'react';

  export type LocalProjectSelection = {
    machineId: string;
    localProjectId: string;
  };

  export type UnifiedProjectSelection =
    | { kind: 'none' }
    | ({ kind: 'local' } & LocalProjectSelection)
    | { kind: 'github'; repoFullName: string };

  export type UnifiedLocalProjectOption = {
    key: string;
    machineId: string;
    localProjectId: string;
    name: string;
    rootPath: string;
    lastUsedAt?: number;
  };

  export function UnifiedProjectSelectorView(props: {
    value: UnifiedProjectSelection;
    onChange: (selection: UnifiedProjectSelection) => void;
    localProjects: ReadonlyArray<UnifiedLocalProjectOption>;
    repositories?: ReadonlyArray<{ fullName: string; description?: string | null }>;
    className?: string;
    latestMessageAtByRepo?: ReadonlyMap<string, number>;
    onAddLocalProject: () => void;
    onConnectGitRepo: () => void;
  }): ReactElement;
}

declare module '@/components/page-headers/base-header' {
  import type { CSSProperties, ReactElement, ReactNode } from 'react';

  export function BaseHeader(props: {
    title: ReactNode;
    actions?: ReactNode;
    className?: string;
    style?: CSSProperties;
    hideMenuButton?: boolean;
    leading?: ReactNode;
    truncateTitle?: boolean;
  }): ReactElement;
}

declare module '@/components/mobile/glass-icon-button' {
  import type { ReactElement, ReactNode } from 'react';

  export function GlassIconButton(props: {
    label: string;
    onClick?: () => void;
    children: ReactNode;
    className?: string;
    discSize?: number;
  }): ReactElement;
}

declare module '@/components/mobile/mobile-session-tab-sheet' {
  import type { ReactElement } from 'react';

  export function MobileSessionTabButton(props: {
    hasUnread: boolean;
    hasWorking?: boolean;
    onOpen: () => void;
    className?: string;
    ariaLabel?: string;
  }): ReactElement;
}

declare module '@/components/chat/chat-landing-selectors' {
  import type { ReactElement, ReactNode } from 'react';
  import type { ChatLandingTone } from '@/components/chat/chat-landing-view';

  export function getSelectorTagClassName(tone: ChatLandingTone): string;
  export function getModeIcon(modeId: string | null): ReactNode;

  export interface BranchSelectorProps {
    value: string | null;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string; description?: string }>;
    tone: ChatLandingTone;
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    disabled?: boolean;
    loading?: boolean;
    loadingText?: string;
    className?: string;
    contentClassName?: string;
  }

  export function BranchSelector(props: BranchSelectorProps): ReactElement;
}

declare module '@/components/shared/workdir-mode-selector' {
  import type { ReactElement } from 'react';

  export type WorkdirMode = 'local' | 'worktree';

  export interface WorkdirModeSelectorProps {
    tone: 'light' | 'dark';
    mode: WorkdirMode;
    onModeChange?: (next: WorkdirMode) => void;
    worktreeAvailable: boolean;
    worktreeUnavailableReason?: string;
    modal?: boolean;
  }

  export function WorkdirModeSelector(props: WorkdirModeSelectorProps): ReactElement;

  export interface WorktreeCheckboxPillProps {
    checked: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    disabledReason?: string;
    className?: string;
  }

  export function WorktreeCheckboxPill(props: WorktreeCheckboxPillProps): ReactElement;
}

declare module '@/lib/commands' {
  export function registerBuiltInCommands(): void;
}

declare module '@/lib/utils' {
  export function cn(...inputs: unknown[]): string;
}

declare module '@/components/icons/agent-icon' {
  import type { ReactElement } from 'react';

  export function AgentIcon(props: {
    cliType: 'builtin' | 'custom' | 'registry';
    agentType: string;
    brandId?: string;
    env?: Record<string, string>;
    className?: string;
  }): ReactElement | null;
}

declare module '@/components/mobile/mobile-home-screen' {
  import type { ReactElement } from 'react';

  export type MobileHomeTab = 'inbox' | 'chat' | 'projects';
  export type MobileProjectsSubTab = 'local' | 'github';
  export type MobileConversationKind = 'chat' | 'local' | 'github';
  export type MobilePrStatus = 'open' | 'merged' | 'closed' | 'draft';
  export type MobileChatGroupBy = 'none' | 'project';

  export type MobileHomeWorkspace = {
    id: string;
    name: string;
    avatarUrl?: string | null;
  };

  export type MobileHomeWorkspaceOption = MobileHomeWorkspace & {
    isActive?: boolean;
  };

  export type MobileHomeMachine = {
    id: string;
    name: string;
    isOnline: boolean;
  };

  export type MobileHomeLocalProject = {
    id: string;
    machineId: string;
    name: string;
    path: string;
    conversationCount: number;
    latestMessageAt?: number | null;
    unreadCount?: number;
  };

  export type MobileHomeGitHubRepository = {
    id: string;
    name: string;
    fullName: string;
    ownerHandle: string;
    ownerAvatarUrl?: string | null;
    description?: string | null;
    conversationCount?: number;
    latestMessageAt?: number | null;
    unreadCount?: number;
  };

  export type MobileConversationItem = {
    id: string;
    title: string;
    kind?: MobileConversationKind | null;
    branchName?: string | null;
    prNumber?: number | null;
    prStatus?: MobilePrStatus | null;
    addedLines?: number;
    deletedLines?: number;
    latestMessageAt?: number | null;
    ageLabel?: string;
    isWorking?: boolean;
    isWaitingPermission?: boolean;
    isOffline?: boolean;
    hasUnreadMessages?: boolean;
    isPinned?: boolean;
    /** Isolated git worktree — shows the worktree marker on the row. */
    isWorktree?: boolean;
    machineId?: string | null;
    projectKey?: string | null;
    projectLabel?: string | null;
    projectAvatarUrl?: string | null;
  };

  export type MobileHomeScreenLabels = {
    switchWorkspace?: string;
    projectsTab?: string;
    localTab?: string;
    githubTab?: string;
    chatTab?: string;
    allChatsHeading?: string;
    searchPlaceholder?: string;
    searchAriaLabel?: string;
    clearSearchAriaLabel?: string;
    emptyChats?: string;
    emptySearch?: string;
    newChatAriaLabel?: string;
    conversationCount?: (count: number) => string;
  };

  export interface MobileHomeScreenProps {
    workspace: MobileHomeWorkspace;
    workspaceOptions?: MobileHomeWorkspaceOption[];
    machines: MobileHomeMachine[];
    connectionUiState?: string;
    isInitialDataLoading?: boolean;
    selectedTab: MobileHomeTab;
    selectedProjectsSubTab?: MobileProjectsSubTab;
    onProjectsSubTabSelect?: (sub: MobileProjectsSubTab) => void;
    localProjects: MobileHomeLocalProject[];
    recentLocalProjects?: unknown[];
    githubRepositories: MobileHomeGitHubRepository[];
    recentGitHubRepos?: unknown[];
    chats: MobileConversationItem[];
    chatFilterPills?: ReadonlyArray<Record<string, unknown>>;
    chatGroupBy?: MobileChatGroupBy;
    hasActiveChatFilters?: boolean;
    onClearChatFilters?: () => void;
    labels?: MobileHomeScreenLabels;
    theme?: 'ios' | 'material';
    onWorkspaceMenuOpen?: () => void;
    onTabSelect?: (tab: MobileHomeTab) => void;
    onLocalProjectSelect?: (projectId: string) => void;
    onGitHubRepositorySelect?: (repoFullName: string) => void;
    onChatSelect?: (chatId: string) => void;
    onNewChat?: () => void;
    showArchived?: boolean;
    onShowArchivedToggle?: () => void;
  }

  export function MobileHomeScreen(props: MobileHomeScreenProps): ReactElement | null;
}

declare module '@/components/shared/option-selector' {
  import type { ComponentType, ReactElement, ReactNode } from 'react';
  import type { LucideIcon } from 'lucide-react';

  export interface OptionSelectorOption<TValue extends string | number = string> {
    value: TValue;
    label: string;
    key?: string;
    icon?: LucideIcon | ComponentType<{ className?: string }>;
    iconClassName?: string;
    startContent?: ReactNode;
    endContent?: ReactNode;
    description?: string;
    disabled?: boolean;
  }

  export interface OptionSelectorProps<TValue extends string | number = string> {
    value?: TValue | null;
    options: OptionSelectorOption<TValue>[];
    onSelect: (option: OptionSelectorOption<TValue>) => void;
    placeholder?: string;
    placeholderIcon?: LucideIcon | ComponentType<{ className?: string }>;
    className?: string;
    contentClassName?: string;
    disabled?: boolean;
    searchable?: boolean;
    searchPlaceholder?: string;
    emptyText?: string;
    align?: 'start' | 'center' | 'end';
    size?: 'sm' | 'md' | 'lg';
    tone?: 'light' | 'dark';
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    renderTriggerValue?: (option?: OptionSelectorOption<TValue>) => ReactNode;
    renderOption?: (option: OptionSelectorOption<TValue>, isSelected: boolean) => ReactNode;
    autoFocusSearch?: boolean;
  }

  export function OptionSelector<TValue extends string | number = string>(
    props: OptionSelectorProps<TValue>
  ): ReactElement | null;
}

declare module '@/components/shared/acp-selector-options' {
  import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

  export const CODEX_COLLABORATION_MODE_CONFIG_ID: 'collaboration_mode';
  export const CODEX_COLLABORATION_MODE_DEFAULT_VALUE: 'default';
  export const CODEX_COLLABORATION_MODE_PLAN_VALUE: 'plan';
  export const CODEX_FAST_MODE_CONFIG_ID: 'fast-mode';

  export type AcpConfigOptionValue = string | boolean;

  type AcpConfigOptionSelectorBase = {
    configId: string;
    label: string;
    description?: string;
    category?: string;
  };

  export type AcpSelectConfigOptionSelector = AcpConfigOptionSelectorBase & {
    type: 'select';
    options: AcpSessionSelectOption[];
    currentValue: string;
  };

  export type AcpBooleanConfigOptionSelector = AcpConfigOptionSelectorBase & {
    type: 'boolean';
    options: [];
    currentValue: boolean;
  };

  export type AcpConfigOptionSelector =
    | AcpSelectConfigOptionSelector
    | AcpBooleanConfigOptionSelector;
}

declare module '@/components/shared/acp-session-select' {
  export type AcpSessionSelectOption = {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  };
}

declare module '@/components/shared/acp-inline-selector-group' {
  import type { ReactElement } from 'react';
  import type {
    AcpConfigOptionSelector,
    AcpConfigOptionValue,
  } from '@/components/shared/acp-selector-options';
  import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

  export interface AcpFooterSelectorGroupProps {
    tone: 'light' | 'dark';
    modelOptions?: AcpSessionSelectOption[];
    selectedModelId?: string | null;
    onModelChange?: (value: string) => void;
    configOptionSelectors?: AcpConfigOptionSelector[];
    configOptionValues?: Record<string, AcpConfigOptionValue>;
    onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
    contentClassName?: string;
  }

  export function AcpFooterSelectorGroup(props: AcpFooterSelectorGroupProps): ReactElement | null;

  export interface AcpBottomBarModeSelectorProps {
    tone: 'light' | 'dark';
    modeOptions?: AcpSessionSelectOption[];
    selectedModeId?: string | null;
    onModeChange?: (value: string) => void;
    configOptionSelectors?: AcpConfigOptionSelector[];
    configOptionValues?: Record<string, AcpConfigOptionValue>;
    onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
    contentClassName?: string;
  }

  export function AcpBottomBarModeSelector(
    props: AcpBottomBarModeSelectorProps
  ): ReactElement | null;
}

declare module '@/components/shared' {
  export { OptionSelector } from '@/components/shared/option-selector';
  export type { OptionSelectorOption } from '@/components/shared/option-selector';
  export type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
  export {
    AcpBottomBarModeSelector,
    AcpFooterSelectorGroup,
  } from '@/components/shared/acp-inline-selector-group';
}

declare module '@/components/session-list' {
  import type { ReactElement, ReactNode } from 'react';

  export type SessionListRowOwner = {
    name?: string | null;
    image?: string | null;
  };

  export type SessionListRow = {
    sessionId: string;
    title: string;
    /** Machine the session runs on; the sidebar resolves it to `machineName`. */
    machineId?: string;
    /** Resolved machine display name, surfaced in the desktop hover info card. */
    machineName?: string | null;
    repoFullName?: string | null;
    branchName: string;
    prUrl?: string | null;
    prNumber?: number | null;
    prStatus?: string | null;
    /** Compact CI verdict from the PR poller: s/f/p/e/x. */
    prCiState?: 's' | 'f' | 'p' | 'e' | 'x' | null;
    /** Proven merge readiness: 'y' renders the green Mergeable pill. */
    prReadiness?: 'y' | 'n' | null;
    latestMessageAt: Date | number | string;
    addedLines: number;
    deletedLines: number;
    isWorking: boolean;
    hasUnreadMessages: boolean;
    isOffline: boolean;
    isWaitingPermission: boolean;
    isPinned?: boolean;
    isWorktree?: boolean;
    externalHistoryProvider?: unknown;
    owner?: SessionListRowOwner | null;
  };

  export type SessionListRepoState = {
    repoFullName: string;
    collapsed: boolean;
  };

  export type SessionListRepoMove = {
    activeRepoFullName: string;
    overRepoFullName: string;
    fromIndex: number;
    toIndex: number;
    nextRepos: SessionListRepoState[];
  };

  export type SessionListPullRequestOpen = {
    sessionId: string;
    repoFullName: string | null;
    prUrl: string;
    prNumber: number | null;
  };

  export type SessionListProps = {
    sessions: SessionListRow[];
    repos: SessionListRepoState[];
    isLoading?: boolean;
    chatsCollapsed?: boolean;
    selectedSessionId?: string | null;
    activeGroupKey?: string | null;
    className?: string;
    onSelect?: (sessionId: string) => void;
    onSelectSession?: (sessionId: string) => void;
    onToggleRepoCollapsed?: (repoFullName: string) => void;
    onToggleChatsCollapsed?: () => void;
    onArchiveSession?: (sessionId: string) => void;
    onRenameSession?: (sessionId: string, nextTitle: string) => void | Promise<void>;
    onTogglePinSession?: (sessionId: string, nextPinned: boolean) => void;
    onCopySessionUrl?: (sessionId: string) => void;
    onShareSessionWithTeam?: (sessionId: string) => void;
    onNew?: (repoFullName?: string) => void;
    onMoveRepo?: (move: SessionListRepoMove) => void;
    onOpenPullRequest?: (request: SessionListPullRequestOpen) => void;
    onNavigateToNewSession?: (repoFullName?: string) => void;
    getSessionHref?: (sessionId: string) => string | undefined;
    headerAction?: ReactNode;
  };

  export function SessionList(props: SessionListProps): ReactElement | null;
}

declare module '@/components/loro-sidebar' {
  import type { ReactElement, ReactNode } from 'react';
  import type { SessionListProps, SessionListPullRequestOpen } from '@/components/session-list';

  export type LoroSidebarNavKey = 'home' | 'archive';
  export type LoroSidebarChatScope = 'my' | 'team';
  export type LoroSidebarOrganizeMode = 'workspace' | 'updated';

  export type LoroSidebarWorkspace = {
    id: string;
    name: string;
    /** BetterAuth stores the workspace avatar in `organization.logo`. */
    logo?: string | null;
  };

  export type LoroSidebarRepoItemDelta = {
    add: number;
    del: number;
  };

  export type LoroSidebarRepoItem = {
    id: string;
    title: string;
    ageLabel?: string;
    lineChange?: LoroSidebarRepoItemDelta;
    isSelected?: boolean;
  };

  export type LoroSidebarRepoSection = {
    id: string;
    repoFullName: string;
    items: LoroSidebarRepoItem[];
  };

  export type LoroSidebarChatItem = {
    id: string;
    title: string;
    ageLabel?: string;
    isUnread?: boolean;
  };

  export interface LoroSidebarProps {
    className?: string;
    workspaceName: string;
    userEmail: string;
    workspaces: LoroSidebarWorkspace[];
    currentWorkspaceId: string;
    connectionUiState?: 'online' | 'loading' | 'offline' | 'reconnecting';
    isElectronMacOS?: boolean;
    defaultWidth?: number;
    minWidth?: number;
    maxWidth?: number;
    activeNav?: LoroSidebarNavKey | null;
    topContent?: ReactNode;
    bottomFloatingContent?: ReactNode;
    repoSections?: LoroSidebarRepoSection[];
    chats?: LoroSidebarChatItem[];
    sessionListProps?: SessionListProps;
    organizeMode?: LoroSidebarOrganizeMode;
    chatScope?: LoroSidebarChatScope;
    labels?: Record<string, unknown>;
    onWorkspaceSelected?: (workspaceId: string) => void;
    onCreateWorkspaceClicked?: () => void;
    onInviteClicked?: () => void;
    onLinkRepoClicked?: () => void;
    onHomeClicked?: () => void;
    onArchiveClicked?: () => void;
    onSettingsClicked?: () => void;
    onDocsClicked?: () => void;
    onFeedbackClicked?: () => void;
    onChatScopeChanged?: (scope: LoroSidebarChatScope) => void;
    onWidthChange?: (width: number) => void;
    onOpenUpdatedItemPullRequest?: (request: SessionListPullRequestOpen) => void;
    getUpdatedItemHref?: (id: string) => string | undefined;
    collapsed?: boolean;
    onRequestCollapse?: () => void;
  }

  export function LoroSidebar(props: LoroSidebarProps): ReactElement | null;
}

declare module '@/components/sessions/session-tab-bar' {
  import type { ReactElement, ReactNode } from 'react';
  import type { SessionId, SessionMeta } from '@lody/shared';

  export interface ViewerTabItem {
    id: string;
    type: 'file' | 'diff';
    label: string;
    filePath?: string;
  }

  export interface SessionTabBarProps {
    variant?: 'mixed' | 'session' | 'viewer';
    parentSession: SessionMeta;
    childSessions: SessionMeta[];
    draftTabs: unknown[];
    archivedChildSessions: SessionMeta[];
    activeTabSessionId: string;
    onTabSelect: (tabId: string) => void | Promise<void>;
    onNewTab: () => void | Promise<void>;
    onTabRename?: (sessionId: SessionId, title: string) => void | Promise<void>;
    onTabClose?: (tabId: string) => void | Promise<void>;
    onTabRestore?: (sessionId: SessionId) => void | Promise<void>;
    onTabReorder?: (orderedTabIds: string[]) => void;
    tabOrder?: string[];
    viewerTabs?: ViewerTabItem[];
    activeViewerTabId?: string | null;
    onViewerTabSelect?: (tabId: string) => void | Promise<void>;
    onViewerTabClose?: (tabId: string) => void | Promise<void>;
    rightSlot?: ReactNode;
    leftSlot?: ReactNode;
    className?: string;
  }

  export function SessionTabBar(props: SessionTabBarProps): ReactElement | null;
}

declare module '@/components/sessions/floating-permission-request' {
  import type { ReactElement } from 'react';
  import type { SessionDoc, SessionId, SessionStatus } from '@lody/shared';

  export interface FloatingPermissionRequestProps {
    sessionId: SessionId;
    sessionStatus: SessionStatus | undefined;
    sessionHistory: SessionDoc['history'] | undefined;
  }

  export function FloatingPermissionRequest(
    props: FloatingPermissionRequestProps
  ): ReactElement | null;

  export function hasPendingAskUserQuestion(
    sessionStatus: SessionStatus | undefined,
    sessionHistory: SessionDoc['history'] | undefined
  ): boolean;
}

declare module '@/ui/tooltip' {
  import type { ReactElement, ReactNode } from 'react';

  export interface TooltipProviderProps {
    children?: ReactNode;
    delayDuration?: number;
    skipDelayDuration?: number;
    disableHoverableContent?: boolean;
  }

  export function TooltipProvider(props: TooltipProviderProps): ReactElement | null;
}

declare module '@/ui/button' {
  import type { ButtonHTMLAttributes, ForwardRefExoticComponent, RefAttributes } from 'react';

  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    asChild?: boolean;
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
    size?: 'default' | 'sm' | 'lg' | 'icon';
  }

  export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>>;
  export function buttonVariants(options?: {
    variant?: ButtonProps['variant'];
    size?: ButtonProps['size'];
    className?: string;
  }): string;
}

declare module '@/ui/badge' {
  import type { HTMLAttributes, ReactElement } from 'react';

  export interface BadgeProps extends HTMLAttributes<HTMLDivElement> {
    variant?: 'default' | 'secondary' | 'destructive' | 'outline';
  }

  export function Badge(props: BadgeProps): ReactElement;
}

declare module '@/ui/textarea' {
  import type { ForwardRefExoticComponent, RefAttributes, TextareaHTMLAttributes } from 'react';

  export const Textarea: ForwardRefExoticComponent<
    TextareaHTMLAttributes<HTMLTextAreaElement> & RefAttributes<HTMLTextAreaElement>
  >;
}

declare module '@/atoms' {
  import type { PrimitiveAtom } from 'jotai';
  import type { WorkspaceId } from '@lody/shared';

  export const currentWorkspaceIdAtom: PrimitiveAtom<WorkspaceId | null>;
}

declare module '@/atoms/runtime' {
  import type { PrimitiveAtom } from 'jotai';

  export type WorkspaceRuntime = unknown;
  export const authTokenAtom: PrimitiveAtom<string | null>;
  export const runtimeAtom: PrimitiveAtom<WorkspaceRuntime | null>;
}

declare module '@/components/ai-gui/view' {
  import type { ReactElement, ReactNode } from 'react';
  import type { SessionHistoryParsed, SessionId } from '@lody/shared';

  export interface SessionMessageItem {
    type: 'message';
    sessionId: SessionId;
    message: SessionHistoryParsed;
  }
  export interface EmptySessionItem {
    type: 'empty';
  }
  export type ChatStreamItem = SessionMessageItem | EmptySessionItem;

  export type SessionChatUser =
    | { name?: string | null; image?: string | null; email?: string | null }
    | null
    | undefined;

  export interface SessionChatStreamViewProps {
    items: ChatStreamItem[];
    sessionId: SessionId;
    className?: string;
    emptyState?: ReactNode;
    renderMessageRow: (args: { message: SessionHistoryParsed; sessionId: SessionId }) => ReactNode;
    agentActivityLabel?: string | null;
    showScrollToLatest?: boolean;
  }

  export interface MessageRowViewProps {
    message: SessionHistoryParsed;
    sessionId: SessionId;
    user?: SessionChatUser;
    isLastAssistantMessage?: boolean;
  }

  export function SessionChatStreamView(props: SessionChatStreamViewProps): ReactElement | null;
  export function MessageRowView(props: MessageRowViewProps): ReactElement | null;
}

declare module '@/components/sessions/session-diff-summary' {
  export type SessionDiffChangeEntry = {
    filePath: string;
    add?: number;
    del?: number;
  };
}

declare module '@/components/sessions/session-changes-sidebar' {
  import type { ReactElement } from 'react';
  import type { SessionDiffChangeEntry } from '@/components/sessions/session-diff-summary';

  export type ChangesViewMode = 'files' | 'types';

  export type SessionChangesSidebarProps = {
    ready: boolean;
    synced: boolean;
    unavailableMessage?: string;
    changeEntries: SessionDiffChangeEntry[];
    changeFilePaths: string[];
    initialViewMode?: ChangesViewMode;
    onOpenChangesDiff: (focusFilePath: string, filePaths: string[]) => void;
  };

  export function SessionChangesSidebar(props: SessionChangesSidebarProps): ReactElement;
}

declare module '@/ui/diff-viewer/diff-viewer' {
  import type { ReactElement } from 'react';

  export interface DiffViewerProps {
    path: string;
    oldText: string;
    newText: string;
    diffStyle?: 'unified' | 'split';
    responsiveSplit?: boolean;
    className?: string;
    showHeader?: boolean;
    stickyHeader?: boolean;
    defaultOpen?: boolean;
    options?: { theme?: unknown; themeType?: 'light' | 'dark'; [key: string]: unknown };
  }

  export const DiffViewer: (props: DiffViewerProps) => ReactElement | null;
}

declare module '@/components/sessions/desktop-session-detail-layout' {
  import type { ReactElement, ReactNode } from 'react';

  export type DesktopSessionDetailLayoutProps = {
    defaultSizes: { main: number; sidebar: number };
    /** Single merged top row: session tabs + right-side window controls. */
    topBar: ReactNode;
    chatSurfaces: ReactNode;
    terminalDock: ReactNode;
    secondaryPanel: ReactNode;
    sidebarOpen: boolean;
    onSidebarCollapse: () => void;
    deleteConfirmDialog: ReactNode;
  };

  export function DesktopSessionDetailLayout(props: DesktopSessionDetailLayoutProps): ReactElement;
}

declare module '@/components/mobile/mobile-session-run-config' {
  import type { ReactElement } from 'react';
  import type { SessionMeta } from '@lody/shared';
  import type {
    AcpConfigOptionSelector,
    AcpConfigOptionValue,
  } from '@/components/shared/acp-selector-options';
  import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

  export function MobileSessionRunConfig(props: {
    agentSelection: { agentId: string; machineId: string } | null;
    allowedMachineIds?: string[];
    agentLocked?: boolean;
    onAgentConfigChange?: (selection: { agentId: string; machineId: string }) => void;
    modelOptions: ReadonlyArray<AcpSessionSelectOption>;
    selectedModelId: string | null;
    onModelChange: (value: string) => void;
    modeOptions: ReadonlyArray<AcpSessionSelectOption>;
    selectedModeId: string | null;
    onModeChange: (value: string) => void;
    configOptionSelectors?: AcpConfigOptionSelector[];
    configOptionValues?: Record<string, AcpConfigOptionValue>;
    onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
    fallbackAgent?: {
      cliType?: string | null;
      agentType?: string | null;
    };
  }): ReactElement;
}

declare module '@/components/sessions/session-browser-toolbar' {
  import type { ReactElement, ReactNode } from 'react';

  export function SessionBrowserToolbar(props: {
    leadingSlot?: ReactNode;
    focusAddress?: boolean;
    address: string;
    canGoBack: boolean;
    canGoForward: boolean;
    loading: boolean;
    annotationEnabled: boolean;
    annotationAvailable: boolean;
    sharing: boolean;
    shareAvailable: boolean;
    hasShareUrl: boolean;
    busy: boolean;
    onAddressChange: (address: string) => void;
    onRestoreAddress: () => void;
    onNavigate: () => void;
    onBack: () => void;
    onForward: () => void;
    onReload: () => void;
    onStop: () => void;
    onToggleAnnotation: () => void;
    onShare: () => void;
    onStopSharing: () => void;
  }): ReactElement;
}

declare module '@/components/shared/conversation-column' {
  import type { HTMLAttributes, ReactElement } from 'react';

  export function ConversationColumn(props: HTMLAttributes<HTMLDivElement>): ReactElement;
}

declare module '@/components/sessions/session-side-panel-tab-bar' {
  import type { ReactElement, ReactNode } from 'react';

  export type SessionSidePanelTabItem = {
    id: string;
    label: string;
    kind: 'files' | 'changes' | 'pr' | 'browser' | 'file' | 'diff';
    filePath?: string;
    closeable?: boolean;
    dirty?: boolean;
    saving?: boolean;
    conflict?: boolean;
  };

  export type SessionSidePanelOption = {
    id: 'files' | 'changes' | 'pr' | 'browser';
    kind: 'files' | 'changes' | 'pr' | 'browser';
    label: string;
    closeable?: boolean;
    dirty?: boolean;
    saving?: boolean;
    conflict?: boolean;
  };

  export function SessionSidePanelTabBar(props: {
    tabs: SessionSidePanelTabItem[];
    activeTabId: string | null;
    availablePanels: SessionSidePanelOption[];
    onTabSelect: (tabId: string) => void;
    onTabClose: (tabId: string) => void;
    onPanelOpen: (panelId: SessionSidePanelOption['id']) => void;
    addPanelLabel: string;
    closeTabLabel: (tabLabel: string) => string;
    endSlot?: ReactNode;
    className?: string;
  }): ReactElement;
}

declare module '@/components/sessions/session-info-chips' {
  export type WorkspaceLocationKind = 'worktree' | 'folder';

  export type ContextChipAction = {
    id: string;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Merge split-button variant; the landing preview only uses plain actions. */
    kind?: 'merge';
  };

  export type PrCiRun = {
    id: string;
    name: string;
    status: 'success' | 'failure' | 'pending' | 'neutral';
    url?: string;
  };
}

declare module '@/components/sessions/session-info-bar' {
  import type { ReactElement } from 'react';
  import type { SessionPullRequestMeta } from '@lody/shared';
  import type {
    ContextChipAction,
    PrCiRun,
    WorkspaceLocationKind,
  } from '@/components/sessions/session-info-chips';

  export type InfoBarItemKey = 'status' | 'goal' | 'schedule' | 'context';

  export function SessionInfoBar(props: {
    status?: unknown;
    goal?: unknown;
    scheduledTasks?: readonly unknown[];
    prCiRuns?: readonly PrCiRun[];
    onOpenPrCiRun?: (run: PrCiRun) => void;
    projectName?: string | null;
    branch?: string | null;
    workspaceLocation?: { kind: WorkspaceLocationKind; path?: string | null } | null;
    pr?: SessionPullRequestMeta | null;
    onOpenPr?: () => void;
    contextActions?: readonly ContextChipAction[];
    onOpenAllChanges?: () => void;
    onOpenBrowser?: () => void;
    diffStat?: { add: number; del: number } | null;
    syncing?: boolean;
    /** Mobile: lift the bar above the session drawer's edge-back strip. */
    protectFromEdgeBackZone?: boolean;
    initialStage?: InfoBarItemKey;
  }): ReactElement | null;
}

declare module '@/components/sessions/desktop-run-config-menu' {
  import type { ReactElement } from 'react';
  import type { MachineId } from '@lody/shared';
  import type {
    AcpConfigOptionSelector,
    AcpConfigOptionValue,
  } from '@/components/shared/acp-selector-options';
  import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';

  export type AgentSelection = { agentId: string; machineId: MachineId };

  export function DesktopRunConfigMenu(props: {
    agentSelection: AgentSelection | null;
    allowedMachineIds?: MachineId[];
    agentLocked?: boolean;
    fallbackAgent?: { cliType?: string | null; agentType?: string | null };
    onAgentConfigChange?: (selection: AgentSelection) => void;
    modelOptions: ReadonlyArray<AcpSessionSelectOption>;
    selectedModelId: string | null;
    onModelChange?: (value: string) => void;
    configOptionSelectors?: AcpConfigOptionSelector[];
    configOptionValues?: Record<string, AcpConfigOptionValue>;
    onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  }): ReactElement;

  export function DesktopPermissionModeButton(props: {
    modeOptions: ReadonlyArray<AcpSessionSelectOption>;
    selectedModeId: string | null;
    onModeChange?: (value: string) => void;
    configOptionSelectors?: AcpConfigOptionSelector[];
    configOptionValues?: Record<string, AcpConfigOptionValue>;
    onConfigOptionChange?: (configId: string, value: AcpConfigOptionValue) => void;
  }): ReactElement | null;

  export function DesktopMachineMenu(props: {
    value: MachineId | null;
    selectedLabel?: string | null;
    options: ReadonlyArray<{ value: MachineId; label: string; disabled?: boolean }>;
    onChange: (value: MachineId) => void;
    disabled?: boolean;
    disabledReason?: string;
    onAddMachine?: () => void;
  }): ReactElement;
}

declare module '@/atoms/doc-meta' {
  import type { Atom, WritableAtom } from 'jotai';
  import type { AgentConfigMeta } from '@lody/shared';

  export const agentConfigMetaCacheAtom: WritableAtom<
    Record<string, AgentConfigMeta>,
    [Record<string, AgentConfigMeta>],
    void
  >;
  export const docMetaCacheReadyAtom: WritableAtom<boolean, [boolean], void>;
  export const sessionMetaAtomFamily: unknown;
  export type { Atom };
}

declare module '@/ui/tabs' {
  import type { ComponentPropsWithoutRef, ReactElement } from 'react';

  export function Tabs(
    props: {
      value?: string;
      defaultValue?: string;
      onValueChange?: (value: string) => void;
    } & ComponentPropsWithoutRef<'div'>
  ): ReactElement;
  export function TabsList(props: ComponentPropsWithoutRef<'div'>): ReactElement;
  export function TabsTrigger(
    props: { value: string } & ComponentPropsWithoutRef<'button'>
  ): ReactElement;
  export function TabsContent(
    props: { value: string } & ComponentPropsWithoutRef<'div'>
  ): ReactElement;
}

declare module '@/hooks/use-mobile' {
  import type { ReactElement, ReactNode } from 'react';

  export function ForceMobileLayoutProvider(props: {
    force: boolean;
    children: ReactNode;
  }): ReactElement;

  export function ForceDesktopLayoutProvider(props: { children: ReactNode }): ReactElement;

  export function checkIsMobileDevice(): boolean;
  export function useIsMobile(): boolean;
}

declare module '@/components/settings/settings-data-cache' {
  export type SettingsUsageRange = 'day' | 'week' | 'month' | 'total';

  export type SettingsUsageTimelineBucket = {
    bucketStartMs: number;
    bucketLabel: string;
    tokens: number;
    costUSD: number;
    byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
    byUser: Array<{ userId: string; tokens: number; costUSD: number }>;
  };

  export type SettingsUsageTimelineData = {
    workspaceId: string;
    range: SettingsUsageRange;
    startMs: number;
    endMs: number;
    bucketSizeMs: number;
    totals: {
      tokens: number;
      costUSD: number;
      breakdown?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        reasoningOutputTokens: number;
      };
    };
    users?: Record<string, { name?: string; email?: string; image?: string | null }>;
    buckets: SettingsUsageTimelineBucket[];
  };

  export type SettingsUsageCalendarData = {
    workspaceId: string;
    timezone: 'UTC';
    startMs: number;
    endMs: number;
    days: Array<{
      dayStartMs: number;
      date: string;
      tokens: number;
      costUSD: number;
      isFuture: boolean;
    }>;
  };

  export type SettingsUsageDayData = {
    workspaceId: string;
    dayStartMs: number;
    date: string;
    totals: {
      tokens: number;
      costUSD: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningOutputTokens: number;
      webSearchRequests: number;
    };
    byModel: Array<{ modelId: string; tokens: number; costUSD: number }>;
    byUser: Array<{ userId: string; tokens: number; costUSD: number }>;
    users: Record<string, { name?: string; email?: string; image?: string | null }>;
  };
}

declare module '@/components/settings/usage-stacked-area-chart' {
  import type { ReactNode } from 'react';

  export type StackedAreaSeriesValue = {
    id: string;
    label: string;
    value: number;
  };

  export type StackedAreaBucket = {
    label: string;
    values: StackedAreaSeriesValue[];
  };

  export type StackedAreaSeriesDef = {
    id: string;
    label: string;
    color: string;
    total: number;
  };

  export type StackedAreaSeriesMarkerRender = (series: StackedAreaSeriesDef) => ReactNode;
}

declare module '@/components/settings/stats-setting-pure' {
  import type { ReactElement } from 'react';
  import type {
    SettingsUsageCalendarData,
    SettingsUsageDayData,
    SettingsUsageRange,
    SettingsUsageTimelineData,
  } from '@/components/settings/settings-data-cache';
  import type {
    StackedAreaBucket,
    StackedAreaSeriesMarkerRender,
  } from '@/components/settings/usage-stacked-area-chart';

  export type StatsSettingsViewProps = {
    workspaceName?: string;
    range: SettingsUsageRange;
    onRangeChange: (range: SettingsUsageRange) => void;
    ready: boolean;
    totals: { tokens: number; costUSD: number } | null;
    byModelBuckets: StackedAreaBucket[];
    byMemberBuckets: StackedAreaBucket[];
    usageCalendar?: SettingsUsageCalendarData;
    usageTimeline?: SettingsUsageTimelineData;
    usageDay?: SettingsUsageDayData;
    usageDayLoading?: boolean;
    onSelectedUsageDayChange?: (dayStartMs: number | null) => void;
    workspaceId: string | null;
    loading: boolean;
    renderModelSeriesMarker?: StackedAreaSeriesMarkerRender;
    renderMemberSeriesMarker?: StackedAreaSeriesMarkerRender;
    tintModelSeriesLabel?: boolean;
    tintMemberSeriesLabel?: boolean;
    /** USD fraction digits for the cost KPI (default 2). Landing uses 0. */
    costFractionDigits?: number;
  };

  export function StatsSettingsView(props: StatsSettingsViewProps): ReactElement;
  export function formatTokens(value: number): string;
  export function formatTokensCompact(value: number): string;
  export function formatUSD(value: number): string;
}

declare module '@/components/sessions/pr-tab-view' {
  import type { ReactElement, ReactNode } from 'react';
  import type {
    GitHubCheckRunsSummary,
    GitHubIssueComment,
    GitHubMergeMethod,
    GitHubPullRequestDetails,
    GitHubReview,
    GitHubReviewThread,
  } from '@lody/shared';

  export type PrTabViewState = 'loading' | 'ready' | 'error';

  export interface PrTabViewData {
    pullRequest: GitHubPullRequestDetails;
    reviewThreads: GitHubReviewThread[];
    reviews: GitHubReview[];
    issueComments: GitHubIssueComment[];
    checkRuns: GitHubCheckRunsSummary;
  }

  export interface PrTabViewProps {
    repoFullName: string;
    prNumber: number;
    state: PrTabViewState;
    data?: PrTabViewData | null;
    error?: string | null;
    isRefreshing?: boolean;
    isPostingComment?: boolean;
    checksPermissionError?: boolean;
    leadingSlot?: ReactNode;
    mergeMethod?: GitHubMergeMethod;
    isMerging?: boolean;
    isUpdatingState?: boolean;
    isMarkingReady?: boolean;
    isDeletingBranch?: boolean;
    branchExists?: boolean | null;
    onRefresh?: () => void;
    onPostComment?: (body: string) => Promise<void> | void;
    onGrantChecksPermission?: () => void;
    onSelectMergeMethod?: (method: GitHubMergeMethod) => void;
    onMerge?: (method: GitHubMergeMethod) => void | Promise<void>;
    onSetState?: (state: 'open' | 'closed') => void | Promise<void>;
    onMarkReadyForReview?: () => void | Promise<void>;
    onDeleteBranch?: () => void | Promise<void>;
    onResolveConflicts?: () => void;
    isResolvingConflicts?: boolean;
    /** Landing frames: slim badge+merge bar (no branch row); fills host height. */
    embedded?: boolean;
    className?: string;
  }

  export function PrTabView(props: PrTabViewProps): ReactElement;
}
