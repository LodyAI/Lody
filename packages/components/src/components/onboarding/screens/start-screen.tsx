import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence, motion } from 'framer-motion';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  FolderGit2,
  FolderOpen,
  Plus,
  Sparkles,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { v4 as uuidv4 } from 'uuid';
import {
  MANAGED_BUILTIN_RUNTIMES,
  buildInitialHistoryEntry,
  getServerNow,
  type AgentConfigId,
  type AgentConfigMeta,
  type LocalProjectId,
  type ManagedBuiltinAgentType,
  type ProjectRef,
  type SessionId,
} from '@lody/shared';
import { PlatformContext, usePlatform } from '@lody/platform/react';
import type { PlatformProvider } from '@lody/platform';
import type { DiscoveredLocalRepo, LocalRepoPromptHints } from '@lody/shared/electron-ipc';
import { userAtom } from '@/atoms';
import {
  cmdCreateAgentConfigAtom,
  cmdCreateProviderSetupAtom,
  getAllAgentConfigAtom,
  getAllProviderSetupsAtom,
} from '@/atoms/agents';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getMachineMetaByIdAtomFamily } from '@/atoms/machines';
import type {
  DesktopOnboardingModelChip,
  DesktopOnboardingProjectSelection,
} from '@/atoms/onboarding';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { ChatComposer } from '@/components/chat/chat-composer';
import { AgentIcon } from '@/components/icons/agent-icon';
import {
  AuthenticatedConvexContext,
  useOptionalAuthenticatedConvex,
  type AuthenticatedConvexContextValue,
} from '@/hooks/use-authenticated-convex';
import { useMachineFlockAgentConfigsForMachineIds } from '@/hooks/use-machine-flock-agent-configs';
import { useSessionActions } from '@/hooks/use-session-actions';
import { buildAgentPrompt } from '@/lib';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { isImeComposingKeyboardEvent } from '@/lib/ime';
import { prepareAndWriteLocalProject, selectAndWriteLocalProject } from '@/lib/local-project-import';
import { toast } from '@/lib/toast';
import type { ComposerInputElement } from '@/ui/mention/composer-input';
import { WINDOW_DRAG_EXEMPT_CLASS } from '@/ui/window-drag-region';
import { playSelect } from '../ceremony/ui-sounds';
import {
  DUR_IN_S,
  DUR_OUT_S,
  EASE_IN,
  EASE_OUT,
  SPRING_CHIP,
  staggerDelay,
  useOnboardingReducedMotion,
} from '../motion-tokens';
import { useOnboardingAnalytics } from '../onboarding-analytics';
import { StatusRingOrCheck } from '../shared/browser-auth-button';
import { ConnectModelSheet } from '../shared/connect-model-sheet';
import { flatSurface } from '../shared/flat-surface.stylex';
import { ProviderBrandIcon } from '../shared/provider-brand-icon';
import {
  useSorbetOnboardingController,
  type ConnectedModelPayload,
} from '../shared/sorbet-onboarding-controller';

