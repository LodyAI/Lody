import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import type {
  E2eeMachineSharingChange,
  E2eeMachineSharingView,
  E2eeWorkspaceRuntime,
} from '@lody/platform';
import type { WorkspaceId } from '@lody/shared';
import {
  workspaceContentModeAtom,
  type WorkspaceContentMode,
} from '@/atoms/workspace-content-mode';
import { useResolvedWorkspaceScope } from '@/hooks/use-resolved-workspace-scope';
import { subscribeE2eeLedgerChanges } from '../../../providers/e2ee-runtime-notifications';
import {
  MachineSharingPanel,
  sharingIssue,
  type SharingIssue,
  type SharingProject,
} from './machine-sharing-panel';

type Intent = {
  generation: string;
  requestId: string;
  change: E2eeMachineSharingChange;
  conflict?: boolean;
};
/** Scoped native workflow: failures and pending originals affect this panel only. */
export function MachineSharingController({
  accountId,
  workspaceId,
  machineId,
  runtime,
  projects,
}: {
  accountId: string;
  workspaceId: string;
  machineId: string;
  runtime?: E2eeWorkspaceRuntime;
  projects: readonly SharingProject[];
}) {
  const [view, setView] = useState<E2eeMachineSharingView>();
  const [issue, setIssue] = useState<SharingIssue>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const intent = useRef<Intent | undefined>(undefined);
  const writing = useRef(false),
    active = useRef(false),
    readId = useRef(0);
  const load = useCallback(
    async (afterWrite = false) => {
      if (writing.current && !afterWrite) return undefined;
      const id = ++readId.current;
      setLoading(true);
      try {
        if (!runtime?.readMachineSharing) throw new Error('e2ee_unavailable');
        const next = await runtime.readMachineSharing(workspaceId, machineId);
        if (!active.current || id !== readId.current) return undefined;
        setView(next);
        if (intent.current && intent.current.generation !== next.generation) {
          intent.current = undefined;
          setIssue('generation');
        } else {
          if (next.pendingRequest && (!intent.current || intent.current.conflict))
            intent.current = { generation: next.generation, ...next.pendingRequest };
          setIssue(
            next.unavailable
              ? 'unavailable'
              : intent.current?.conflict
                ? 'conflict'
                : next.pendingRequest || intent.current
                  ? 'pending'
                  : undefined
          );
        }
        return next;
      } catch (cause) {
        if (active.current && id === readId.current) {
          const known = sharingIssue(cause);
          setIssue(known === 'notOwned' || known === 'notShared' ? known : 'unavailable');
          if (known === 'notOwned' || known === 'notShared') setView(undefined);
        }
        return undefined;
      } finally {
        if (active.current && id === readId.current) setLoading(false);
      }
    },
    [machineId, runtime, workspaceId]
  );
  const invalidateRead = useCallback(() => {
    ++readId.current;
  }, []);
  useEffect(() => {
    active.current = true;
    void load();
    const refresh = () => {
      void load();
    };
    const unsubscribe = subscribeE2eeLedgerChanges(accountId, workspaceId, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active.current = false;
      invalidateRead();
      unsubscribe();
      window.removeEventListener('focus', refresh);
    };
  }, [accountId, workspaceId, load, invalidateRead]);
  const publish = async (selected: Intent) => {
    if (writing.current || !view?.canManage || !runtime?.updateMachineSharing) return;
    writing.current = true;
    ++readId.current;
    intent.current = selected;
    setBusy(true);
    setIssue(undefined);
    setLoading(false);
    try {
      const reply = await runtime.updateMachineSharing(
        workspaceId,
        machineId,
        selected.generation,
        selected.requestId,
        selected.change
      );
      if (!active.current) return;
      if (reply.status === 'saved') {
        intent.current = undefined;
        await load(true);
      } else if (reply.status === 'conflict') {
        intent.current = { ...selected, conflict: true };
        setIssue('conflict');
      } else if (reply.status === 'removed') {
        intent.current = undefined;
        setIssue('removed');
      } else setIssue('pending');
    } catch (cause) {
      if (active.current) {
        const nextIssue = sharingIssue(cause);
        if (nextIssue === 'conflict') intent.current = { ...selected, conflict: true };
        setIssue(nextIssue);
      }
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
  };
  const change = (next: E2eeMachineSharingChange) => {
    if (
      !view ||
      intent.current ||
      (issue && issue !== 'generation') ||
      loading ||
      !view.canManage ||
      view.needsResign ||
      view.unavailable
    )
      return;
    void publish({
      generation: view.generation,
      requestId: crypto.randomUUID().replaceAll('-', ''),
      change: next,
    });
  };
  return (
    <MachineSharingPanel
      view={view}
      projects={projects}
      busy={busy}
      loading={loading}
      issue={issue}
      retryable={!!intent.current}
      pendingChange={intent.current?.change ?? view?.pendingRequest?.change}
      onChange={change}
      onRefresh={() => {
        void load();
      }}
      onRetry={() => {
        const selected = intent.current;
        if (!selected) return;
        if (!selected.conflict) {
          void publish(selected);
          return;
        }
        void (async () => {
          const next = await load();
          if (
            !active.current ||
            !next?.canManage ||
            next.generation !== selected.generation ||
            next.unavailable ||
            (next.pendingRequest && next.pendingRequest.requestId !== selected.requestId)
          )
            return;
          await publish({
            ...selected,
            conflict: false,
            requestId: crypto.randomUUID().replaceAll('-', ''),
          });
        })();
      }}
      onResign={() => {
        if (!view?.canManage || !view.needsResign || intent.current || issue) return;
        void (async () => {
          const next = await load();
          if (
            !active.current ||
            !next?.canManage ||
            !next.needsResign ||
            next.unavailable ||
            next.generation !== view.generation
          )
            return;
          await publish({
            generation: next.generation,
            requestId: crypto.randomUUID().replaceAll('-', ''),
            change: { kind: 'machine', sharedWithTeam: next.sharedWithTeam },
          });
        })();
      }}
    />
  );
}

function ScopedMachineSharing({
  mode,
  machineId,
  projects,
}: {
  mode: NonNullable<WorkspaceContentMode>;
  machineId: string;
  projects: readonly SharingProject[];
}) {
  const platform = usePlatform(),
    session = usePlatformSession();
  const scope = useResolvedWorkspaceScope({ workspaceId: mode.workspaceId as WorkspaceId | null });
  if (
    !scope.enabled ||
    !scope.workspaceId ||
    !mode.accountId ||
    session.status !== 'authenticated' ||
    session.user.id !== mode.accountId
  )
    return null;
  return (
    <MachineSharingController
      key={JSON.stringify([mode.accountId, scope.workspaceId, machineId])}
      accountId={mode.accountId}
      workspaceId={scope.workspaceId}
      machineId={machineId}
      runtime={platform.e2eeWorkspaces?.runtime}
      projects={projects}
    />
  );
}
export function E2eeMachineSharingSettings({
  machineId,
  projects,
}: {
  machineId: string;
  projects: readonly SharingProject[];
}) {
  const mode = useAtomValue(workspaceContentModeAtom);
  return mode?.descriptor &&
    'contentMode' in mode.descriptor &&
    mode.descriptor.contentMode === 'e2ee' ? (
    <ScopedMachineSharing mode={mode} machineId={machineId} projects={projects} />
  ) : null;
}
