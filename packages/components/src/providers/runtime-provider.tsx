import { subscribeAttachmentWorkspaceMode } from '@/lib/attachment-workspace-access';
import { subscribeE2eeLedgerChanges } from './e2ee-runtime-notifications';
import { useTranslation } from 'react-i18next';
import { desktopWindowId } from '@/lib/desktop-window';
import {
  isE2eeMemberRemoved,
  retainEncryptedWorkspaceCleanup,
  resumeEncryptedWorkspaceCleanup,
  retryRetiredEncryptedWorkspaceCleanup,
} from '@/lib/e2ee-member-removal';
import {
  readEncryptedLocalIdentity,
  retainEncryptedLocalIdentity,
  type E2eeLocalDataIdentity,
  type E2eeLocalDataScope,
} from '@/lib/e2ee-local-data';
import { createE2eeContent } from './desktop-e2ee-content';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import { SessionPendingSendsHost } from '../components/chat/session-pending-sends-host';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { LODY_PRESENCE_HEARTBEAT_MS, type MachineId, type WorkspaceId } from '@lody/shared';
import {
  authTokenAtom,
  runtimeAtom,
  workspaceModeAdmissionRetryAtom,
  workspaceRuntimeInitFailureAtom,
} from '@/atoms/runtime';
import { setSessionRunConfigDraftAccountAtom } from '@/atoms/session-run-config-drafts';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import {
  clearDocMetaCacheAtom,
  docMetaSubscriptionAtom,
  readReadyDocMetaCache,
} from '@/atoms/doc-meta';
import {
  clearLodyPresenceStatesAtom,
  setLodyPresenceNowMsAtom,
  setLodyPresenceStatesAtom,
  setLodyPresenceSyncStateAtom,
} from '@/atoms/presence';
import {
  localAgentEnabledAtom,
  localProbeAttemptedAtom,
  localProbeEffectAtom,
  localProbeResultAtom,
} from '@/atoms/local-probe';
import {
  lodyControlConnectionStateAtom,
  runtimeInitializingAtom,
  browserOnlineAtom,
} from '@/atoms/control-connection';
import { API_BASE_URL } from '@/lib';
import { getCachedWorkspaceId } from '@/lib/local-storage-cache';
import { recordClientError } from '@/lib/client-log';
import { usePostHog } from '@posthog/react';
import { createWorkspaceRuntime } from './create-workspace-runtime';
import { resolveCloudPlatformRuntimePolicy } from './cloud-platform-runtime-policy';
import type { EagerSyncSurface } from './background-sync-coordinator';
import { resolveEffectiveWorkspaceId } from './resolve-effective-workspace-id';
import { getLocalWorkspaceSlug, useImplicitLocalWorkspace } from './local-platform-provider';
import { isWarmWindow } from '@/lib/desktop-window';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { maybeClearLodyCacheOnBoot } from '@/lib/clear-local-cache';
import { describeErrorType } from '@/lib/workspace-data-scope';
import { isElectronRenderer } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';
import { usePlatform } from '@lody/platform/react';
import { useVisibleMachineMetas } from '@/hooks/use-visible-machine-metas';
import { subscribeLocalAuthStateCleared } from '@/lib/auth';
import { workspaceContentModeAtom } from '@/atoms/workspace-content-mode';
import type { WorkspaceAdmissionDescriptor } from '@lody/cloud-api';
import { isListedEncryptedWorkspace } from '@/components/e2ee/encrypted-workspace-mark';
import {
  E2eeLocalEvidenceCorruptError,
  E2eeLocalEvidenceConflictError,
  hasEncryptedEvidenceForAnyAccount,
  hasPendingE2eeCreationForSlug,
  isWorkspaceModeStorageKey,
  readWorkspaceModeEvidence,
  recordWorkspaceModeRejection,
  retainWorkspaceModeProof,
  type WorkspaceModeEvidence,
} from '@/lib/e2ee-workspace-storage';
import {
  describeAuthenticatedWorkspace,
  waitForWorkspaceContentAdmission,
  isWorkspaceModeRejection,
  WORKSPACE_MODE_ADMISSION_TIMEOUT_MS,
  WorkspaceModeAdmissionTimeoutError,
  WorkspaceModeMismatchError,
} from './workspace-mode-admission';
import { useWorkspaceModeProofPrefetch } from './workspace-mode-prefetch';

type SavedMode = {
  /** Local mode evidence for each candidate workspace ID of the current slug. */
  evidence: ReadonlyMap<string, WorkspaceModeEvidence>;
  /** An unresolved encrypted creation intent names this slug. */
  pendingCreation: boolean;
  error: unknown;
};
const noSavedMode: SavedMode = { evidence: new Map(), pendingCreation: false, error: null };

const isEncryptedDescriptor = (
  descriptor: WorkspaceAdmissionDescriptor
): descriptor is Extract<WorkspaceAdmissionDescriptor, { contentMode: 'e2ee' }> =>
  'contentMode' in descriptor && descriptor.contentMode === 'e2ee';

const isExpectedRuntimeShutdownError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message === 'Destroyed' || error.message === 'Runtime disposed';
};

const logRuntimeOperationError = (operation: string, error: unknown): void => {
  if (
    error instanceof DOMException &&
    error.name === 'AbortError' &&
    error.message === 'Authentication superseded'
  ) {
    console.debug(`RuntimeProvider: ${operation} cancelled by newer authentication`);
    return;
  }
  if (isExpectedRuntimeShutdownError(error)) {
    console.info(`RuntimeProvider: ${operation} skipped during shutdown`);
    return;
  }
  console.error(`RuntimeProvider: ${operation} failed`, error);
  recordClientError('runtime.operation_failed', error, { operation });
};