const styles = stylex.create({
  stage: {
    width: '100%',
    height: '100%',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    paddingInline: 'clamp(1.5rem, 5vw, 4rem)',
    paddingTop: 'clamp(4.5rem, 8vh, 6rem)',
    paddingBottom: 'clamp(2.5rem, 6vh, 4rem)',
    position: 'relative',
  },
  centerColumn: {
    width: '100%',
    maxWidth: '41rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '1.375rem',
  },
  title: {
    margin: 0,
    fontSize: 'clamp(1.75rem, 2.8vw, 2.25rem)',
    fontWeight: 620,
    letterSpacing: '-0.03em',
    lineHeight: 1.16,
    color: 'var(--flat-ink)',
  },
  composerWrap: {
    width: '100%',
    position: 'relative',
  },
  footerChips: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.4375rem',
    minWidth: 0,
    flexWrap: 'nowrap',
  },
  chipAnchor: {
    position: 'relative',
    display: 'inline-flex',
    minWidth: 0,
  },
  /** Empty optional Project chip: feather-light dashed slot (`[┆无项目 ▾┆]`). */
  projectChipEmpty: {
    appearance: 'none',
    backgroundColor: 'transparent',
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: 'rgba(20, 20, 19, 0.22)',
    borderRadius: '999px',
    color: 'var(--flat-ink-secondary)',
    fontSize: '0.78125rem',
    fontWeight: 500,
    lineHeight: 1,
    height: '1.75rem',
    paddingInline: '0.6875rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3125rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, color, border-color, transform',
    transitionDuration: '140ms, 140ms, 140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill)',
      color: 'var(--flat-ink)',
      borderColor: 'rgba(20, 20, 19, 0.36)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  /** Selected Project or Agent/Model chip: flat borderless tonal pill. */
  solidChip: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink)',
    fontSize: '0.78125rem',
    fontWeight: 500,
    lineHeight: 1,
    height: '1.75rem',
    paddingInline: '0.6875rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    maxWidth: '15rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transitionProperty: 'background-color, transform',
    transitionDuration: '140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  /** Unconnected model state: amber highlight (`连接模型`). */
  amberChip: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    backgroundColor: 'var(--flat-amber-bg)',
    color: 'var(--flat-amber-fg)',
    fontSize: '0.78125rem',
    fontWeight: 560,
    lineHeight: 1,
    height: '1.75rem',
    paddingInline: '0.75rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.375rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transitionProperty: 'opacity, transform',
    transitionDuration: '140ms, 80ms',
    ':hover': {
      opacity: 0.86,
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-amber-fg)',
      outlineOffset: '2px',
    },
  },
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  sendWrap: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  sendHint: {
    fontSize: '0.75rem',
    color: 'var(--flat-amber-fg)',
    whiteSpace: 'nowrap',
  },
  sendBtn: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    width: '2rem',
    height: '2rem',
    backgroundColor: 'var(--flat-primary-bg)',
    color: 'var(--flat-primary-fg)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transitionProperty: 'opacity, transform, background-color',
    transitionDuration: '140ms, 80ms, 140ms',
    ':hover': {
      backgroundColor: 'var(--flat-primary-hover)',
    },
    ':active': {
      transform: 'scale(0.96)',
    },
    ':disabled': {
      opacity: 0.28,
      cursor: 'default',
      transform: 'none',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  pillsRow: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.5rem',
    minHeight: '2.125rem',
  },
  suggestionPill: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink-secondary)',
    fontSize: '0.8125rem',
    fontWeight: 480,
    paddingBlock: '0.4375rem',
    paddingInline: '0.875rem',
    cursor: 'pointer',
    transitionProperty: 'background-color, color, transform',
    transitionDuration: '140ms, 140ms, 80ms',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
      color: 'var(--flat-ink)',
    },
    ':active': {
      transform: 'scale(0.98)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '2px',
    },
  },
  exploreRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    paddingTop: '0.25rem',
  },
  popover: {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    insetInlineStart: 0,
    zIndex: 55,
    width: '21rem',
    maxHeight: '21rem',
    overflowY: 'auto',
    borderRadius: '14px',
    backgroundColor: 'var(--flat-elevated-bg)',
    boxShadow: 'var(--flat-elevated-shadow)',
    padding: '0.375rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.125rem',
  },
  popoverSectionTitle: {
    fontSize: '0.6875rem',
    fontWeight: 560,
    letterSpacing: '0.02em',
    color: 'var(--flat-ink-tertiary)',
    paddingInline: '0.625rem',
    paddingTop: '0.4375rem',
    paddingBottom: '0.25rem',
  },
  popoverItem: {
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '9px',
    backgroundColor: 'transparent',
    color: 'var(--flat-ink)',
    width: '100%',
    paddingBlock: '0.5rem',
    paddingInline: '0.625rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.625rem',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    textAlign: 'start',
    ':hover': {
      backgroundColor: 'var(--flat-fill)',
    },
    ':focus-visible': {
      outline: '2px solid var(--flat-ink)',
      outlineOffset: '-2px',
    },
  },
  popoverItemSub: {
    fontSize: '0.71875rem',
    color: 'var(--flat-ink-tertiary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  popoverDivider: {
    height: '4px',
  },
  skeletonRow: {
    height: '2.25rem',
    borderRadius: '9px',
    backgroundColor: 'var(--flat-fill)',
    marginBlock: '0.125rem',
  },
  kbdHint: {
    fontSize: '0.71875rem',
    color: 'var(--flat-ink-tertiary)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  sheetBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 80,
    backgroundColor: 'rgba(20, 20, 19, 0.28)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1.5rem',
  },
  sheetDialog: {
    width: '100%',
    maxWidth: '33rem',
    maxHeight: '86vh',
    overflowY: 'auto',
    borderRadius: '18px',
    backgroundColor: '#FAF9F6',
    boxShadow: '0 28px 64px -20px rgba(20, 20, 19, 0.24)',
    padding: '1.5rem',
    position: 'relative',
  },
  sheetCloseBtn: {
    position: 'absolute',
    top: '1rem',
    insetInlineEnd: '1rem',
    appearance: 'none',
    borderWidth: 0,
    borderRadius: '999px',
    width: '1.875rem',
    height: '1.875rem',
    backgroundColor: 'var(--flat-fill)',
    color: 'var(--flat-ink-secondary)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    ':hover': {
      backgroundColor: 'var(--flat-fill-hover)',
      color: 'var(--flat-ink)',
    },
  },
});

