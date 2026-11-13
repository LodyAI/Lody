import { E2eeAutomaticPairingPage } from '@/components/pages/e2ee-automatic-pairing';
import {
  E2eeRemoteMachineDisclosure,
  E2eeRemoteMachinePairing,
} from '@/components/pages/e2ee-remote-machine-pairing';
import { E2eeAddDeviceCard } from '@/components/pages/e2ee-instant-qr';
import { E2eeIdentityRecovery } from '@/components/pages/e2ee-identity-recovery';

import { E2eeTeamSettingsHost } from '@/components/settings/e2ee-team-settings';
import { desktopWindowId } from '@/lib/desktop-window';
import { createWorkspaceRuntimeRetirements } from '../../providers/workspace-runtime-retirements';
import { readEncryptedLocalIdentity, type E2eeLocalDataScope } from '@/lib/e2ee-local-data';
import {
  e2eeAccessLoss,
  isE2eeMemberRemoved,
  retainEncryptedWorkspaceCleanup,
  resumeEncryptedWorkspaceCleanup,
} from '@/lib/e2ee-member-removal';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { useSetAtom } from 'jotai';
import { useRecoveryPort } from '@/components/settings/e2ee/recovery-port';
import { E2eeLostAccessEntry, type E2eeLostAccessProps } from './e2ee-lost-access';
import type { E2eeWorkspaceRemoval } from './e2ee-workspace-removal';
import { useTranslation } from 'react-i18next';
import { usePlatform, usePlatformSession, usePlatformWorkspaces } from '@lody/platform/react';
import type { E2eeRuntimeStatus } from '@lody/platform';
import { getPreferredOrdinaryWorkspaceSlug, readPreferredWorkspaceSlug } from '@/lib/workspace';
import type { WorkspaceModeDescriptor } from '@lody/cloud-api';
import { setWorkspaceContextAtom } from '@/atoms';
import { runtimeInitializingAtom } from '@/atoms/control-connection';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import { E2eePersonalPairing } from '@/components/pages/e2ee-personal-pairing';
import {
  E2eeAccountPairingKeyRetry,
  E2eeAccountPairingRequest,
} from '@/components/pages/e2ee-account-pairing';
import { isElectronRenderer } from '@/lib/electron';
import { isNativeAppShell } from '@/lib/native-platform';
import { E2eeDeviceApprovalGuide } from '@/components/pages/e2ee-device-approval-guide';
import { E2eeLedgerAudit } from '@/components/pages/e2ee-ledger-audit';
import {
  E2eeWorkspaceControlPage,
  type E2eeMemberProfile,
} from '@/components/pages/e2ee-workspace-control-page';
import { E2eeConsoleSection, type E2eeConsoleTab } from '@/components/pages/e2ee-console-section';
import {
  appendLedgerHistory,
  hostLedgerHistory,
  type VerifiedLedgerHistory,
} from '@/lib/e2ee-ledger-history';
import {
  readE2eeGenesisPin,
  readWorkspaceModeEvidence,
  recoverE2eeWorkspaceIdentity,
  repairUnreadableE2eeCaches,
  resetObservedLedgerProgress,
  retainEncryptedWorkspaceMode,
  readObservedLedgerCheckpoint,
  retainObservedLedgerCheckpoint,
} from '@/lib/e2ee-workspace-storage';
import {
  classifyE2eeControlFailure,
  personalHostFailureCode,
  e2eeControlDiagnostics,
  type E2eeControlFailure,
} from '@/lib/e2ee-control-failure';

// Retain actual incomplete reader owners across control-page unmounts.
const retiredReaders = createWorkspaceRuntimeRetirements();

// Account-pairing joins by account and workspace, across control-page remounts, so a
// remount neither forgets the join nor asks the host for keys again. A failed key
// request waits for the user's retry. Cleared when the account changes.
type AccountPairingJoin = {
  request?: Promise<boolean>;
  failed?: boolean;
  automatic?: boolean;
  cancel?: () => void;
};
const ACCOUNT_PAIRING_KEY_RETRY_MS = [300, 600, 1200, 2000, 3000, 4000] as const;
const accountPairingJoins = new Map<string, AccountPairingJoin>();
let accountPairingAccount: string | null | undefined;

export interface E2eeWorkspaceConsoleProps {
  workspaceId: string;
  /** `page`: the standalone route, outside any open workspace. `modal`: opened from
   * Settings over the running workspace; it keeps the workspace context and closes
   * instead of navigating away. Both own exactly one control reader. */
  presentation: 'page' | 'modal';
  /** Leaves the modal; the page returns to an ordinary workspace instead. */
  onClose?: () => void;
  initialTab?: E2eeConsoleTab;
  /** Opened through "Add device": the Devices tab shows its pairing code at once. */
  showPairingCode?: boolean;
  /** Host-owned content for console tabs, wrapped in `E2eeConsoleSection`. */
  sections?: ReactNode;
  /** Host app-update check, shown on failures that an update resolves. */
  onCheckForUpdates?: () => void;
  /** Host-known recovery state for the getting-started list; see the control page. */
  recoveryReady?: boolean;
  /** Ordinary account deletion/leave for a device with no approval; absent when the
   * host has no account workspaces. The server decides who may use either. */
  workspaceRemoval?: E2eeWorkspaceRemoval;
}

