import { E2eeRemoteMachinePairing } from '@/components/pages/e2ee-remote-machine-pairing';
import { E2eeIdentityRecovery } from '@/components/pages/e2ee-identity-recovery';
import { desktopWindowId } from '@/lib/desktop-window';
import { readEncryptedLocalIdentity, type E2eeLocalDataScope } from '@/lib/e2ee-local-data';
import {
  isE2eeMemberRemoved,
  retainEncryptedWorkspaceCleanup,
  resumeEncryptedWorkspaceCleanup,
} from '@/lib/e2ee-member-removal';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import type { E2eeRuntimeStatus } from '@lody/platform';
import type { WorkspaceModeDescriptor } from '@lody/cloud-api';
import { setWorkspaceContextAtom } from '@/atoms';
import { useE2eeAccountId } from '@/lib/e2ee-account';
import { E2eePersonalPairing } from '@/components/pages/e2ee-personal-pairing';
import { E2eeLedgerAudit } from '@/components/pages/e2ee-ledger-audit';
import {
  E2eeWorkspaceControlPage,
  type E2eeMemberProfile,
} from '@/components/pages/e2ee-workspace-control-page';
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
  e2eeControlDiagnostics,
  type E2eeControlFailure,
} from '@/lib/e2ee-control-failure';

export const Route = createFileRoute('/workspace/e2ee/$workspaceId')({
  component: WorkspaceControlRoute,
});

function WorkspaceControlRoute() {
  const { workspaceId } = Route.useParams();
  const platform = usePlatform();
  const { t } = useTranslation();
  const session = usePlatformSession();
  const accountId = useE2eeAccountId();
  const port = platform.e2eeWorkspaces;
  const navigate = useNavigate();
  const clearWorkspace = useSetAtom(setWorkspaceContextAtom);
  useLayoutEffect(() => {
    clearWorkspace({ slug: null, workspaceId: null });
  }, [clearWorkspace]);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const reconnect = () => setGeneration((value) => value + 1);
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, []);
  const identity = JSON.stringify([accountId, workspaceId]);
  const scope = JSON.stringify([accountId, workspaceId, generation]);
  const scopeRef = useRef(scope);
  const readOwner = useRef<object | null>(null);
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
    let hostOpened = false;
    let cleanup: E2eeLocalDataScope | null = null;
    let nativeFailure: E2eeControlFailure | null = null;
    const closeHost = () => {
      if (hostOpened && port?.runtime) {
        hostOpened = false;
        void port.runtime.close(workspaceId).catch(() => undefined);
      }
    };
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
    const owner = {};
    readOwner.current = owner;
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
          let status;
          try {
            if (pin) await runtime.recordCreated({ workspaceId, genesisHash: pin });
            status = await runtime.open(
              workspaceId,
              readObservedLedgerCheckpoint(localStorage, accountId, workspaceId) ?? undefined
            );
          } catch (error) {
            // Availability failures retain the original read-only verification path,
            // including its genesis pin and observed-checkpoint checks.
            if (
              !(error instanceof Error) ||
              !/\be2ee_(?:missing-binding|custody_unavailable|account_unavailable|closed)\b/.test(
                error.message
              )
            )
              throw error;
            nativeFailure = classifyE2eeControlFailure(error);
          }
          if (status) {
            hostOpened = true;
            if (disposed) {
              closeHost();
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
            const publish = async () => {
              const exported = await runtime.ledgerView(workspaceId);
              const history = hostLedgerHistory(exported);
              if (!history.continuityPending)
                retainObservedLedgerCheckpoint(localStorage, accountId, workspaceId, history);
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
            await publish();
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
              let page = await port.history({
                workspaceId,
                ...(status.position ? { after: status.position } : {}),
              });
              for (;;) {
                if (disposed) break;
                status = await runtime.ingestLedgerRecords(workspaceId, page);
                if (page.nextCursor === null || status.upgradeRequiredAt !== undefined) {
                  await publish();
                  break;
                }
                page = await port.history({
                  workspaceId,
                  cursor: page.nextCursor,
                  checkpoint: page.checkpoint,
                });
              }
            } catch (error) {
              // The account-facing directory/history can only report a generic
              // denial. Native refresh checks the retained device credential;
              // only its exact whole-member result authorizes local erasure.
              if (!disposed) {
                try {
                  await runtime.refresh(workspaceId, { installKeys: false });
                } catch (checked) {
                  if (isE2eeMemberRemoved(checked)) throw checked;
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
        setState({
          scope,
          identity,
          descriptor,
          history,
          loading: false,
          failure: null,
          custodyFailure: nativeFailure?.kind === 'local-identity' ? nativeFailure.code : undefined,
        });
      } catch (error) {
        if (!disposed && isE2eeMemberRemoved(error)) {
          try {
            if (cleanup) retainEncryptedWorkspaceCleanup(cleanup);
          } catch {
            /* Native receipt still retries local cleanup on the next open. */
          }
          closeHost();
          if (cleanup) await resumeEncryptedWorkspaceCleanup(cleanup, true).catch(() => undefined);
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
      closeHost();
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
  }, [scope, authenticated, port, workspaceId]);
  const current = state.identity === identity ? state : null;
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
  return (
    <>
      {current?.offline && (
        <p role="status" className="px-4 py-2 text-sm text-muted-foreground">
          {t('sessions.offline')}
        </p>
      )}
      {port?.runtime && (current?.custodyFailure || current?.failure) && (
        <E2eeIdentityRecovery
          key={scope}
          workspaceId={workspaceId}
          runtime={port.runtime}
          error={current.custodyFailure ?? current.failure?.code ?? ''}
          onReset={refresh}
        />
      )}
      <E2eeWorkspaceControlPage
        memberManagement={
          current?.nativeStatus?.deviceKind === 'personal' &&
          (current.nativeStatus.memberRole === 'owner' ||
            current.nativeStatus.memberRole === 'admin') &&
          port?.runtime?.removeMember &&
          port.runtime.setMemberRole
            ? {
                actorRole: current.nativeStatus.memberRole,
                remove: async (membershipId) => {
                  await port.runtime!.removeMember!(workspaceId, membershipId);
                  if (scopeRef.current === scope) refresh();
                },
                setRole: async (membershipId, role) => {
                  await port.runtime!.setMemberRole!(workspaceId, membershipId, role);
                  if (scopeRef.current === scope) refresh();
                },
              }
            : undefined
        }
        workspaceId={workspaceId}
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
        onBack={() => {
          void navigate({ to: '/workspace/create', search: { allowExisting: true } });
        }}
      >
        {port?.runtime && accountId && (
          <E2eePersonalPairing
            key={identity}
            workspaceId={workspaceId}
            runtime={port.runtime}
            canApprove={Boolean(current?.history?.locallyPinned)}
            onJoined={refresh}
          />
        )}
        {port?.runtime && current?.history?.locallyPinned && (
          <E2eeRemoteMachinePairing
            key={identity + ':remote-machine'}
            workspaceId={workspaceId}
            runtime={port.runtime}
          />
        )}
        {port && current?.history?.locallyPinned && (
          <E2eeLedgerAudit
            key={identity + ':audit'}
            workspaceId={workspaceId}
            history={current.history}
            read={port.history}
          />
        )}
      </E2eeWorkspaceControlPage>
    </>
  );
}
