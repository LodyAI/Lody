import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import type { WorkspaceModeDescriptor } from '@lody/cloud-api';
import { setWorkspaceContextAtom } from '@/atoms';
import { E2eeWorkspaceControlPage } from '@/components/pages/e2ee-workspace-control-page';
import { appendLedgerHistory, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';
import {
  readE2eeGenesisPin,
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
  const session = usePlatformSession();
  const accountId = session.status === 'authenticated' ? session.user.id : null;
  const user = session.status === 'authenticated' ? session.user : null;
  const you = useMemo(
    () =>
      user
        ? {
            name: [user.name, user.email].find((value) => value != null && value !== '') ?? user.id,
            image: user.image ?? null,
          }
        : undefined,
    [user]
  );
  const port = platform.e2eeWorkspaces;
  const navigate = useNavigate();
  const clearWorkspace = useSetAtom(setWorkspaceContextAtom);
  useLayoutEffect(() => {
    clearWorkspace({ slug: null, workspaceId: null });
  }, [clearWorkspace]);
  const [generation, setGeneration] = useState(0);
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
  }>({ scope, identity, descriptor: null, history: null, loading: true, failure: null });
  useEffect(() => {
    let disposed = false;
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
        setState({ scope, identity, descriptor, history, loading: false, failure: null });
      } catch (error) {
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
      if (readOwner.current === owner) readOwner.current = null;
    };
  }, [scope, identity, port, workspaceId, accountId]);
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
  return (
    <E2eeWorkspaceControlPage
      workspaceId={workspaceId}
      genesisHash={current?.descriptor?.genesisHash}
      history={current?.history ?? null}
      loading={!current || current.loading || current.scope !== scope}
      failure={current?.failure ?? null}
      unavailable={!port || !accountId}
      you={you}
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
    />
  );
}