/** The encryption console. It owns its account/workspace control reader and the
 * retirement rules recorded in `routes/workspace/e2ee/AGENTS.md` in either presentation. */
export function E2eeWorkspaceConsole({
  workspaceId,
  presentation,
  onClose,
  initialTab,
  showPairingCode,
  sections,
  onCheckForUpdates,
  recoveryReady,
  workspaceRemoval,
}: E2eeWorkspaceConsoleProps) {
  const platform = usePlatform();
  const { t } = useTranslation();
  const session = usePlatformSession();
  const workspaces = usePlatformWorkspaces();
  const accountId = useE2eeAccountId();
  const port = platform.e2eeWorkspaces;
  const navigate = useNavigate();
  const clearWorkspace = useSetAtom(setWorkspaceContextAtom);
  const setRuntimeInitializing = useSetAtom(runtimeInitializingAtom);
  // Restoring from a backup uses this host's recovery port (desktop main, Web or the
  // mobile webview) while the recovery switch is on.
  const recoveryPort = useRecoveryPort();
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  useEffect(() => {
    setPasskeyAvailable(false);
    if (!recoveryPort) return undefined;
    let live = true;
    void recoveryPort.passkeyAvailable().then(
      (available) => {
        if (live) setPasskeyAvailable(available);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [recoveryPort]);
  useLayoutEffect(() => {
    // The standalone page has no workspace; the modal stays inside the open one.
    if (presentation === 'page') clearWorkspace({ slug: null, workspaceId: null });
  }, [clearWorkspace, presentation]);
  const [generation, setGeneration] = useState(0);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  // The joining device starts on the approval guide; details reveal the full ledger page.
  const [showDetails, setShowDetails] = useState(false);
  // The person chose code pairing over the automatic request; scoped to one workspace.
  const [manualPairingFor, setManualPairingFor] = useState<string | null>(null);
  // A revoked identity is reopened once without it; a second refusal is final.
  const revokedRetry = useRef<string | null>(null);
  useEffect(() => {
    const reconnect = () => setGeneration((value) => value + 1);
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, []);
  const identity = JSON.stringify([accountId, workspaceId]);
  const scope = JSON.stringify([accountId, workspaceId, generation]);
  const manualPairing = manualPairingFor === identity;
  const scopeRef = useRef(scope);
  const readOwner = useRef<{ publish?: () => Promise<void> } | null>(null);
  scopeRef.current = scope;
  const [state, setState] = useState<{
    scope: string;
    identity: string;
    descriptor: Extract<WorkspaceModeDescriptor, { contentMode: 'e2ee' }> | null;
    history: VerifiedLedgerHistory | null;
    loading: boolean;
    failure: E2eeControlFailure | null;
    custodyFailure?: string;
    offline?: boolean;
    removed?: boolean;
    nativeStatus?: E2eeRuntimeStatus;
  }>({ scope, identity, descriptor: null, history: null, loading: true, failure: null });
  useEffect(() => {
    let disposed = false;
    let unsubscribeLedger: (() => void) | undefined;
    let hostAccessStarted = false;
    let hostOpened = false;
    let nativeAcquisition: Promise<E2eeRuntimeStatus | undefined> | undefined;
    let readerOwner: string | undefined;
    let readerPreallocated = false;
    let readerGenesis: string | undefined;
    let cleanup: E2eeLocalDataScope | null = null;
    let nativeFailure: E2eeControlFailure | null = null;
    const retirement = retiredReaders.create(
      () => ({
        native:
          hostAccessStarted && accountId
            ? { accountId, workspaceId, genesisHash: readerGenesis }
            : undefined,
      }),
      async () => {
        // Fence a preallocated cold open before joining its actual settlement.
        if (hostOpened) {
          await port!.runtime!.close(workspaceId, accountId!, readerOwner);
          // A legacy host counts every settled open once per window; closing it
          // again would release another reader of this window and workspace.
          if (!readerPreallocated) hostOpened = false;
        }
        // Join only actual native acquisition. Public describe/history can stay
        // offline after this reader is confirmed closed; they own no host lease.
        await nativeAcquisition?.then(
          () => undefined,
          () => undefined
        );
        if (hostOpened) await port!.runtime!.close(workspaceId, accountId!, readerOwner);
        hostOpened = false;
      }
    );
    const closeHost = () => retiredReaders.retire(retirement);
    // Keep the full failure in its retirement owner, never serialize its opaque
    // custody/cleanup cause into browser diagnostics.
    const reportClose = () => console.error('E2EE control reader close incomplete');
    setState((previous) =>
      previous.identity === identity
        ? { ...previous, scope, loading: Boolean(port && accountId), failure: null }
        : {
            scope,
            identity,
            descriptor: null,
            history: null,
            loading: Boolean(port && accountId),
            failure: null,
          }
    );
    if (!port || !accountId) return undefined;
    const owner: NonNullable<typeof readOwner.current> = {};
    readOwner.current = owner;
    const isCurrent = () => !disposed && scopeRef.current === scope && readOwner.current === owner;
    void (async () => {
      try {
        const retained = readEncryptedLocalIdentity(accountId, workspaceId);
        if (retained) cleanup = { ...retained, windowId: desktopWindowId() };
        if (port.runtime) {
          const runtime = port.runtime;
          try {
            readWorkspaceModeEvidence(localStorage, accountId, workspaceId);
          } catch {
            await recoverE2eeWorkspaceIdentity({
              storage: localStorage,
              accountId,
              workspaceId,
              runtime,
              isCurrent: () => !disposed && scopeRef.current === scope,
            });
          }
          const pin = readE2eeGenesisPin(localStorage, accountId, workspaceId);
          readerGenesis = pin ?? undefined;
          await retiredReaders.drain({
            native: { accountId, workspaceId, genesisHash: readerGenesis },
          });
          if (disposed) return;
          hostAccessStarted = true;
          let status;
          try {
            nativeAcquisition = (async () => {
              if (pin) {
                try {
                  await runtime.recordCreated({ workspaceId, genesisHash: pin });
                } catch (error) {
                  // Portable read-open does not implement desktop creation repair.
                  // All binding/custody failures still stop this read.
                  if (personalHostFailureCode(error) !== 'unsupported') throw error;
                }
              }
              if (disposed) return undefined;
              readerOwner =
                runtime.readerLeases === 'preallocated-v1' ? crypto.randomUUID() : undefined;
              if (readerOwner) hostOpened = readerPreallocated = true;
              const opened = await runtime.open(
                workspaceId,
                readObservedLedgerCheckpoint(localStorage, accountId, workspaceId) ?? undefined,
                accountId,
                readerOwner
              );
              hostOpened = true;
              if (readerOwner && opened.readerOwner !== readerOwner)
                throw new Error('e2ee_reader_owner_mismatch');
              readerOwner = opened.readerOwner;
              readerGenesis = opened.genesisHash;
              return opened;
            })();
            status = await nativeAcquisition;
          } catch (error) {
            // Availability failures retain the original read-only verification path,
            // including its genesis pin and observed-checkpoint checks.
            if (
              classifyE2eeControlFailure(error).kind !== 'approval-required' &&
              (!(error instanceof Error) ||
                !/\be2ee_(?:missing-binding|custody_unavailable|account_unavailable|closed)\b/.test(
                  error.message
                ))
            )
              throw error;
            nativeFailure = classifyE2eeControlFailure(error);
            // Render automatic pairing / QR scan immediately instead of blocking on
            // public describe + history; those still finish below to verify continuity.
            if (
              !disposed &&
              nativeFailure.kind === 'approval-required' &&
              runtime.startAutomaticPairing &&
              (!pin || nativeFailure.code === 'device-revoked')
            ) {
              setState((previous) =>
                previous.scope === scope
                  ? { ...previous, loading: false, failure: nativeFailure }
                  : previous
              );
            }
          }
          if (status) {
            if (disposed) {
              return;
            }
            const descriptor = {
              workspaceId,
              contentMode: 'e2ee' as const,
              contentModeVersion: 1 as const,
              activation: 'control-only' as const,
              genesisHash: status.genesisHash,
              cryptoOrgId: status.genesisHash,
            };
            retainEncryptedWorkspaceMode(localStorage, accountId, descriptor);
            let publication = 0;
            let published = status;
            const publish = async () => {
              if (!isCurrent()) return;
              const revision = ++publication;
              const exported = await runtime.ledgerView(workspaceId);
              if (!isCurrent() || revision !== publication) return;
              let history: VerifiedLedgerHistory;
              try {
                history = hostLedgerHistory(exported);
                if (!history.continuityPending)
                  retainObservedLedgerCheckpoint(localStorage, accountId, workspaceId, history);
              } catch (error) {
                // Decode/verification errors are not a failed notification channel.
                setState((previous) =>
                  previous.scope !== scope
                    ? previous
                    : {
                        ...previous,
                        loading: false,
                        failure: classifyE2eeControlFailure(error),
                        nativeStatus: undefined,
                      }
                );
                throw error;
              }
              published = exported.status;
              if (!disposed)
                setState({
                  scope,
                  identity,
                  descriptor,
                  history,
                  nativeStatus: exported.status,
                  loading: false,
                  failure: null,
                });
            };
            owner.publish = publish;
            await publish();
            const synchronize = async () => {
              if (!isCurrent()) return;
              const local = await runtime.ledgerView(workspaceId);
              if (!isCurrent()) return;
              let page = await port.history({
                workspaceId,
                ...(local.status.position ? { after: local.status.position } : {}),
              });
              for (;;) {
                if (!isCurrent()) return;
                const next = await runtime.ingestLedgerRecords(workspaceId, page);
                if (!isCurrent()) return;
                if (page.nextCursor === null || next.upgradeRequiredAt !== undefined) {
                  await publish();
                  return;
                }
                page = await port.history({
                  workspaceId,
                  cursor: page.nextCursor,
                  checkpoint: page.checkpoint,
                });
              }
            };
            // A saved local view is visible before the first network request.
            try {
              const remote = await port.describe({ workspaceId });
              if (disposed) return;
              if (
                !('contentMode' in remote) ||
                remote.contentMode !== 'e2ee' ||
                remote.genesisHash !== status.genesisHash
              )
                throw new Error('e2ee_genesis_conflict');
              retainEncryptedWorkspaceMode(localStorage, accountId, remote);
              await synchronize();
            } catch (error) {
              // The account-facing directory/history can only report a generic
              // denial. Native refresh checks the retained device credential;
              // only its exact whole-member result authorizes local erasure.
              if (!disposed) {
                try {
                  await runtime.refresh(workspaceId, { installKeys: false });
                } catch (checked) {
                  if (e2eeAccessLoss(checked)) throw checked;
                }
              }
              if (classifyE2eeControlFailure(error).kind !== 'network') throw error;
              // A disconnected refresh does not invalidate a verified local view.
              // Reconnection or the existing Refresh action retries the same suffix.
              if (!disposed)
                setState((previous) =>
                  previous.scope === scope ? { ...previous, offline: true } : previous
                );
            }
            // The first subscription value closes the gap after initial catch-up.
            // Only original, verified history advances the local checkpoint.
            let running = false;
            let pending = false;
            const subscriptionFailed = () => {
              if (isCurrent()) console.warn('E2EE ledger live updates unavailable');
            };
            if (isCurrent() && port.subscribeLedgerHead) {
              try {
                unsubscribeLedger = port.subscribeLedgerHead(
                  { workspaceId },
                  (head) => {
                    if (
                      !isCurrent() ||
                      head.workspaceId !== workspaceId ||
                      (head.genesisHash === published.genesisHash &&
                        head.checkpoint.length === published.length &&
                        head.checkpoint.headHash === published.headHash)
                    )
                      return;
                    pending = true;
                    if (running) return;
                    running = true;
                    void (async () => {
                      try {
                        while (pending && isCurrent()) {
                          pending = false;
                          await synchronize();
                          if (isCurrent()) setDirectoryRevision((value) => value + 1);
                        }
                      } catch (error) {
                        if (!isCurrent()) return;
                        const failure = classifyE2eeControlFailure(error);
                        setState((previous) =>
                          previous.scope !== scope
                            ? previous
                            : failure.kind === 'network'
                              ? { ...previous, offline: true }
                              : { ...previous, failure, nativeStatus: undefined }
                        );
                      } finally {
                        running = false;
                      }
                    })();
                  },
                  subscriptionFailed
                );
              } catch {
                subscriptionFailed();
              }
            }
            return;
          }
        }
        const descriptor = await port.describe({ workspaceId });
        if (disposed) return;
        if (
          descriptor.workspaceId !== workspaceId ||
          !('contentMode' in descriptor) ||
          descriptor.contentMode !== 'e2ee' ||
          descriptor.contentModeVersion !== 1
        )
          throw new Error('Not an encrypted workspace');
        retainEncryptedWorkspaceMode(localStorage, accountId, descriptor);
        const page = await port.history({ workspaceId });
        if (disposed) return;
        const history = appendLedgerHistory(null, page, {
          workspaceId,
          genesisHash: descriptor.genesisHash,
          localPin: readE2eeGenesisPin(localStorage, accountId, workspaceId),
          observed: readObservedLedgerCheckpoint(localStorage, accountId, workspaceId),
        });
        history.continuityPending = !retainObservedLedgerCheckpoint(
          localStorage,
          accountId,
          workspaceId,
          history
        );
        revokedRetry.current = null;
        setState({
          scope,
          identity,
          descriptor,
          history,
          loading: false,
          failure: nativeFailure?.kind === 'approval-required' ? nativeFailure : null,
          custodyFailure: nativeFailure?.kind === 'local-identity' ? nativeFailure.code : undefined,
        });
      } catch (error) {
        if (!disposed && e2eeAccessLoss(error)) {
          try {
            if (cleanup) retainEncryptedWorkspaceCleanup(cleanup);
          } catch {
            /* Native receipt still retries local cleanup on the next open. */
          }
          try {
            // Unmount joins this same retirement instead of releasing the reader again.
            if (hostOpened) await closeHost();
          } catch (closeError) {
            // The retained retirement keeps the full reader owner and never erases
            // borrowed stores before the actual host close can finish.
            setState((previous) =>
              previous.scope === scope
                ? { ...previous, loading: false, failure: classifyE2eeControlFailure(closeError) }
                : previous
            );
            return;
          }
          if (cleanup) await resumeEncryptedWorkspaceCleanup(cleanup, true).catch(() => undefined);
          // A revoked device keeps its membership: reopen without this identity,
          // which lands in the existing re-pairing guidance instead of removal.
          if (!isE2eeMemberRemoved(error)) {
            if (disposed) return;
            if (revokedRetry.current !== identity) {
              revokedRetry.current = identity;
              setGeneration((value) => value + 1);
              return;
            }
            // A host that keeps refusing the revoked identity stops here and offers
            // re-pairing instead of reopening in a loop.
            setState((previous) =>
              previous.scope === scope
                ? {
                    ...previous,
                    history: null,
                    loading: false,
                    failure: { kind: 'approval-required', code: 'device-revoked' },
                  }
                : previous
            );
            return;
          }
          if (!disposed)
            setState((previous) =>
              previous.scope === scope
                ? { ...previous, history: null, loading: false, failure: null, removed: true }
                : previous
            );
          return;
        }
        if (!disposed)
          setState((previous) =>
            previous.scope === scope
              ? { ...previous, loading: false, failure: classifyE2eeControlFailure(error) }
              : previous
          );
      }
    })();
    return () => {
      disposed = true;
      try {
        unsubscribeLedger?.();
      } catch {
        console.warn('E2EE ledger subscription cleanup incomplete');
      }
      if (hostAccessStarted) void closeHost().catch(reportClose);
      if (readOwner.current === owner) readOwner.current = null;
    };
  }, [scope, identity, port, workspaceId, accountId]);
  // Directory availability never delays or invalidates verified ledger history.
  const [directory, setDirectory] = useState<{
    scope: string;
    profiles: ReadonlyMap<string, E2eeMemberProfile>;
  } | null>(null);
  const authenticated = session.status === 'authenticated' && session.user.id === accountId;
  useEffect(() => {
    let disposed = false;
    setDirectory(null);
    if (!authenticated || !port?.memberProfiles) return undefined;
    void port.memberProfiles({ workspaceId }).then(
      (result) => {
        if (disposed || result.workspaceId !== workspaceId) return;
        const profiles = new Map<string, E2eeMemberProfile>();
        for (const profile of result.profiles) {
          if (typeof profile.name === 'string' && profile.name.trim() !== '')
            profiles.set(profile.cryptoUserId, { name: profile.name, image: profile.image });
        }
        setDirectory({ scope, profiles });
      },
      () => {
        // Labels are optional. Failed directory reads leave verified IDs/ordinals visible.
      }
    );
    return () => {
      disposed = true;
    };
  }, [scope, authenticated, port, workspaceId, directoryRevision]);
  const current = state.identity === identity ? state : null;
  const backToWorkspaces = () => {
    if (onClose) {
      onClose();
      return;
    }
    // Same choice as the create route's back exit: never an encrypted workspace,
    // and never this one even if its display metadata lacks the content mode.
    const others =
      workspaces.status === 'ready'
        ? workspaces.workspaces.filter((item) => item.id !== workspaceId)
        : [];
    const slug = getPreferredOrdinaryWorkspaceSlug(
      workspaces.status === 'ready'
        ? others.find((item) => item.id === workspaces.activeWorkspaceId)
        : null,
      others,
      readPreferredWorkspaceSlug()
    );
    void navigate(
      slug
        ? { to: '/$workspaceName/chat', params: { workspaceName: slug } }
        : { to: '/workspace/create', search: { allowExisting: true } }
    );
  };
  const workspaceSlug =
    workspaces.status === 'ready'
      ? workspaces.workspaces.find((workspace) => workspace.id === workspaceId)?.slug
      : null;
  const canOpen = Boolean(
    workspaceSlug &&
    current?.scope === scope &&
    !current.loading &&
    !current.failure &&
    current.nativeStatus?.workspaceId === workspaceId &&
    current.nativeStatus.deviceKind === 'personal'
  );
  const loadMore = async () => {
    const owner = readOwner.current;
    if (
      !owner ||
      !port ||
      !accountId ||
      !current?.history?.page.nextCursor ||
      current.history.upgradeRequiredAt !== undefined ||
      !current.descriptor ||
      current.loading ||
      current.scope !== scope
    )
      return;
    const previous = current.history;
    setState({ ...current, loading: true, failure: null });
    try {
      const page = await port.history({
        workspaceId,
        cursor: previous.page.nextCursor!,
        checkpoint: previous.page.checkpoint,
      });
      if (scopeRef.current !== scope || readOwner.current !== owner) return;
      const history = appendLedgerHistory(previous, page, {
        workspaceId,
        genesisHash: current.descriptor.genesisHash,
        localPin: readE2eeGenesisPin(localStorage, accountId, workspaceId),
        observed: readObservedLedgerCheckpoint(localStorage, accountId, workspaceId),
      });
      history.continuityPending = !retainObservedLedgerCheckpoint(
        localStorage,
        accountId,
        workspaceId,
        history
      );
      setState({ ...current, history, loading: false, failure: null });
    } catch (error) {
      if (scopeRef.current === scope && readOwner.current === owner)
        setState({ ...current, loading: false, failure: classifyE2eeControlFailure(error) });
    }
  };
  const refresh = () => setGeneration((value) => value + 1);
  // Account-wide pairing advances by itself: once this device joined, it opens the
  // workspace when its credential and the current epoch key are installed. The host
  // records a join even when its best-effort key round failed, so a join without the
  // key asks the host to receive keys once.
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  const observedKeyRequest = useRef<Promise<boolean> | null>(null);
  const observeKeyRequest = (request: Promise<boolean>) => {
    if (observedKeyRequest.current === request) return;
    observedKeyRequest.current = request;
    void request.then((installed) => {
      if (observedKeyRequest.current !== request) return;
      if (installed) refresh();
      else rerender();
    });
  };
  const requestAccountPairingKey = (join: AccountPairingJoin) => {
    const runtime = port?.runtime;
    if (!runtime) return;
    join.cancel?.();
    let cancelled = false;
    let stopSleep: (() => void) | undefined;
    join.cancel = () => {
      cancelled = true;
      stopSleep?.();
    };
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          stopSleep = undefined;
          resolve();
        }, ms);
        stopSleep = () => {
          clearTimeout(timer);
          stopSleep = undefined;
          resolve();
        };
      });
    join.failed = false;
    join.request = (async () => {
      try {
        const first = await runtime.refresh(workspaceId, { installKeys: true });
        if (!first || first.hasCurrentKey) return true;
        // Instant QR approval delivers mailbox keys asynchronously right after
        // publishing the admission. Poll briefly while the mailbox catches up.
        for (const delay of ACCOUNT_PAIRING_KEY_RETRY_MS) {
          await wait(delay);
          if (cancelled || accountPairingJoins.get(identity) !== join) return false;
          const next = await runtime.refresh(workspaceId, { installKeys: true });
          if (!next || next.hasCurrentKey) return true;
        }
        join.failed = true;
        return false;
      } catch (error: unknown) {
        if (cancelled) return false;
        const failure = classifyE2eeControlFailure(error);
        console.error('E2EE account pairing key request failed', failure.kind, failure.code);
        join.failed = true;
        return false;
      }
    })();
    observeKeyRequest(join.request);
  };
  const onAccountPairingJoined = (automatic = false) => {
    if (!accountPairingJoins.has(identity)) accountPairingJoins.set(identity, {});
    if (automatic) accountPairingJoins.get(identity)!.automatic = true;
    refresh();
  };
  const retryAccountPairingKey = () => {
    const join = accountPairingJoins.get(identity);
    if (!join?.failed) return;
    requestAccountPairingKey(join);
    rerender();
  };
  const joinedCredential = canOpen && current?.nativeStatus?.hasDeviceCredential === true;
  const joinedKey = joinedCredential && current?.nativeStatus?.hasCurrentKey === true;
  const accountPairingKeyFailed =
    joinedCredential && !joinedKey && accountPairingJoins.get(identity)?.failed === true;
  useEffect(() => {
    if (accountPairingAccount === accountId) return;
    accountPairingAccount = accountId;
    for (const join of accountPairingJoins.values()) join.cancel?.();
    accountPairingJoins.clear();
  }, [accountId]);
  useEffect(() => {
    const join = accountPairingJoins.get(identity);
    if (!join || !joinedCredential || !workspaceSlug) return;
    if (joinedKey) {
      join.cancel?.();
      accountPairingJoins.delete(identity);
      setRuntimeInitializing(true);
      void navigate({ to: '/$workspaceName/chat', params: { workspaceName: workspaceSlug } });
      return;
    }
    if (!join.request) requestAccountPairingKey(join);
    else observeKeyRequest(join.request);
  }, [identity, joinedCredential, joinedKey, workspaceSlug, navigate, port, workspaceId]);
  const manageMember = async (work?: () => Promise<void>) => {
    const owner = readOwner.current;
    if (!owner?.publish || scopeRef.current !== scope) throw new Error('e2ee_not_open');
    await work?.();
    if (scopeRef.current !== scope || readOwner.current !== owner) return;
    // A management result already advanced the native ledger. Read and verify it
    // on this reader; rebuilding the effect creates an unnecessary no-reader gap.
    setState((previous) => ({ ...previous, loading: true, failure: null }));
    try {
      await owner.publish();
    } catch (error) {
      if (scopeRef.current === scope && readOwner.current === owner)
        setState((previous) => ({
          ...previous,
          loading: false,
          failure: classifyE2eeControlFailure(error),
          nativeStatus: undefined,
        }));
      throw error;
    }
  };
  const diagnostics = () => {
    let localPin: string | null = null;
    let observed: { length: number; headHash: string } | null = null;
    // Diagnostics must still work when the evidence itself is unreadable.
    try {
      localPin = accountId ? readE2eeGenesisPin(localStorage, accountId, workspaceId) : null;
    } catch {
      localPin = 'unreadable';
    }
    try {
      observed = accountId
        ? readObservedLedgerCheckpoint(localStorage, accountId, workspaceId)
        : null;
    } catch {
      observed = null;
    }
    return e2eeControlDiagnostics({
      workspaceId,
      genesisHash: current?.descriptor?.genesisHash,
      localPin,
      observed,
      history: current?.history ?? null,
      failure: current?.failure ?? null,
    });
  };
  if (current?.removed) return <p role="status">{t('e2ee.members.removed')}</p>;
  const listedWorkspace =
    workspaces.status === 'ready'
      ? workspaces.workspaces.find((workspace) => workspace.id === workspaceId)
      : undefined;
  const lostAccess: Omit<E2eeLostAccessProps, 'workspaceId'> = {
    workspaceName: listedWorkspace?.name,
    // Only a hint for which path to offer; the server checks it on submit.
    accountRole: listedWorkspace?.role,
    ...(recoveryPort
      ? {
          recovery: {
            passkeyAvailable,
            restore: recoveryPort.restore,
            onRecovered: refresh,
            onCheck: refresh,
          },
        }
      : {}),
    ...(workspaceRemoval ? { removal: workspaceRemoval } : {}),
    onBackToWorkspaces: backToWorkspaces,
    onRemoved: backToWorkspaces,
  };
  // A signed-in device without an approved identity here sees the next step first;
  // the ledger, diagnostics and failures stay one click away in the full page.
  const awaitingApproval = Boolean(
    port?.runtime &&
    accountId &&
    current?.scope === scope &&
    !current.loading &&
    // Only "this device needs approval" (new, lost or revoked identity); every other
    // failure keeps the full page with its repair actions.
    (!current.failure || current.failure.kind === 'approval-required') &&
    !current.custodyFailure &&
    // A revoked device, including the one that created the workspace, pairs again.
    ((!current.history?.locallyPinned && current.nativeStatus?.deviceKind !== 'personal') ||
      (current.failure?.kind === 'approval-required' && current.failure.code === 'device-revoked'))
  );
  if (
    (awaitingApproval ||
      (accountPairingJoins.get(identity)?.automatic &&
        !joinedKey &&
        !current?.failure &&
        !current?.custodyFailure)) &&
    !showDetails &&
    !manualPairing &&
    port?.runtime?.startAutomaticPairing &&
    accountId
  )
    return (
      <E2eeAutomaticPairingPage
        key={identity}
        runtime={port.runtime}
        workspaceId={workspaceId}
        onJoined={() => onAccountPairingJoined(true)}
        keyFailure={accountPairingKeyFailed}
        onRetryKeys={retryAccountPairingKey}
        onBack={backToWorkspaces}
        onManual={() => setManualPairingFor(identity)}
        lostAccess={lostAccess}
      />
    );
  if (awaitingApproval && !showDetails && port?.runtime && accountId)
    return (
      <E2eeDeviceApprovalGuide
        lostAccess={<E2eeLostAccessEntry {...lostAccess} workspaceId={workspaceId} />}
        reason={current?.failure?.code === 'device-revoked' ? 'revoked' : 'new'}
        onRefresh={refresh}
        onShowDetails={() => setShowDetails(true)}
        onBack={backToWorkspaces}
        {...(manualPairing && port.runtime.startAutomaticPairing
          ? { onAutomatic: () => setManualPairingFor(null) }
          : {})}
      >
        <E2eeAccountPairingRequest
          key={identity + ':account-pairing'}
          runtime={port.runtime}
          workspaceId={workspaceId}
          // Web asks first: a browser is often shared or public.
          autoStart={isElectronRenderer() || isNativeAppShell()}
          onJoined={onAccountPairingJoined}
        />
        <E2eePersonalPairing
          key={identity}
          accountId={accountId}
          workspaceId={workspaceId}
          runtime={port.runtime}
          canApprove={false}
          approved={false}
          onJoined={refresh}
        />
      </E2eeDeviceApprovalGuide>
    );
  return (
    <>
      {current?.offline && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {t('sessions.offline')}
        </p>
      )}
      {accountPairingKeyFailed && <E2eeAccountPairingKeyRetry onRetry={retryAccountPairingKey} />}
      {port?.runtime &&
        (current?.custodyFailure || current?.failure?.kind === 'local-identity') && (
          <E2eeIdentityRecovery
            key={scope}
            workspaceId={workspaceId}
            runtime={port.runtime}
            error={current.custodyFailure ?? current.failure?.code ?? ''}
            onReset={refresh}
          />
        )}
      <E2eeWorkspaceControlPage
        // Tabs and open disclosures belong to one workspace.
        key={identity}
        memberManagement={
          current?.scope === scope &&
          !current.loading &&
          !current.failure &&
          current.nativeStatus?.deviceKind === 'personal' &&
          current.nativeStatus.hasDeviceCredential === true &&
          (current.nativeStatus.memberRole === 'owner' ||
            current.nativeStatus.memberRole === 'admin') &&
          port?.runtime?.removeMember &&
          port.runtime.setMemberRole
            ? {
                actorRole: current.nativeStatus.memberRole,
                remove: (membershipId) =>
                  manageMember(() => port.runtime!.removeMember!(workspaceId, membershipId)),
                setRole: (membershipId, role) =>
                  manageMember(() => port.runtime!.setMemberRole!(workspaceId, membershipId, role)),
                ...(port.runtime.transferOwnership
                  ? {
                      transfer: (membershipId: string) =>
                        manageMember(() =>
                          port.runtime!.transferOwnership!(workspaceId, membershipId)
                        ),
                    }
                  : {}),
                ...(port.runtime.updateKeys
                  ? { rotate: () => manageMember(() => port.runtime!.updateKeys!(workspaceId)) }
                  : {}),
              }
            : undefined
        }
        workspaceId={workspaceId}
        workspaceName={
          workspaces.status === 'ready'
            ? workspaces.workspaces.find((workspace) => workspace.id === workspaceId)?.name
            : undefined
        }
        presentation={presentation}
        initialTab={initialTab}
        {...(onCheckForUpdates ? { onCheckForUpdates } : {})}
        {...(recoveryReady === undefined ? {} : { recoveryReady })}
        memberRole={
          current?.scope === scope && !current.failure
            ? current.nativeStatus?.memberRole
            : undefined
        }
        genesisHash={current?.descriptor?.genesisHash}
        history={current?.history ?? null}
        loading={!current || current.loading || current.scope !== scope}
        failure={current?.failure ?? null}
        unavailable={!port || !accountId}
        memberProfiles={
          authenticated && directory?.scope === scope ? directory.profiles : undefined
        }
        diagnostics={diagnostics}
        onRepairLocal={() => {
          if (!accountId) return;
          repairUnreadableE2eeCaches(localStorage, accountId);
          refresh();
        }}
        onResetProgress={() => {
          if (!accountId) return;
          resetObservedLedgerProgress(localStorage, accountId, workspaceId);
          refresh();
        }}
        onLoadMore={() => {
          void loadMore();
        }}
        onRefresh={refresh}
        onOpen={
          canOpen && presentation === 'page'
            ? () => {
                // Navigation is only an entry point. RuntimeProvider reopens this
                // approved identity and acquires purpose-bound grants before content.
                if (scopeRef.current === scope && readOwner.current && workspaceSlug) {
                  setRuntimeInitializing(true);
                  void navigate({
                    to: '/$workspaceName/chat',
                    params: { workspaceName: workspaceSlug },
                  });
                }
              }
            : undefined
        }
        onBack={backToWorkspaces}
      >
        {port?.runtime && accountId && current?.history?.locallyPinned && (
          <E2eeConsoleSection tab="members">
            <E2eeTeamSettingsHost
              key={identity + ':team'}
              runtime={port.runtime}
              workspaceId={workspaceId}
              accountId={accountId}
              profiles={directory?.scope === scope ? directory.profiles : undefined}
              ledgerVersion={port.subscribeLedgerHead ? current.nativeStatus?.headHash : undefined}
              onMembersChanged={async () => {
                await manageMember();
                if (scopeRef.current === scope) setDirectoryRevision((value) => value + 1);
              }}
            />
          </E2eeConsoleSection>
        )}
        {port?.runtime && accountId && current?.history?.locallyPinned && (
          <E2eeConsoleSection tab="devices">
            <E2eeAddDeviceCard
              key={identity + ':account-pairing'}
              runtime={port.runtime}
              defaultShowQr={showPairingCode === true}
            />
          </E2eeConsoleSection>
        )}
        {/* The per-workspace exchange is only for hosts without account pairing;
            beside it, it would be a second, competing way to add the same device. */}
        {port?.runtime && accountId && !port.runtime.inspectAccountPairing && (
          <E2eeConsoleSection tab="devices">
            <E2eePersonalPairing
              key={identity}
              accountId={accountId}
              workspaceId={workspaceId}
              runtime={port.runtime}
              canApprove={Boolean(current?.history?.locallyPinned)}
              approved={Boolean(
                current?.scope === scope &&
                !current.failure &&
                current.nativeStatus?.deviceKind === 'personal'
              )}
              onJoined={refresh}
            />
          </E2eeConsoleSection>
        )}
        {sections}
        {port?.runtime?.beginRemoteMachinePairing && current?.history?.locallyPinned && (
          <E2eeConsoleSection tab="devices">
            <E2eeRemoteMachineDisclosure key={identity + ':remote-machine-disclosure'}>
              <E2eeRemoteMachinePairing
                key={identity + ':remote-machine'}
                workspaceId={workspaceId}
                runtime={port.runtime}
              />
            </E2eeRemoteMachineDisclosure>
          </E2eeConsoleSection>
        )}
        {port && current?.history?.locallyPinned && (
          <E2eeConsoleSection tab="security">
            <E2eeLedgerAudit
              key={identity + ':audit'}
              workspaceId={workspaceId}
              history={current.history}
              read={port.history}
            />
          </E2eeConsoleSection>
        )}
      </E2eeWorkspaceControlPage>
    </>
  );
}