const resolveRuntimeEagerSyncSurface = (): EagerSyncSurface => {
  if (isElectronRenderer()) {
    return 'desktop';
  }
  if (isNativeAppShell()) {
    return 'mobile';
  }
  return 'web';
};

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const { t } = useTranslation();
  const [snapshotRecoveryWorkspace, setSnapshotRecoveryWorkspace] = useState<string | null>(null);
  const [keyUpdateWorkspace, setKeyUpdateWorkspace] = useState<string | null>(null);
  const retryKeyUpdateRef = useRef<() => void>(() => {});
  // Use workspaceSlug for runtime initialization (available immediately from URL)
  // Use workspaceId for WebSocket connections (requires server response)
  const routeWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const localProbeResult = useAtomValue(localProbeResultAtom);
  const localProbeAttempted = useAtomValue(localProbeAttemptedAtom);
  const localAgentEnabled = useAtomValue(localAgentEnabledAtom);
  const token = useAtomValue(authTokenAtom);
  const currentUser = useAtomValue(userAtom);
  const previousShutdown = useRef<() => Promise<void>>(async () => {});
  const runtime = useAtomValue(runtimeAtom);
  const setRuntime = useSetAtom(runtimeAtom);
  const setRuntimeInitFailure = useSetAtom(workspaceRuntimeInitFailureAtom);
  const runtimeInitFailure = useAtomValue(workspaceRuntimeInitFailureAtom);
  const admissionRetry = useAtomValue(workspaceModeAdmissionRetryAtom);
  const retryAdmission = useSetAtom(workspaceModeAdmissionRetryAtom);
  const setContentMode = useSetAtom(workspaceContentModeAtom);
  const store = useStore();
  const setControlConnectionState = useSetAtom(lodyControlConnectionStateAtom);
  const setRuntimeInitializing = useSetAtom(runtimeInitializingAtom);
  const setBrowserOnline = useSetAtom(browserOnlineAtom);
  useAtomValue(docMetaSubscriptionAtom);
  useAtomValue(localProbeEffectAtom);
  const clearDocMetaCache = useSetAtom(clearDocMetaCacheAtom);
  const clearPresenceStates = useSetAtom(clearLodyPresenceStatesAtom);
  const setPresenceStates = useSetAtom(setLodyPresenceStatesAtom);
  const setPresenceNowMs = useSetAtom(setLodyPresenceNowMsAtom);
  const setPresenceSyncState = useSetAtom(setLodyPresenceSyncStateAtom);
  const visibleMachineIndex = useVisibleMachineMetas({
    includeMachineFlock: false,
    syncMachineFlock: false,
  });
  const authorizedMachineIdsRef = useRef<{
    machineIds: ReadonlySet<MachineId>;
    workspaceId: WorkspaceId;
  } | null>(null);
  authorizedMachineIdsRef.current =
    visibleMachineIndex.isLoading || !workspaceId
      ? null
      : {
          workspaceId,
          machineIds: new Set(visibleMachineIndex.convexAuthorizedMachineIds),
        };

  // Routed to PostHog via the runtime's onAnalyticsEvent. Kept in a ref so the
  // (slug/id-keyed) init effect does not re-run when the PostHog client identity changes.
  const postHog = usePostHog();
  const postHogRef = useRef(postHog);
  postHogRef.current = postHog;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const prevWorkspaceSlugRef = useRef<string | null>(null);
  const prevWorkspaceIdRef = useRef<WorkspaceId | null>(null);

  // Local (open-source) platform: the effective workspace id is the CLI's
  // implicit workspace — no cached/server id arbitration, no auth involved.
  const isLocalPlatform = platform.sync.mode === 'local';
  const offlineEncryptedCandidate =
    !isLocalPlatform &&
    Boolean(platform.e2eeWorkspaces) &&
    (() => {
      try {
        const ids = [
          workspaceId,
          routeWorkspaceSlug ? getCachedWorkspaceId(routeWorkspaceSlug) : null,
        ];
        return ids.some((id) => Boolean(id && hasEncryptedEvidenceForAnyAccount(localStorage, id)));
      } catch {
        return false;
      }
    })();
  const offlineE2eeAccountId = useE2eeAccountId(offlineEncryptedCandidate);
  const accountId =
    currentUser?.id ??
    (isLocalPlatform ? 'local' : offlineEncryptedCandidate ? offlineE2eeAccountId : null);
  const draftAccountId = currentUser?.id ?? null;
  const setRunConfigDraftAccount = useSetAtom(setSessionRunConfigDraftAccountAtom);
  useEffect(() => {
    // An absent auth snapshot can be hydration. Only confirmed logout below
    // ends ownership; a positive identity also handles direct account changes.
    if (draftAccountId) setRunConfigDraftAccount(draftAccountId);
  }, [draftAccountId, setRunConfigDraftAccount]);
  useEffect(() => {
    // A fresh authenticated token can establish a new login for the same user
    // even when the cached user id never changed. Merely clearing the owner
    // must not re-arm it from the unchanged, pre-logout identity/token.
    if (token && draftAccountId) setRunConfigDraftAccount(draftAccountId);
  }, [token, draftAccountId, setRunConfigDraftAccount]);
  useEffect(() => {
    const unsubscribe = subscribeLocalAuthStateCleared(() => setRunConfigDraftAccount(null));
    return () => {
      unsubscribe();
      setRunConfigDraftAccount(null);
    };
    // This is the app owner, not the workspace runtime. Route/workspace changes
    // and transport restarts must preserve unsent drafts.
  }, [setRunConfigDraftAccount]);
  const telemetryEnabled = platform.capabilities.has('telemetry');
  const implicitLocalWorkspace = useImplicitLocalWorkspace();
  // Start the local Repo and metadata sync while the spare still has no route.
  // A matching claim keeps these effect keys unchanged and retains the runtime.
  const workspaceSlug =
    routeWorkspaceSlug ??
    (isLocalPlatform && isWarmWindow() && implicitLocalWorkspace
      ? getLocalWorkspaceSlug(implicitLocalWorkspace)
      : null);
  const { ready: localAgentRuntimeReady } = resolveCloudPlatformRuntimePolicy({
    electron: isElectronRenderer(),
    localAgentEnabled,
  });

  // Compute effective workspaceId:
  // - Prefer cached id for the current slug (offline-first, avoids stale auth ids during transitions)
  // - Otherwise, use server/auth id only if it is not stale.
  // This is computed outside effect so it's stable across renders.
  const cachedId = workspaceSlug
    ? (getCachedWorkspaceId(workspaceSlug) as WorkspaceId | null)
    : null;
  const [modeStorageRevision, setModeStorageRevision] = useState(0);
  // Rejections whose durable marker storage refused; they hold for this session.
  const sessionModeRejectionsRef = useRef(new Set<string>());
  const modeCloud = Boolean(platform.e2eeWorkspaces) && !isLocalPlatform;
  // Both candidate IDs are checked so neither a stale cache nor a stale server
  // id can hide this workspace's encrypted evidence. Equal IDs keep one key, so
  // the server confirming the cached ID does not invalidate the read.
  const modeCandidateKey = [...new Set([cachedId, workspaceId].filter(Boolean))].join('\n');
  useEffect(() => {
    if (!modeCloud || !modeCandidateKey) return undefined;
    const ids = modeCandidateKey.split('\n');
    const changed = (event: StorageEvent) => {
      if (
        event.storageArea === localStorage &&
        (event.key === null || event.oldValue !== event.newValue) &&
        (accountId
          ? ids.some((id) => isWorkspaceModeStorageKey(event.key, accountId, id))
          : event.key === null || event.key.startsWith('lody-e2ee-'))
      )
        setModeStorageRevision((value) => value + 1);
    };
    window.addEventListener('storage', changed);
    const stopAttachmentMode = subscribeAttachmentWorkspaceMode((owner, id) => {
      if (owner === accountId && ids.includes(id)) setModeStorageRevision((value) => value + 1);
    });
    return () => {
      window.removeEventListener('storage', changed);
      stopAttachmentMode();
    };
  }, [modeCloud, accountId, modeCandidateKey]);
  const savedMode = useMemo((): SavedMode => {
    // Relevant storage events, and an explicit retry after local repair, invalidate this read.
    void modeStorageRevision;
    void admissionRetry;
    if (!modeCloud || !workspaceSlug) return noSavedMode;
    try {
      const evidence = new Map<string, WorkspaceModeEvidence>();
      for (const id of modeCandidateKey ? modeCandidateKey.split('\n') : []) {
        evidence.set(
          id,
          accountId
            ? (() => {
                const read = readWorkspaceModeEvidence(localStorage, accountId, id);
                return sessionModeRejectionsRef.current.has(JSON.stringify([accountId, id]))
                  ? { ...read, rejected: true }
                  : read;
              })()
            : {
                descriptor: null,
                encrypted: hasEncryptedEvidenceForAnyAccount(localStorage, id),
                rejected: false,
              }
        );
      }
      return {
        evidence,
        pendingCreation: accountId
          ? hasPendingE2eeCreationForSlug(localStorage, accountId, workspaceSlug)
          : false,
        error: null,
      };
    } catch (error) {
      return { evidence: new Map(), pendingCreation: false, error };
    }
  }, [modeCloud, accountId, workspaceSlug, modeCandidateKey, modeStorageRevision, admissionRetry]);
  // The listing's mode is display metadata: it can only demand authoritative
  // admission, never prove plaintext.
  const workspacesStore = platform.workspaces.state;
  const listedEncrypted = useSyncExternalStore(workspacesStore.subscribe, () => {
    if (!modeCloud || !workspaceSlug) return false;
    const state = workspacesStore.get();
    return (
      state.status === 'ready' &&
      state.workspaces.some(
        (item) =>
          (item.slug === workspaceSlug || modeCandidateKey.split('\n').includes(item.id)) &&
          isListedEncryptedWorkspace(item)
      )
    );
  });
  const localEncryptedEvidence =
    savedMode.pendingCreation || [...savedMode.evidence.values()].some((item) => item.encrypted);
  // A recorded non-plaintext answer demands admission without proving encryption,
  // so failure wording stays generic unless encrypted creation is on.
  const localRejection = [...savedMode.evidence.values()].some((item) => item.rejected);
  // Owner-approved availability trade-off: a workspace without local encrypted
  // evidence and not listed as encrypted opens through the pre-E2EE offline-first
  // path; its mode is verified in the background, which retires the runtime if
  // the workspace turns out to be encrypted. Workspaces with evidence keep
  // authoritative admission before any data plane.
  const requiresAdmission =
    modeCloud &&
    (localEncryptedEvidence || localRejection || listedEncrypted || savedMode.error !== null);
  const knownEncrypted = localEncryptedEvidence || listedEncrypted;
  const effectiveWorkspaceId = isLocalPlatform
    ? workspaceSlug
      ? ((implicitLocalWorkspace?.id as WorkspaceId | undefined) ?? null)
      : null
    : requiresAdmission
      ? (workspaceId ??
        (cachedId && savedMode.evidence.get(cachedId)?.descriptor ? cachedId : null))
      : resolveEffectiveWorkspaceId({
          workspaceSlug,
          cachedWorkspaceId: cachedId,
          serverWorkspaceId: workspaceId,
          prevWorkspaceSlug: prevWorkspaceSlugRef.current,
          prevServerWorkspaceId: prevWorkspaceIdRef.current,
        });
  // Read inside the initialization effect without making a newly cached proof,
  // or the same proof re-read, restart a healthy runtime. Changes that matter
  // (new encrypted evidence, unreadable evidence, retry) change effect keys.
  const savedModeRef = useRef(savedMode);
  savedModeRef.current = savedMode;
  // Recovery lookup only; native independently verifies this cached/listed ID.
  const recoveryWorkspaceIdRef = useRef(workspaceId ?? cachedId);
  recoveryWorkspaceIdRef.current = workspaceId ?? cachedId;
  const knownEncryptedRef = useRef(knownEncrypted);
  knownEncryptedRef.current = knownEncrypted;
  const savedModeErrorType = savedMode.error ? describeErrorType(savedMode.error) : null;
  useWorkspaceModeProofPrefetch(platform, modeCloud ? accountId : null, workspaceSlug);
  const effectiveWorkspaceIdSource = isLocalPlatform
    ? effectiveWorkspaceId
      ? 'local-platform'
      : 'pending'
    : effectiveWorkspaceId && cachedId === effectiveWorkspaceId
      ? 'cache'
      : effectiveWorkspaceId && workspaceId === effectiveWorkspaceId
        ? 'server'
        : effectiveWorkspaceId
          ? 'previous'
          : 'pending';

  // A timed-out first admission should recover when connectivity or the same
  // account returns. Subscribe only while failed; auth refresh never owns a
  // healthy runtime or changes the initialization effect's keys.
  useEffect(() => {
    if (
      !platform.e2eeWorkspaces ||
      !accountId ||
      !workspaceSlug ||
      runtimeInitFailure?.workspaceSlug !== workspaceSlug ||
      runtimeInitFailure.errorType !== WorkspaceModeAdmissionTimeoutError.name
    )
      return undefined;
    let previousStatus = platform.identity.session.get().status;
    const unsubscribe = platform.identity.session.subscribe(() => {
      const current = platform.identity.session.get();
      if (
        previousStatus !== 'authenticated' &&
        current.status === 'authenticated' &&
        current.user.id === accountId
      )
        retryAdmission((value) => value + 1);
      previousStatus = current.status;
    });
    const onOnline = () => retryAdmission((value) => value + 1);
    window.addEventListener('online', onOnline);
    return () => {
      unsubscribe();
      window.removeEventListener('online', onOnline);
    };
  }, [
    platform.e2eeWorkspaces,
    platform.identity.session,
    accountId,
    workspaceSlug,
    runtimeInitFailure,
    retryAdmission,
  ]);
  const workspaceIdResolutionLogRef = useRef({
    cachedWorkspaceId: cachedId,
    serverWorkspaceId: workspaceId,
    workspaceIdSource: effectiveWorkspaceIdSource,
  });
  workspaceIdResolutionLogRef.current = {
    cachedWorkspaceId: cachedId,
    serverWorkspaceId: workspaceId,
    workspaceIdSource: effectiveWorkspaceIdSource,
  };

  useEffect(() => {
    prevWorkspaceSlugRef.current = workspaceSlug;
    prevWorkspaceIdRef.current = workspaceId;
  }, [workspaceId, workspaceSlug]);

  useEffect(() => {
    console.info('RuntimeProvider: workspace id resolution', {
      workspaceSlug,
      cachedWorkspaceId: cachedId,
      serverWorkspaceId: workspaceId,
      effectiveWorkspaceId,
      source: effectiveWorkspaceIdSource,
    });
  }, [cachedId, effectiveWorkspaceId, effectiveWorkspaceIdSource, workspaceId, workspaceSlug]);

  useEffect(() => {
    if (!workspaceSlug || typeof window === 'undefined') {
      return undefined;
    }
    const id = window.setInterval(() => {
      setPresenceNowMs();
    }, LODY_PRESENCE_HEARTBEAT_MS);
    return () => {
      window.clearInterval(id);
    };
  }, [setPresenceNowMs, workspaceSlug]);

  // Initialize runtime when we have a workspaceId (either from cache or server).
  // - If cached id exists for this slug: initialize immediately (offline-first)
  // - Otherwise: wait for server to respond with workspaceId
  useEffect(() => {
    // A failure describes one attempt; every new attempt starts without one.
    setRuntimeInitFailure(null);
    const saved = savedModeRef.current;
    const storedDescriptor = effectiveWorkspaceId
      ? (saved.evidence.get(effectiveWorkspaceId)?.descriptor ?? null)
      : null;
    const modeAdmissionFailure = (error: unknown) => ({
      workspaceSlug: workspaceSlug!,
      errorType: describeErrorType(error),
      modeAdmission: {
        knownEncrypted:
          knownEncryptedRef.current ||
          (error instanceof E2eeLocalEvidenceCorruptError &&
            ['Invalid genesis pin', 'Invalid encrypted evidence'].includes(error.message)) ||
          (error instanceof E2eeLocalEvidenceConflictError &&
            error.message === 'Workspace mode conflicts with encrypted evidence'),
        ...((effectiveWorkspaceId ?? recoveryWorkspaceIdRef.current)
          ? { workspaceId: (effectiveWorkspaceId ?? recoveryWorkspaceIdRef.current)! }
          : {}),
      },
    });
    // A restart of the same account/workspace (local-agent toggle, retry) keeps
    // the last verified mode so the workspace tree does not unmount and flash.
    // Anything that may change the verdict starts without one.
    const previousMode = store.get(workspaceContentModeAtom);
    const retainedMode =
      modeCloud &&
      workspaceSlug &&
      !saved.error &&
      previousMode?.descriptor &&
      previousMode.accountId === accountId &&
      previousMode.workspaceSlug === workspaceSlug &&
      previousMode.workspaceId === effectiveWorkspaceId &&
      (requiresAdmission
        ? JSON.stringify(previousMode.descriptor) === JSON.stringify(storedDescriptor)
        : !isEncryptedDescriptor(previousMode.descriptor))
        ? previousMode
        : null;
    if (!retainedMode) {
      setContentMode(
        modeCloud && workspaceSlug && !requiresAdmission
          ? storedDescriptor && effectiveWorkspaceId
            ? {
                accountId,
                workspaceSlug,
                workspaceId: effectiveWorkspaceId,
                descriptor: storedDescriptor,
              }
            : { accountId, workspaceSlug, workspaceId: effectiveWorkspaceId, descriptor: null }
          : null
      );
    }
    if (!workspaceSlug) {
      console.info('RuntimeProvider: clear runtime due to missing workspaceSlug');
      setRuntime(null);
      setControlConnectionState('idle');
      setRuntimeInitializing(false);
      clearDocMetaCache();
      clearPresenceStates();
      return undefined;
    }

    // Enter a new initialization cycle for this workspace.
    setRuntimeInitializing(true);
    if (saved.error) {
      setRuntime(null);
      setRuntimeInitFailure(modeAdmissionFailure(saved.error));
      setControlConnectionState('error');
      setRuntimeInitializing(false);
      return undefined;
    }
    const admissionTimeout = () => {
      const timeout = window.setTimeout(() => {
        setRuntimeInitFailure(modeAdmissionFailure(new WorkspaceModeAdmissionTimeoutError()));
        setRuntimeInitializing(false);
      }, WORKSPACE_MODE_ADMISSION_TIMEOUT_MS);
      return () => window.clearTimeout(timeout);
    };
    if (requiresAdmission && !accountId) return admissionTimeout();

    // The Electron main-process setting decides whether cloud desktop uses a
    // dual local-first runtime or a cloud-only control runtime. Wait for that
    // first snapshot so a persisted opt-out never opens the local socket even
    // briefly and never flashes a false reconnecting state.
    if (platform.sync.mode === 'dual' && !localAgentRuntimeReady) {
      setControlConnectionState('idle');
      return undefined;
    }

    // Need workspaceId to initialize (either from cache or server)
    // Keep runtimeInitializing=true while waiting for workspaceId
    if (!effectiveWorkspaceId) {
      const { cachedWorkspaceId, serverWorkspaceId } = workspaceIdResolutionLogRef.current;
      console.info('RuntimeProvider: waiting for workspace id before runtime initialization', {
        workspaceSlug,
        cachedWorkspaceId,
        serverWorkspaceId,
      });
      return requiresAdmission ? admissionTimeout() : undefined;
    }

    setKeyUpdateWorkspace(null);
    setSnapshotRecoveryWorkspace(null);
    let disposed = false;
    // Set when background verification closes a provisionally opened runtime.
    let retired = false;
    let removed = false;
    let removalScope: E2eeLocalDataScope | null = null;
    let localIdentity: E2eeLocalDataIdentity | undefined;
    const handleMemberRemoval = () => {
      if (disposed || retired) return;
      removed = true;
      try {
        if (removalScope) retainEncryptedWorkspaceCleanup(removalScope);
      } catch (error) {
        logRuntimeOperationError('retain removal cleanup', error);
      }
      retire();
      setRuntimeInitFailure({ workspaceSlug, errorType: 'e2ee_member_removed' });
    };

    const initializationAbort = new AbortController();
    const newAdmission = () => {
      const admission = Promise.withResolvers<void>();
      // Background classification can fail before an outbound consumer exists.
      void admission.promise.catch(() => {});
      return admission;
    };
    let plaintextAdmission = newAdmission();
    let admissionFailed = false;
    let verifiedOrdinary = false;
    let modeVerification: Promise<void> | null = null;
    if (!isLocalPlatform && !modeCloud)
      plaintextAdmission.reject(new Error('e2ee_workspace_mode_unavailable'));
    const waitForContentAdmission = async (signal: AbortSignal) => {
      const owned = AbortSignal.any([signal, initializationAbort.signal]);
      const assertOwner = () => {
        owned.throwIfAborted();
        const session = platform.identity.session.get();
        if (
          disposed ||
          retired ||
          session.status === 'unauthenticated' ||
          (session.status === 'authenticated' && session.user.id !== accountId)
        )
          throw new Error('e2ee_account_changed');
      };
      const readProof = () => {
        if (!modeCloud || !accountId) return null;
        const evidence = readWorkspaceModeEvidence(localStorage, accountId, effectiveWorkspaceId);
        if (evidence.encrypted || evidence.rejected) {
          retire();
          setModeStorageRevision((value) => value + 1);
          throw new WorkspaceModeMismatchError();
        }
        return evidence.descriptor;
      };
      assertOwner();
      const proof = readProof();
      if (proof && !verifiedOrdinary) admit(proof);
      // Each failed attempt reports to its current waiters. It is not a mode
      // verdict: a later send may verify again or adopt SEC1's matching proof.
      if (admissionFailed) void verifyInBackground();
      await waitForWorkspaceContentAdmission(plaintextAdmission.promise, owned);
      assertOwner();
      readProof();
    };
    let workspaceRuntime: Awaited<ReturnType<typeof createWorkspaceRuntime>> | null = null;
    let disposal: Promise<void> | null = null;
    let contentDisposal: Promise<PromiseSettledResult<void | undefined>[]> | undefined;
    let previousRetirement: (() => Promise<void>) | undefined = previousShutdown.current;
    const encryptedRuntime = platform.e2eeWorkspaces?.runtime;
    let nativeLease: string | null = null;
    let nativeReaderOwner: string | undefined;
    let nativeHasUsableKey = false;
    let nativeRefresh: Promise<void> | null = null;
    let nativeRefreshAgain = false;
    const acceptStatus = async (status: import('@lody/platform').E2eeRuntimeStatus) => {
      const native = encryptedRuntime;
      if (!native || !nativeLease || disposed || retired) return;
      const leased = nativeLease;

      encryptedAccess?.updateStatus(status);
      if (encryptedAccess && workspaceRuntime && encryptedAccess.needsUpdate()) {
        await encryptedAccess.transition({
          install: () => (status.hasCurrentKey ? native.status(leased) : native.refresh(leased)),
        });
        if (disposed || retired) return;
        if (encryptedAccess.phase() === 'ready') setKeyUpdateWorkspace(null);
      }
      if (
        !nativeHasUsableKey &&
        workspaceRuntime === null &&
        (status.hasCurrentKey || status.writeEpoch != null)
      )
        retryAdmission((value) => value + 1);
    };
    const refreshNative = (): void => {
      if (disposed || !nativeLease) return;
      if (nativeRefresh) {
        nativeRefreshAgain = true;
        return;
      }
      const native = encryptedRuntime;
      if (!native) return;
      const leased = nativeLease;
      const pending = native
        .refresh(leased, { installKeys: !nativeHasUsableKey && workspaceRuntime === null })
        .then(acceptStatus)
        .catch(async (error: unknown) => {
          if (disposed || retired) return;
          if (isE2eeMemberRemoved(error)) {
            handleMemberRemoval();
            return;
          }
          // Reception failure stays visible and retryable. The retained epoch
          // remains writable; a status read never confirms key installation.
          try {
            encryptedAccess?.updateStatus(await native.status(leased));
          } catch {
            /* The next explicit/reconnect refresh can retry. */
          }
        });
      nativeRefresh = pending;
      void pending.finally(() => {
        if (nativeRefresh === pending) nativeRefresh = null;
        if (nativeRefreshAgain && !disposed) {
          nativeRefreshAgain = false;
          refreshNative();
        }
      });
    };
    retryKeyUpdateRef.current = refreshNative;
    window.addEventListener('online', refreshNative);
    const unsubscribeLedgerChange = accountId
      ? subscribeE2eeLedgerChanges(accountId, effectiveWorkspaceId, () => {
          const native = encryptedRuntime;
          if (disposed || retired || !native || !nativeLease) return;
          void native
            .status(nativeLease)
            .then(acceptStatus)
            .catch(() => {
              if (!disposed && !retired) setKeyUpdateWorkspace(effectiveWorkspaceId);
            });
        })
      : () => {};
    let encryptedAccess: ReturnType<typeof createE2eeContent> | null = null;
    const disposeRuntime = (): Promise<void> => {
      if (disposal) return disposal;
      const pending = (async () => {
        // Retain a failed earlier owner and let a later acquire retry confirmed
        // close. Do not memoize one timeout as permanent failure or drop custody.
        await previousRetirement?.();
        previousRetirement = undefined;
        // Fence the native reader while independent renderer cleanup starts.
        // A stuck native call must reach its bounded close; awaiting the content
        // bridge first would hide that incomplete result behind the same call.
        contentDisposal ??= initialization.then(() =>
          Promise.allSettled([encryptedAccess?.close(), workspaceRuntime?.dispose()])
        );
        if (nativeLease) {
          await encryptedRuntime!.close(nativeLease, accountId!, nativeReaderOwner);
        }
        await initialization;
        // Legacy hosts acquire their lease only after open settles. A capable
        // host was already fenced above; confirm its same pending/actual label.
        if (nativeLease) await encryptedRuntime!.close(nativeLease, accountId!, nativeReaderOwner);
        const results = await contentDisposal;
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length)
          throw new AggregateError(failures, 'Workspace content close incomplete');
        nativeLease = null;
        nativeReaderOwner = undefined;
        if (removed && removalScope)
          void resumeEncryptedWorkspaceCleanup(removalScope, true).catch((error) => {
            logRuntimeOperationError('removed workspace cleanup', error);
          });
      })();
      disposal = pending;
      void pending.catch(() => {
        if (disposal === pending) disposal = null;
      });
      return pending;
    };
    // Logging-only workspace id resolution inputs intentionally stay out of
    // this effect's dependency list. A cached id can create the runtime before
    // the server id arrives; server-id arrival must not tear down that runtime.
    const { workspaceIdSource } = workspaceIdResolutionLogRef.current;
    setControlConnectionState('idle');

    const admit = (descriptor: WorkspaceAdmissionDescriptor) => {
      if (descriptor.workspaceId !== effectiveWorkspaceId) throw new WorkspaceModeMismatchError();
      // A previous authenticated immutable mode can reopen offline. Pins and
      // known encrypted modes remain sticky, even if the server lies. Saving
      // under the current slug also follows a renamed workspace.
      if (!retainWorkspaceModeProof(localStorage, accountId!, workspaceSlug, descriptor)) {
        console.warn('RuntimeProvider: verified workspace admission could not be cached');
      }
      // This window's own writes raise no storage event. Re-read so a later
      // restart sees learned encryption instead of opening provisionally again.
      setModeStorageRevision((value) => value + 1);
      setContentMode({
        accountId,
        workspaceSlug,
        workspaceId: effectiveWorkspaceId,
        descriptor,
      });
      if (!isEncryptedDescriptor(descriptor)) {
        const recovering = admissionFailed;
        if (recovering && !modeVerification) plaintextAdmission = newAdmission();
        admissionFailed = false;
        verifiedOrdinary = true;
        plaintextAdmission.resolve();
        if (recovering && workspaceRuntime && tokenRef.current)
          void workspaceRuntime.setAuthToken(tokenRef.current).catch((error: unknown) => {
            logRuntimeOperationError('resume remote sync after content admission', error);
          });
      }
    };

    const verifyInBackground = (): Promise<void> => {
      if (modeVerification) return modeVerification;
      if (admissionFailed) {
        plaintextAdmission = newAdmission();
      }
      const pending = (async () => {
        let notPlaintext = false;
        try {
          const descriptor = await describeAuthenticatedWorkspace(
            {
              session: platform.identity.session,
              workspaces: platform.e2eeWorkspaces!,
              accountId: accountId!,
              workspaceId: effectiveWorkspaceId,
              signal: initializationAbort.signal,
            },
            null
          );
          if (disposed) return;
          if (descriptor.workspaceId !== effectiveWorkspaceId)
            throw new WorkspaceModeMismatchError();
          if (isEncryptedDescriptor(descriptor)) {
            // Never keep the plaintext data plane for an encrypted workspace:
            // retire it first, then record the mode synchronously as sticky
            // evidence, so any re-initialization waits for admission.
            notPlaintext = true;
            retire();
          }
          admit(descriptor);
        } catch (error) {
          if (disposed) return;
          if (!notPlaintext && !isWorkspaceModeRejection(error)) {
            // Unclassified failures are not evidence of encryption; keep the
            // ordinary Repo. A later send or online edge may verify again.
            logRuntimeOperationError('background workspace mode verification', error);
            if (!verifiedOrdinary) {
              admissionFailed = true;
              modeVerification = null;
              plaintextAdmission.reject(error);
            }
            return;
          }
          logRuntimeOperationError('background workspace mode verification', error);
          retire();
          // The server did not admit this workspace as plaintext (or its encrypted
          // mode could not be recorded). Every later attempt, including Retry, must
          // wait for authoritative admission instead of opening provisionally.
          if (
            !recordWorkspaceModeRejection(
              localStorage,
              accountId!,
              effectiveWorkspaceId,
              describeErrorType(error)
            )
          )
            sessionModeRejectionsRef.current.add(JSON.stringify([accountId, effectiveWorkspaceId]));
          setContentMode(null);
          setRuntimeInitFailure(modeAdmissionFailure(error));
          setControlConnectionState('error');
          setModeStorageRevision((value) => value + 1);
        }
      })();
      modeVerification = pending;
      const settled = () => {
        if (modeVerification === pending) modeVerification = null;
      };
      void pending.then(settled, settled);
      return pending;
    };

    const retryContentAdmission = () => {
      if (!modeCloud || !accountId || disposed || retired || verifiedOrdinary) return;
      void waitForContentAdmission(initializationAbort.signal).catch(() => {});
    };
    window.addEventListener('online', retryContentAdmission);

    const retire = () => {
      if (retired) return;
      retired = true;
      initializationAbort.abort(new Error('Runtime disposed'));
      setRuntime(null);
      setRuntimeInitializing(false);
      clearDocMetaCache();
      clearPresenceStates();
      previousShutdown.current =
        previousRetirement && !nativeLease && !workspaceRuntime && !encryptedAccess
          ? previousRetirement
          : disposeRuntime;
      void previousShutdown.current().catch((error: unknown) => {
        logRuntimeOperationError('retire provisional runtime', error);
      });
    };

    const initialization = (async () => {
      let admitting = false;
      try {
        await previousRetirement?.();
        previousRetirement = undefined;
        if (disposed) return;
        if (modeCloud && requiresAdmission) {
          // Neither a cached organization nor a developer preference authorizes
          // opening the plaintext data plane of a workspace with encrypted
          // evidence. Resolve the persisted mode first.
          admitting = true;
          const descriptor =
            storedDescriptor ??
            (await describeAuthenticatedWorkspace({
              session: platform.identity.session,
              workspaces: platform.e2eeWorkspaces!,
              accountId: accountId!,
              workspaceId: effectiveWorkspaceId,
              signal: initializationAbort.signal,
            }));
          if (disposed) return;
          admit(descriptor);
          admitting = false;
          if (isEncryptedDescriptor(descriptor)) {
            const native = encryptedRuntime;
            if (!native) {
              setRuntime(null);
              setRuntimeInitializing(false);
              clearDocMetaCache();
              clearPresenceStates();
              return;
            }
            // A cold removal cannot export a native identity. Only a public locator
            // saved before this host's earlier content open may select old databases.
            const retained = readEncryptedLocalIdentity(accountId!, effectiveWorkspaceId);
            if (retained?.genesisHash === descriptor.genesisHash)
              removalScope = { ...retained, windowId: desktopWindowId() };
            const requestedReader =
              native.readerLeases === 'preallocated-v1' ? crypto.randomUUID() : undefined;
            if (requestedReader) {
              nativeLease = effectiveWorkspaceId;
              nativeReaderOwner = requestedReader;
            }
            const status = await native.open(
              effectiveWorkspaceId,
              undefined,
              accountId!,
              requestedReader
            );
            nativeLease = effectiveWorkspaceId;
            if (requestedReader && status.readerOwner !== requestedReader)
              throw new Error('e2ee_reader_owner_mismatch');
            nativeReaderOwner = status.readerOwner;
            if (disposed || retired) return;
            nativeHasUsableKey = status.hasCurrentKey || status.writeEpoch != null;
            if (status.genesisHash !== descriptor.genesisHash)
              throw new WorkspaceModeMismatchError();
            localIdentity = {
              accountId: accountId!,
              workspaceId: effectiveWorkspaceId,
              genesisHash: status.genesisHash,
              signingPublicKey: status.signingPublicKey ?? '',
            };
            // Missing identity or failed durable locator storage stops before any
            // encrypted content opens. Never fall back to a workspace-only cache.
            retainEncryptedLocalIdentity(localIdentity);
            removalScope = { ...localIdentity, windowId: desktopWindowId() };
            await resumeEncryptedWorkspaceCleanup(removalScope);
            void retryRetiredEncryptedWorkspaceCleanup(removalScope).catch((error) => {
              logRuntimeOperationError('retired encrypted workspace cleanup', error);
            });
            refreshNative();
            if (!status.hasCurrentKey && status.writeEpoch == null) {
              setRuntime(null);
              setRuntimeInitializing(false);
              clearDocMetaCache();
              clearPresenceStates();
              return;
            }
            encryptedAccess = createE2eeContent({
              runtime: native,
              workspaceId: effectiveWorkspaceId,
              genesisHash: descriptor.genesisHash,
              epoch: status.writeEpoch ?? status.epoch,
              rotationRequired: status.rotationRequired,
              onKeyUpdateRequired: () => setKeyUpdateWorkspace(effectiveWorkspaceId),
              onMemberRemoved: handleMemberRemoval,
              onSnapshotRecoveryChange: (pending) => {
                if (!disposed && !retired)
                  setSnapshotRecoveryWorkspace(pending ? effectiveWorkspaceId : null);
              },
              authToken: () => tokenRef.current,
            });
            encryptedAccess.updateStatus(status);
          }
        } else if (modeCloud && storedDescriptor) {
          admitting = true;
          admit(storedDescriptor);
          admitting = false;
        } else if (modeCloud && accountId) {
          void verifyInBackground();
        }
        // If the user requested a cache clear before the last reload, delete all
        // lody* IndexedDB + Cache Storage now — before the runtime opens the repo
        // DB, while nothing holds those databases open. No-op on normal boots.
        await maybeClearLodyCacheOnBoot([
          `lody-loro-repo-db-${effectiveWorkspaceId}`,
          `lody-loro-stream-cursors-${effectiveWorkspaceId}`,
        ]);
        if (disposed || retired) {
          return;
        }
        const eagerSyncSurface = resolveRuntimeEagerSyncSurface();
        console.info('RuntimeProvider: creating workspace runtime', {
          workspaceSlug,
          workspaceId: effectiveWorkspaceId,
          workspaceIdSource,
          eagerSyncSurface,
        });
        workspaceRuntime = await createWorkspaceRuntime({
          content: encryptedAccess?.content ?? { mode: 'plaintext' },
          ...(!isLocalPlatform && !encryptedAccess && !storedDescriptor
            ? { waitForContentAdmission }
            : {}),
          ...(encryptedAccess
            ? { e2ee: encryptedAccess.e2ee, e2eeLocalIdentity: localIdentity }
            : {}),
          signal: initializationAbort.signal,
          accountId,
          workspaceSlug,
          workspaceId: effectiveWorkspaceId,
          apiBaseUrl: API_BASE_URL,
          eagerSyncSurface,
          // Platform assembly is the only authority for room topology. Do not
          // re-probe Electron or cloud configuration inside the runtime.
          syncMode: encryptedAccess ? 'cloud' : platform.sync.mode,
          getAuthorizedMachineIds: () => {
            const snapshot = authorizedMachineIdsRef.current;
            return snapshot?.workspaceId === effectiveWorkspaceId ? snapshot.machineIds : null;
          },
          readDocMetaCache: (repo) => readReadyDocMetaCache(store, repo),
          ...(telemetryEnabled
            ? {
                onAnalyticsEvent: (event: {
                  name: string;
                  properties?: Record<string, unknown>;
                }) => {
                  capturePostHogEvent(postHogRef.current, event.name, event.properties);
                },
              }
            : {}),
          onControlConnectionStateChange: (state) => {
            if (disposed || retired) {
              return;
            }
            if (state === 'idle' || state === 'connecting' || state === 'syncing') {
              setControlConnectionState(state);
              return;
            }
            if (state === 'online') {
              setControlConnectionState('online');
              setRuntimeInitializing(false);
              return;
            }
            setControlConnectionState(state);
            setRuntimeInitializing(false);
          },
          onPresenceSnapshot: (states) => {
            if (disposed || retired) {
              return;
            }
            setPresenceStates(states);
          },
          onPresenceSyncStateChange: (state) => {
            if (disposed || retired) {
              return;
            }
            setPresenceSyncState(state);
          },
        });
        if (encryptedAccess) refreshNative();
        if (disposed || retired) {
          // The owner's cleanup or the retirement chain disposes it once.
          return;
        }
        setRuntime(workspaceRuntime);
        // Local runtime (IndexedDB-backed Loro repo) is ready — unblock UI
        // rendering immediately. WebSocket sync state is tracked separately
        // via lodyControlConnectionStateAtom.
        setRuntimeInitializing(false);
        const initialAuthToken = tokenRef.current;
        if (initialAuthToken) {
          void workspaceRuntime.setAuthToken(initialAuthToken).catch((error: unknown) => {
            logRuntimeOperationError('start remote sync after local repo ready', error);
          });
        }
        console.info('RuntimeProvider: workspace runtime local repo ready', {
          workspaceSlug,
          workspaceId: effectiveWorkspaceId,
          workspaceIdSource,
        });
      } catch (error) {
        logRuntimeOperationError('runtime initialization', error);
        if (disposed || retired) {
          return;
        }
        setRuntime(null);
        if (isE2eeMemberRemoved(error)) {
          handleMemberRemoval();
          return;
        }
        if (admitting) {
          // Only a failed admission withdraws the mode; an ordinary runtime
          // failure keeps the pre-E2EE workspace failure presentation.
          setContentMode(null);
          setRuntimeInitFailure(modeAdmissionFailure(error));
        } else {
          setRuntimeInitFailure({ workspaceSlug, errorType: describeErrorType(error) });
        }
        setControlConnectionState('error');
        setRuntimeInitializing(false);
      }
    })();

    return () => {
      console.info('RuntimeProvider: cleanup runtime', {
        workspaceSlug,
      });
      disposed = true;
      window.removeEventListener('online', retryContentAdmission);
      window.removeEventListener('online', refreshNative);
      unsubscribeLedgerChange();
      initializationAbort.abort();
      setRuntime(null);
      setControlConnectionState('idle');
      // Reset to true for next initialization cycle
      setRuntimeInitializing(true);
      clearDocMetaCache();
      clearPresenceStates();
      previousShutdown.current =
        previousRetirement && !nativeLease && !workspaceRuntime && !encryptedAccess
          ? previousRetirement
          : disposeRuntime;
      void previousShutdown.current().catch((error: unknown) => {
        logRuntimeOperationError('cleanup dispose', error);
      });
    };
  }, [
    accountId,
    clearDocMetaCache,
    clearPresenceStates,
    isLocalPlatform,
    modeCloud,
    platform.sync.mode,
    platform.e2eeWorkspaces,
    platform.identity.session,
    setContentMode,
    savedModeErrorType,
    requiresAdmission,
    setControlConnectionState,
    setRuntimeInitializing,
    setRuntime,
    setRuntimeInitFailure,
    setPresenceStates,
    setPresenceSyncState,
    store,
    telemetryEnabled,
    workspaceSlug,
    effectiveWorkspaceId,
    localAgentRuntimeReady,
    admissionRetry,
    retryAdmission,
  ]);

  useEffect(() => {
    if (!runtime) {
      setControlConnectionState('idle');
      return;
    }
    if (runtime.accountId !== accountId) return;
    if (!token) {
      setControlConnectionState('idle');
      void runtime.setAuthToken(null).catch((error: unknown) => {
        logRuntimeOperationError('clear auth token', error);
      });
      return;
    }
    void runtime.setAuthToken(token).catch((error: unknown) => {
      logRuntimeOperationError('set auth token', error);
    });
  }, [accountId, runtime, setControlConnectionState, token]);

  useEffect(() => {
    if (!runtime || !localProbeAttempted) {
      return;
    }
    runtime.setLocalMachineId((localProbeResult?.machineId ?? null) as MachineId | null);
  }, [localProbeAttempted, localProbeResult?.machineId, runtime]);

  // Listen for browser online/offline events and update the browserOnlineAtom
  useEffect(() => {
    const handleOnline = () => setBrowserOnline(true);
    const handleOffline = () => setBrowserOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [setBrowserOnline]);

  return (
    <>
      {keyUpdateWorkspace === runtime?.workspaceId && (
        <div role="status">
          {t('e2ee.content.keyUpdateRequired')}{' '}
          <button type="button" onClick={() => retryKeyUpdateRef.current()}>
            {t('e2ee.content.retryKeyUpdate')}
          </button>
        </div>
      )}
      {snapshotRecoveryWorkspace !== null &&
        (snapshotRecoveryWorkspace === runtime?.workspaceId ||
          snapshotRecoveryWorkspace === workspaceId) && (
          <div role="status">{t('e2ee.content.snapshotRecoveryPending')}</div>
        )}
      {children}
      <SessionPendingSendsHost runtime={runtime} />
    </>
  );
}
