import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import type { WorkspaceModeDescriptor } from '@lody/cloud-api';
import { setWorkspaceContextAtom } from '@/atoms';
import { E2eeWorkspaceControlPage } from '@/components/pages/e2ee-workspace-control-page';
import { appendLedgerHistory, type VerifiedLedgerHistory } from '@/lib/e2ee-ledger-history';
import {
  readE2eeGenesisPin,
  retainEncryptedWorkspaceMode,
  readObservedLedgerCheckpoint,
  retainObservedLedgerCheckpoint,
} from '@/lib/e2ee-workspace-storage';

export const Route = createFileRoute('/workspace/e2ee/$workspaceId')({
  component: WorkspaceControlRoute,
});

function WorkspaceControlRoute() {
  const { workspaceId } = Route.useParams();
  const platform = usePlatform();
  const session = usePlatformSession();
  const accountId = session.status === 'authenticated' ? session.user.id : null;
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
    error: boolean;
  }>({ scope, identity, descriptor: null, history: null, loading: true, error: false });
  useEffect(() => {
    let disposed = false;
    setState((previous) =>
      previous.identity === identity
        ? { ...previous, scope, loading: Boolean(port && accountId), error: false }
        : {
            scope,
            identity,
            descriptor: null,
            history: null,
            loading: Boolean(port && accountId),
            error: false,
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
        setState({ scope, identity, descriptor, history, loading: false, error: false });
      } catch {
        if (!disposed)
          setState((previous) =>
            previous.scope === scope ? { ...previous, loading: false, error: true } : previous
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
      !current.descriptor ||
      current.loading ||
      current.scope !== scope
    )
      return;
    const previous = current.history;
    setState({ ...current, loading: true, error: false });
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
      setState({ ...current, history, loading: false, error: false });
    } catch {
      if (scopeRef.current === scope && readOwner.current === owner)
        setState({ ...current, loading: false, error: true });
    }
  };
  return (
    <E2eeWorkspaceControlPage
      workspaceId={workspaceId}
      genesisHash={current?.descriptor?.genesisHash}
      history={current?.history ?? null}
      loading={!current || current.loading || current.scope !== scope}
      error={current?.error ?? false}
      unavailable={!port || !accountId}
      onLoadMore={() => {
        void loadMore();
      }}
      onRefresh={() => setGeneration((value) => value + 1)}
      onBack={() => {
        void navigate({ to: '/workspace/create', search: { allowExisting: true } });
      }}
    />
  );
}