function formatCompactPath(fullPath: string): string {
  return fullPath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

function formatRelativeRecency(mtimeMs: number): string {
  if (!mtimeMs) return '';
  const diffMin = Math.max(1, Math.round((Date.now() - mtimeMs) / 60_000));
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  return `${Math.round(diffDay / 30)}mo`;
}

const THIRD_PARTY_AGENTS: ReadonlyArray<{
  agentType: ManagedBuiltinAgentType;
  label: string;
}> = MANAGED_BUILTIN_RUNTIMES.filter((item) => item.agentType !== 'pi').map((item) => ({
  agentType: item.agentType,
  label: item.displayName,
}));

export function buildStaticSuggestionPills(
  hasProject: boolean,
  hints: LocalRepoPromptHints | null,
  t: (key: string, options?: Record<string, unknown>) => string
): string[] {
  if (!hasProject) {
    return [
      t('onboarding.start.pill.script', { defaultValue: 'Write a quick script…' }),
      t('onboarding.start.pill.concept', { defaultValue: 'Explain a concept…' }),
      t('onboarding.start.pill.doc', { defaultValue: 'Draft a document…' }),
    ];
  }

  const pills: string[] = [
    t('onboarding.start.pill.repoStructure', {
      defaultValue: 'Walk through how this repository is structured',
    }),
  ];
  if (hints?.hasTests) {
    pills.push(
      t('onboarding.start.pill.runTests', {
        defaultValue: 'Run the test suite and fix any failures',
      })
    );
  }
  if (hints?.isDirty) {
    pills.push(
      t('onboarding.start.pill.reviewDirty', {
        defaultValue: 'Review my uncommitted changes',
      })
    );
  }
  if (pills.length < 3 && hints?.hasTodos) {
    pills.push(
      t('onboarding.start.pill.pickTodo', {
        defaultValue: 'Pick a TODO and implement it',
      })
    );
  }
  if (pills.length < 3) {
    pills.push(
      t('onboarding.start.pill.entryPoints', {
        defaultValue: 'Find the main entry points and summarize key modules',
      })
    );
  }
  return pills.slice(0, 3);
}

const STANDALONE_UNAUTHENTICATED_CONVEX: AuthenticatedConvexContextValue = {
  authSessionId: null,
  isAuthenticated: false,
  isLoading: false,
  isRecovering: false,
  confirmedUnauthenticated: false,
  claimAutomaticCommand: () => false,
  requestAuthRecovery: () => {},
};

export interface StartScreenProps {
  project: DesktopOnboardingProjectSelection | null;
  modelChip: DesktopOnboardingModelChip | null;
  selectedAgentConfigId: AgentConfigId | null;
  exitingToProduct: boolean;
  onProjectChange: (project: DesktopOnboardingProjectSelection | null) => void;
  onModelConnected: (payload: ConnectedModelPayload) => void;
  onAgentConfigChange: (configId: AgentConfigId | null) => void;
  onBeginExitTransition: () => void;
  onEnterWithSession: (sessionId?: string) => Promise<boolean>;
  onExploreFirst: () => Promise<boolean>;
}

export function StartScreen(props: StartScreenProps) {
  const existingConvex = useOptionalAuthenticatedConvex();
  const outerPlatform = usePlatform();
  const standalonePlatform = useMemo<PlatformProvider>(
    () => ({ ...outerPlatform, cloudApi: null }),
    [outerPlatform]
  );
  if (existingConvex) {
    return <StartScreenBody {...props} />;
  }
  return (
    <PlatformContext.Provider value={standalonePlatform}>
      <AuthenticatedConvexContext.Provider value={STANDALONE_UNAUTHENTICATED_CONVEX}>
        <StartScreenBody {...props} />
      </AuthenticatedConvexContext.Provider>
    </PlatformContext.Provider>
  );
}

function StartScreenBody({
  project,
  modelChip,
  selectedAgentConfigId,
  exitingToProduct,
  onProjectChange,
  onModelConnected,
  onAgentConfigChange,
  onBeginExitTransition,
  onEnterWithSession,
  onExploreFirst,
}: StartScreenProps) {
  const { t } = useTranslation();
  const reducedMotion = useOnboardingReducedMotion();
  const analytics = useOnboardingAnalytics();
  const controller = useSorbetOnboardingController();

  const user = useAtomValue(userAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const allConfigs = useAtomValue(getAllAgentConfigAtom);
  const providerSetups = useAtomValue(getAllProviderSetupsAtom);
  const localMachineMeta = useAtomValue(getMachineMetaByIdAtomFamily(localMachineId ?? undefined));
  const existingLocalProjects = useMemo(
    () => Object.values(localMachineMeta?.localProjects ?? {}),
    [localMachineMeta?.localProjects]
  );
  const createAgentConfig = useSetAtom(cmdCreateAgentConfigAtom);
  const startProviderSetup = useSetAtom(cmdCreateProviderSetupAtom);
  const { startSession, requestSessionDispatch } = useSessionActions();

  const machineIds = useMemo(
    () => (localMachineId ? [localMachineId] : []),
    [localMachineId]
  );
  useMachineFlockAgentConfigsForMachineIds(machineIds);

  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [connectSheetOpen, setConnectSheetOpen] = useState(false);
  const [sendBlockedHint, setSendBlockedHint] = useState(false);

  // Lazy repo scan state — ONLY triggered when `projectMenuOpen` becomes true (§4, §5.4).
  const [discoveredRepos, setDiscoveredRepos] = useState<DiscoveredLocalRepo[] | null>(null);
  const [showRepoSkeleton, setShowRepoSkeleton] = useState(false);
  const [repoHints, setRepoHints] = useState<LocalRepoPromptHints | null>(null);

  const promptInputRef = useRef<ComposerInputElement | null>(null);
  const projectPopoverRef = useRef<HTMLDivElement | null>(null);
  const agentPopoverRef = useRef<HTMLDivElement | null>(null);

  // Resolve the active Agent config (defaulting to Lody Agent / `sorbet` on this machine).
  const localConfigs = useMemo(
    () =>
      localMachineId
        ? allConfigs.filter((cfg) => cfg.machineId === localMachineId)
        : allConfigs,
    [allConfigs, localMachineId]
  );

  const sorbetConfig = useMemo(
    () =>
      localConfigs
        .filter((cfg) => cfg.cliType === 'builtin' && cfg.agentType === 'sorbet')
        .sort((a, b) => a.id.localeCompare(b.id))[0] ?? null,
    [localConfigs]
  );

  const activeThirdPartyConfig = useMemo(
    () =>
      selectedAgentConfigId
        ? localConfigs.find(
            (cfg) => cfg.id === selectedAgentConfigId && cfg.agentType !== 'sorbet'
          ) ?? null
        : null,
    [localConfigs, selectedAgentConfigId]
  );

  const probeReadyModel =
    controller.probe?.model.kind === 'ready' ? controller.probe.model : null;

  const activeModelDisplay =
    modelChip?.modelName ||
    probeReadyModel?.modelName ||
    modelChip?.providerName ||
    probeReadyModel?.providerName ||
    null;

  const hasReadyAgentOrModel = Boolean(
    activeThirdPartyConfig || modelChip || probeReadyModel
  );

  // Outside click / Escape dismissal for popovers.
  useEffect(() => {
    if (!projectMenuOpen && !agentMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (projectMenuOpen && !projectPopoverRef.current?.contains(target)) {
        setProjectMenuOpen(false);
      }
      if (agentMenuOpen && !agentPopoverRef.current?.contains(target)) {
        setAgentMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setProjectMenuOpen(false);
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [agentMenuOpen, projectMenuOpen]);

  // Lazy repo scan when Project popover opens; show 3-row skeleton only if >120ms (§5.4).
  useEffect(() => {
    if (!projectMenuOpen || discoveredRepos !== null) return undefined;
    let settled = false;
    const skeletonTimer = window.setTimeout(() => {
      if (!settled) setShowRepoSkeleton(true);
    }, 120);

    const localProjectsIpc = getIpcServices()?.localProjects;
    void Promise.resolve(localProjectsIpc ? localProjectsIpc.discoverRecentRepos() : [])
      .then((repos) => {
        settled = true;
        setShowRepoSkeleton(false);
        setDiscoveredRepos(repos ?? []);
      })
      .catch(() => {
        settled = true;
        setShowRepoSkeleton(false);
        setDiscoveredRepos([]);
      });

    return () => {
      window.clearTimeout(skeletonTimer);
    };
  }, [discoveredRepos, projectMenuOpen]);

  // Inspect lightweight static repo prompt hints whenever project changes (§5.4).
  useEffect(() => {
    if (!project || project.kind !== 'local' || !project.rootPath) {
      setRepoHints(null);
      return undefined;
    }
    let cancelled = false;
    const localProjectsIpc = getIpcServices()?.localProjects;
    if (!localProjectsIpc) return undefined;
    void localProjectsIpc
      .inspectRepoPromptHints(project.rootPath)
      .then((hints) => {
        if (!cancelled) setRepoHints(hints);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project]);

  const mergedRepoItems = useMemo(() => {
    const byPath = new Map<
      string,
      {
        name: string;
        rootPath: string;
        mtimeMs: number;
        localProjectId?: LocalProjectId;
        machineId?: typeof localMachineId;
      }
    >();
    for (const lp of existingLocalProjects) {
      if (lp.standaloneVisible === false) continue;
      byPath.set(lp.rootPath, {
        name: lp.name,
        rootPath: lp.rootPath,
        mtimeMs: lp.lastOpenedAtMs ?? lp.createdAtMs ?? 0,
        localProjectId: lp.id,
      });
    }
    for (const repo of discoveredRepos ?? []) {
      if (!byPath.has(repo.rootPath)) {
        byPath.set(repo.rootPath, {
          name: repo.name,
          rootPath: repo.rootPath,
          mtimeMs: repo.mtimeMs,
        });
      }
    }
    return [...byPath.values()].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 14);
  }, [discoveredRepos, existingLocalProjects]);

  const handlePickFolderDialog = useCallback(async () => {
    setProjectMenuOpen(false);
    const localProjectsIpc = getIpcServices()?.localProjects;
    if (!localProjectsIpc) return;
    try {
      if (runtime) {
        const imported = await selectAndWriteLocalProject({
          runtime,
          selectDirectory: () => localProjectsIpc.selectDirectory(),
          timeoutMessage: t('onboarding.start.projectTimeout', {
            defaultValue: 'Timed out while opening folder.',
          }),
        });
        if (!imported) return;
        analytics.capture('onboarding/operation_succeeded', {
          step: 'start',
          operation: 'local_project_import',
        });
        onProjectChange({
          kind: 'local',
          machineId: imported.machineId,
          localProjectId: imported.localProjectId,
          rootPath: imported.rootPath,
          name: imported.name,
        });
        return;
      }

      // Even before workspace runtime finishes booting, let native folder dialog pick a path.
      const selected = await localProjectsIpc.selectDirectory();
      if (!selected || 'error' in selected) return;
      const folderName =
        selected.rootPath.split(/[/\\]/).filter(Boolean).pop() || selected.rootPath;
      onProjectChange({
        kind: 'local',
        machineId: selected.machineId as NonNullable<typeof localMachineId>,
        rootPath: selected.rootPath,
        name: folderName,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [analytics, onProjectChange, runtime, t]);

  // Global `⌘O` / `Ctrl+O` shortcut to open folder picker (§5.4, §6.3).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void handlePickFolderDialog();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlePickFolderDialog]);

  const handleSelectRepoItem = useCallback(
    async (item: (typeof mergedRepoItems)[number]) => {
      setProjectMenuOpen(false);
      if (item.localProjectId && localMachineId) {
        onProjectChange({
          kind: 'local',
          machineId: localMachineId,
          localProjectId: item.localProjectId,
          rootPath: item.rootPath,
          name: item.name,
        });
        return;
      }
      if (runtime && localMachineId) {
        try {
          const added = await prepareAndWriteLocalProject({
            runtime,
            machineId: localMachineId,
            rootPath: item.rootPath,
            timeoutMessage: t('onboarding.start.projectTimeout', {
              defaultValue: 'Timed out while preparing project.',
            }),
          });
          onProjectChange({
            kind: 'local',
            machineId: localMachineId,
            localProjectId: added.localProjectId,
            rootPath: added.rootPath,
            name: added.name,
          });
          return;
        } catch {
          // Fall back to path draft; resolved on send if runtime finishes syncing.
        }
      }
      onProjectChange({
        kind: 'local',
        ...(localMachineId ? { machineId: localMachineId } : {}),
        rootPath: item.rootPath,
        name: item.name,
      });
    },
    [localMachineId, onProjectChange, runtime, t]
  );

  const suggestionPills = useMemo(
    () => buildStaticSuggestionPills(Boolean(project), repoHints, t),
    [project, repoHints, t]
  );

  const runExitChoreography = useCallback(
    async (action: () => Promise<boolean>) => {
      onBeginExitTransition();
      if (!reducedMotion) {
        await new Promise((resolve) => window.setTimeout(resolve, 160));
      }
      await action();
    },
    [onBeginExitTransition, reducedMotion]
  );

  const handleSend = useCallback(async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || submitting) return;

    if (!hasReadyAgentOrModel) {
      setSendBlockedHint(true);
      setConnectSheetOpen(true);
      return;
    }

    setSubmitting(true);
    setSendBlockedHint(false);
    playSelect();

    let createdSessionId: SessionId | undefined;

    if (runtime && user && localMachineId) {
      const sessionStartedAtMs = analytics.now();
      analytics.capture('onboarding/operation_started', {
        step: 'start',
        operation: 'first_session_create',
        project_kind: project?.kind ?? 'none',
      });

      try {
        // Ensure a real `AgentConfigMeta` exists on this machine for `Lody Agent` (`sorbet`).
        let resolvedConfig: AgentConfigMeta;
        const existingTarget = activeThirdPartyConfig ?? sorbetConfig;
        if (existingTarget) {
          resolvedConfig = existingTarget;
        } else {
          const freshConfig: AgentConfigMeta = {
            id: uuidv4() as AgentConfigId,
            machineId: localMachineId,
            name: 'Lody Agent',
            description: undefined,
            cliType: 'builtin',
            agentType: 'sorbet',
            env: {},
            sessionDefaults: {
              configOptionValues: {
                permission_mode: 'ask',
                ...(modelChip?.modelSelector
                  ? { model: modelChip.modelSelector }
                  : probeReadyModel?.model
                    ? { model: probeReadyModel.model }
                    : {}),
              },
            },
          };
          const newId = (await createAgentConfig(freshConfig)) as AgentConfigId;
          resolvedConfig = { ...freshConfig, id: newId };
        }

        let projectRef: ProjectRef | undefined;
        if (project?.kind === 'local') {
          let localProjectId = project.localProjectId;
          if (!localProjectId && project.rootPath) {
            const prepared = await prepareAndWriteLocalProject({
              runtime,
              machineId: localMachineId,
              rootPath: project.rootPath,
              timeoutMessage: t('onboarding.start.projectTimeout', {
                defaultValue: 'Timed out while preparing project.',
              }),
            });
            localProjectId = prepared.localProjectId;
          }
          if (localProjectId) {
            projectRef = { kind: 'local', localProjectId };
          }
        }

        const chosenModelSelector =
          resolvedConfig.agentType === 'sorbet'
            ? modelChip?.modelSelector || probeReadyModel?.model
            : undefined;

        const entry = buildInitialHistoryEntry({
          userId: user.id,
          timestamp: new Date(getServerNow()).toISOString(),
          cliType: resolvedConfig.cliType,
          agentType: resolvedConfig.agentType,
          prompt: buildAgentPrompt(trimmedPrompt, resolvedConfig.prompt ?? ''),
          inputBlocks: undefined,
          ...(chosenModelSelector
            ? {
                configOptionValues: {
                  model: chosenModelSelector,
                  permission_mode: 'ask',
                },
              }
            : {}),
        });

        if (entry) {
          const result = await startSession(
            {
              sessionId: uuidv4() as SessionId,
              userId: user.id,
              cliType: resolvedConfig.cliType,
              agentType: resolvedConfig.agentType,
              customAcp: resolvedConfig.customAcp,
              runtimeOverrides: resolvedConfig.runtimeOverrides,
              machineId: resolvedConfig.machineId,
              agentConfigId: resolvedConfig.id,
              env: resolvedConfig.env,
              ...(projectRef ? { project: projectRef } : {}),
              title: trimmedPrompt.slice(0, 50),
              titleSource: 'draft',
            },
            entry
          );
          createdSessionId = result.sessionId;
          analytics.capture('onboarding/operation_succeeded', {
            step: 'start',
            operation: 'first_session_create',
            project_kind: project?.kind ?? 'none',
            duration_ms: analytics.durationSince(sessionStartedAtMs),
          });

          const dispatchStartedAtMs = analytics.now();
          analytics.capture('onboarding/operation_started', {
            step: 'start',
            operation: 'first_session_dispatch',
          });
          void requestSessionDispatch(result.sessionId, result.historyEntry.id, {
            inputConfig: result.historyEntry.inputConfig,
            machineId: resolvedConfig.machineId,
          }).then(
            () => {
              analytics.capture('onboarding/operation_succeeded', {
                step: 'start',
                operation: 'first_session_dispatch',
                duration_ms: analytics.durationSince(dispatchStartedAtMs),
              });
            },
            () => {
              analytics.capture('onboarding/operation_failed', {
                step: 'start',
                operation: 'first_session_dispatch',
                failure_code: 'first_session_dispatch_failed',
                duration_ms: analytics.durationSince(dispatchStartedAtMs),
                retryable: false,
              });
            }
          );
        }
      } catch (err) {
        console.error('[onboarding] Failed to create initial session on Start:', err);
        analytics.capture('onboarding/operation_failed', {
          step: 'start',
          operation: 'first_session_create',
          failure_code: 'first_session_create_failed',
          retryable: false,
        });
      }
    }

    await runExitChoreography(() => onEnterWithSession(createdSessionId));
    setSubmitting(false);
  }, [
    activeThirdPartyConfig,
    analytics,
    createAgentConfig,
    hasReadyAgentOrModel,
    localMachineId,
    modelChip?.modelSelector,
    onEnterWithSession,
    probeReadyModel?.model,
    project,
    prompt,
    requestSessionDispatch,
    runExitChoreography,
    runtime,
    sorbetConfig,
    startSession,
    submitting,
    t,
    user,
  ]);

  const handleExploreFirst = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    await runExitChoreography(() => onExploreFirst());
    setSubmitting(false);
  }, [onExploreFirst, runExitChoreography, submitting]);

  const fadeOutChromeProps = {
    animate: exitingToProduct ? { opacity: 0, y: reducedMotion ? 0 : -4 } : { opacity: 1, y: 0 },
    transition: {
      duration: reducedMotion ? 0.08 : exitingToProduct ? 0.16 : DUR_IN_S,
      ease: exitingToProduct ? EASE_IN : EASE_OUT,
    },
  };

  return (
    <div
      {...stylex.props(styles.stage, flatSurface.onboardingLightScope)}
      data-testid="onboarding-start-screen"
    >
      <div {...stylex.props(styles.centerColumn)} className={WINDOW_DRAG_EXEMPT_CLASS}>
        <motion.h1 {...fadeOutChromeProps} {...stylex.props(styles.title)}>
          {t('onboarding.start.title', { defaultValue: 'Where should we start?' })}
        </motion.h1>

        {/* Real App ChatComposer — transitions seamlessly into the product */}
        <motion.div
          layout={!reducedMotion}
          transition={SPRING_CHIP}
          {...stylex.props(styles.composerWrap)}
        >
          <ChatComposer
            variant="landing"
            tone="light"
            promptId="chat-prompt"
            promptRef={promptInputRef}
            promptAutoFocus
            promptValue={prompt}
            onPromptChange={(next) => {
              setPrompt(next);
              if (sendBlockedHint) setSendBlockedHint(false);
            }}
            onPromptKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !isImeComposingKeyboardEvent(event)
              ) {
                event.preventDefault();
                void handleSend();
              }
            }}
            promptPlaceholder={t('onboarding.start.placeholder', {
              defaultValue: 'Give Lody something to do…',
            })}
            footerSelector={
              <div {...stylex.props(styles.footerChips)}>
                {/* Optional Project chip (`[┆无项目 ▾┆]` -> `[▣ repo]`) */}
                <div ref={projectPopoverRef} {...stylex.props(styles.chipAnchor)}>
                  <button
                    type="button"
                    aria-haspopup="listbox"
                    aria-expanded={projectMenuOpen}
                    data-testid="onboarding-project-chip"
                    onClick={() => {
                      setAgentMenuOpen(false);
                      setProjectMenuOpen((open) => !open);
                    }}
                    {...stylex.props(
                      project ? styles.solidChip : styles.projectChipEmpty
                    )}
                  >
                    {project ? (
                      <>
                        <FolderGit2 size={13} strokeWidth={1.9} aria-hidden="true" />
                        <span {...stylex.props(styles.truncate)}>{project.name}</span>
                      </>
                    ) : (
                      <span>
                        {t('onboarding.start.noProject', { defaultValue: 'No project' })}
                      </span>
                    )}
                    <ChevronDown size={12} style={{ opacity: 0.55 }} aria-hidden="true" />
                  </button>

                  <AnimatePresence>
                    {projectMenuOpen ? (
                      <motion.div
                        role="listbox"
                        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
                        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: reducedMotion ? 0.08 : 0.16, ease: EASE_OUT }}
                        {...stylex.props(styles.popover)}
                        data-testid="onboarding-project-popover"
                      >
                        {project ? (
                          <button
                            type="button"
                            onClick={() => {
                              onProjectChange(null);
                              setProjectMenuOpen(false);
                            }}
                            {...stylex.props(styles.popoverItem)}
                          >
                            <span style={{ color: 'var(--flat-ink-secondary)' }}>
                              {t('onboarding.start.clearProject', {
                                defaultValue: 'Start without a project',
                              })}
                            </span>
                          </button>
                        ) : null}

                        <div {...stylex.props(styles.popoverSectionTitle)}>
                          {t('onboarding.start.recentRepos', {
                            defaultValue: 'Recent repositories',
                          })}
                        </div>

                        {showRepoSkeleton && discoveredRepos === null ? (
                          <>
                            <div {...stylex.props(styles.skeletonRow)} />
                            <div {...stylex.props(styles.skeletonRow)} />
                            <div {...stylex.props(styles.skeletonRow)} />
                          </>
                        ) : mergedRepoItems.length > 0 ? (
                          mergedRepoItems.map((repo, idx) => {
                            const selected =
                              project?.kind === 'local' && project.rootPath === repo.rootPath;
                            return (
                              <motion.button
                                key={repo.rootPath}
                                type="button"
                                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                                animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                                transition={{
                                  duration: reducedMotion ? 0.08 : 0.18,
                                  delay: staggerDelay(idx, reducedMotion),
                                  ease: EASE_OUT,
                                }}
                                onClick={() => void handleSelectRepoItem(repo)}
                                {...stylex.props(styles.popoverItem)}
                              >
                                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                                  <span style={{ fontWeight: 520 }}>{repo.name}</span>
                                  <span {...stylex.props(styles.popoverItemSub)}>
                                    {formatCompactPath(repo.rootPath)}
                                  </span>
                                </span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                  {repo.mtimeMs ? (
                                    <span {...stylex.props(styles.popoverItemSub)}>
                                      {formatRelativeRecency(repo.mtimeMs)}
                                    </span>
                                  ) : null}
                                  {selected ? <Check size={13} aria-hidden="true" /> : null}
                                </span>
                              </motion.button>
                            );
                          })
                        ) : discoveredRepos !== null ? (
                          <div
                            style={{
                              paddingInline: '0.625rem',
                              paddingBlock: '0.375rem',
                              fontSize: '0.78125rem',
                              color: 'var(--flat-ink-tertiary)',
                            }}
                          >
                            {t('onboarding.start.noRecentRepos', {
                              defaultValue: 'No repositories found yet — open any folder below.',
                            })}
                          </div>
                        ) : null}

                        <div {...stylex.props(styles.popoverDivider)} />
                        {/* Always immediately interactive, even while repo scan runs */}
                        <button
                          type="button"
                          data-testid="onboarding-open-folder"
                          onClick={() => void handlePickFolderDialog()}
                          {...stylex.props(styles.popoverItem)}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 520 }}>
                            <FolderOpen size={14} strokeWidth={1.85} aria-hidden="true" />
                            <span>
                              {t('onboarding.start.openFolder', { defaultValue: 'Open folder…' })}
                            </span>
                          </span>
                          <span {...stylex.props(styles.kbdHint)}>⌘O</span>
                        </button>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>

                {/* Agent / Model chip */}
                <div ref={agentPopoverRef} {...stylex.props(styles.chipAnchor)}>
                  {hasReadyAgentOrModel ? (
                    <button
                      type="button"
                      aria-haspopup="listbox"
                      aria-expanded={agentMenuOpen}
                      data-testid="onboarding-agent-model-chip"
                      onClick={() => {
                        setProjectMenuOpen(false);
                        setAgentMenuOpen((open) => !open);
                      }}
                      {...stylex.props(styles.solidChip)}
                    >
                      {activeThirdPartyConfig ? (
                        <>
                          <AgentIcon
                            cliType={activeThirdPartyConfig.cliType}
                            agentType={activeThirdPartyConfig.agentType}
                          />
                          <span {...stylex.props(styles.truncate)}>
                            {activeThirdPartyConfig.name}
                          </span>
                        </>
                      ) : (
                        <>
                          <ProviderBrandIcon
                            providerId={modelChip?.providerId ?? probeReadyModel?.provider}
                            size={13}
                          />
                          <span {...stylex.props(styles.truncate)}>
                            Lody Agent
                            {activeModelDisplay ? ` · ${activeModelDisplay}` : ''}
                          </span>
                        </>
                      )}
                      <ChevronDown size={12} style={{ opacity: 0.55 }} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="onboarding-connect-model-chip"
                      onClick={() => {
                        setSendBlockedHint(false);
                        setConnectSheetOpen(true);
                      }}
                      {...stylex.props(styles.amberChip)}
                    >
                      <Sparkles size={12} strokeWidth={2} aria-hidden="true" />
                      <span>
                        {t('onboarding.start.connectModelChip', {
                          defaultValue: 'Connect model',
                        })}
                      </span>
                    </button>
                  )}

                  <AnimatePresence>
                    {agentMenuOpen ? (
                      <motion.div
                        role="listbox"
                        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
                        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: reducedMotion ? 0.08 : 0.16, ease: EASE_OUT }}
                        {...stylex.props(styles.popover)}
                      >
                        <div {...stylex.props(styles.popoverSectionTitle)}>Lody Agent</div>
                        {(controller.probe?.models ?? []).slice(0, 8).map((m) => {
                          const selected =
                            !activeThirdPartyConfig &&
                            (modelChip?.modelSelector ?? probeReadyModel?.model) === m.selector;
                          return (
                            <button
                              key={m.selector}
                              type="button"
                              onClick={() => {
                                onAgentConfigChange(null);
                                void controller.applyDefaultModelSelection(m.selector);
                                onModelConnected({
                                  providerId: m.providerId,
                                  providerName: m.providerId,
                                  modelSelector: m.selector,
                                  modelName: m.displayName,
                                  source: modelChip?.source ??
                                    probeReadyModel?.source ?? { kind: 'oauth' },
                                });
                                setAgentMenuOpen(false);
                              }}
                              {...stylex.props(styles.popoverItem)}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                                <ProviderBrandIcon providerId={m.providerId} size={13} />
                                <span {...stylex.props(styles.truncate)}>{m.displayName}</span>
                              </span>
                              {selected ? <Check size={13} aria-hidden="true" /> : null}
                            </button>
                          );
                        })}

                        <button
                          type="button"
                          onClick={() => {
                            setAgentMenuOpen(false);
                            setConnectSheetOpen(true);
                          }}
                          {...stylex.props(styles.popoverItem)}
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--flat-ink-secondary)' }}>
                            <Plus size={13} aria-hidden="true" />
                            <span>
                              {t('onboarding.start.connectAnotherModel', {
                                defaultValue: 'Connect another model…',
                              })}
                            </span>
                          </span>
                        </button>

                        <div {...stylex.props(styles.popoverSectionTitle)}>
                          {t('onboarding.start.otherAgents', {
                            defaultValue: 'Third-party agents',
                          })}
                        </div>
                        {THIRD_PARTY_AGENTS.map((agent) => {
                          const installed = localConfigs.find(
                            (cfg) => cfg.cliType === 'builtin' && cfg.agentType === agent.agentType
                          );
                          const installing = providerSetups.find(
                            (task) =>
                              task.machineId === localMachineId &&
                              task.config.agentType === agent.agentType &&
                              task.status !== 'failed'
                          );
                          const selected =
                            Boolean(installed) && activeThirdPartyConfig?.id === installed?.id;

                          return (
                            <button
                              key={agent.agentType}
                              type="button"
                              disabled={Boolean(installing) || (!installed && !localMachineId)}
                              onClick={() => {
                                if (installed) {
                                  onAgentConfigChange(installed.id);
                                  setAgentMenuOpen(false);
                                  return;
                                }
                                if (!localMachineId) return;
                                void startProviderSetup({
                                  id: uuidv4() as AgentConfigId,
                                  machineId: localMachineId,
                                  cliType: 'builtin',
                                  agentType: agent.agentType,
                                  name: agent.label,
                                  description: undefined,
                                  env: {},
                                }).then((setupId: AgentConfigId) => {
                                  if (setupId) onAgentConfigChange(setupId);
                                });
                              }}
                              {...stylex.props(styles.popoverItem)}
                            >
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                                <AgentIcon cliType="builtin" agentType={agent.agentType} />
                                <span>{agent.label}</span>
                              </span>
                              {installing ? (
                                <StatusRingOrCheck
                                  phase="waiting"
                                  reducedMotion={reducedMotion}
                                />
                              ) : selected ? (
                                <Check size={13} aria-hidden="true" />
                              ) : !installed ? (
                                <span {...stylex.props(styles.popoverItemSub)}>
                                  {t('onboarding.start.installOnDemand', {
                                    defaultValue: 'Install',
                                  })}
                                </span>
                              ) : null}
                            </button>
                          );
                        })}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </div>
              </div>
            }
            primaryAction={
              <div {...stylex.props(styles.sendWrap)}>
                {!hasReadyAgentOrModel && (sendBlockedHint || prompt.trim().length > 0) ? (
                  <span {...stylex.props(styles.sendHint)}>
                    {t('onboarding.start.connectBeforeSend', {
                      defaultValue: 'Connect a model to send',
                    })}
                  </span>
                ) : null}
                <button
                  type="button"
                  data-testid="onboarding-start-send"
                  aria-label={
                    hasReadyAgentOrModel
                      ? t('onboarding.start.sendAria', { defaultValue: 'Send first task' })
                      : t('onboarding.start.connectBeforeSend', {
                          defaultValue: 'Connect a model to send',
                        })
                  }
                  title={
                    !hasReadyAgentOrModel
                      ? t('onboarding.start.connectBeforeSend', {
                          defaultValue: 'Connect a model to send',
                        })
                      : undefined
                  }
                  disabled={!prompt.trim() || submitting}
                  onClick={() => void handleSend()}
                  {...stylex.props(styles.sendBtn)}
                >
                  {submitting ? (
                    <StatusRingOrCheck phase="waiting" reducedMotion={reducedMotion} />
                  ) : (
                    <ArrowUp size={15} strokeWidth={2.2} aria-hidden="true" />
                  )}
                </button>
              </div>
            }
          />
        </motion.div>

        {/* Static suggestion pills — crossfade smoothly on project change (§5.4) */}
        <motion.div {...fadeOutChromeProps} {...stylex.props(styles.pillsRow)}>
          <AnimatePresence mode="popLayout" initial={false}>
            {suggestionPills.map((pill) => (
              <motion.button
                key={`${project?.name ?? 'none'}:${pill}`}
                type="button"
                initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={
                  reducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, y: -3, transition: { duration: DUR_OUT_S, ease: EASE_IN } }
                }
                transition={{ duration: reducedMotion ? 0.1 : DUR_IN_S, ease: EASE_OUT }}
                onClick={() => {
                  setPrompt(pill);
                  promptInputRef.current?.focus();
                }}
                {...stylex.props(styles.suggestionPill)}
              >
                {pill}
              </motion.button>
            ))}
          </AnimatePresence>
        </motion.div>

        {/* Explore first (`先逛逛 →`) */}
        <motion.div {...fadeOutChromeProps} {...stylex.props(styles.exploreRow)}>
          <button
            type="button"
            disabled={submitting}
            data-testid="onboarding-explore-first"
            onClick={() => void handleExploreFirst()}
            {...stylex.props(flatSurface.quietButton)}
          >
            <span>{t('onboarding.start.exploreFirst', { defaultValue: 'Explore first' })}</span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </motion.div>
      </div>

      {/* Shared ConnectModelSheet modal when clicking amber `连接模型` or `+ 连接更多模型…` */}
      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {connectSheetOpen ? (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0.08 : 0.16 }}
                  onPointerDown={(e) => {
                    if (e.target === e.currentTarget) setConnectSheetOpen(false);
                  }}
                  {...stylex.props(styles.sheetBackdrop, flatSurface.onboardingLightScope)}
                >
                  <motion.div
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('onboarding.model.title', { defaultValue: 'Connect a model' })}
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
                    animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={SPRING_CHIP}
                    {...stylex.props(styles.sheetDialog)}
                  >
                    <button
                      type="button"
                      aria-label={t('common.close', { defaultValue: 'Close' })}
                      onClick={() => setConnectSheetOpen(false)}
                      {...stylex.props(styles.sheetCloseBtn)}
                    >
                      <X size={14} />
                    </button>
                    <ConnectModelSheet
                      showHeader
                      onConnected={(payload) => {
                        onModelConnected(payload);
                        setSendBlockedHint(false);
                        setConnectSheetOpen(false);
                        promptInputRef.current?.focus();
                      }}
                    />
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </div>
  );
}
