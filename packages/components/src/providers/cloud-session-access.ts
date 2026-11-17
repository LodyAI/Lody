import type { SessionAccessPort, SessionAccessView, E2eeWorkspaceRuntime } from '@lody/platform';
import type { CloudQuery, CloudMutation } from '@lody/platform';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { subscribeE2eeLedgerChanges } from './e2ee-runtime-notifications';

type Scope = { encrypted: boolean; accountId: string; token: object };
type Client = {
  query<A, R>(operation: CloudQuery<A, R>, args: A): Promise<R>;
  mutation<A, R>(operation: CloudMutation<A, R>, args: A): Promise<R>;
  subscribe<A, R>(operation: CloudQuery<A, R>, args: A, invalidate: () => void): () => void;
};

/** Cloud composition only. Server hints never replace host policy verification. */
export function createCloudSessionAccess(input: {
  client: Client;
  runtime?: E2eeWorkspaceRuntime;
  assertScope(workspaceId: string): Scope;
}): SessionAccessPort {
  const assertSame = (workspaceId: string, scope: Scope) => {
    const current = input.assertScope(workspaceId);
    if (
      current.token !== scope.token ||
      current.accountId !== scope.accountId ||
      current.encrypted !== scope.encrypted
    )
      throw new Error('session_access_scope_changed');
  };
  const read = async (workspaceId: string, machineId: string): Promise<SessionAccessView> => {
    const scope = input.assertScope(workspaceId);
    if (!scope.encrypted) {
      const views = await input.client.query(cloudOperations.machines.listSessionAccess, {
        workspaceId,
      });
      assertSame(workspaceId, scope);
      return (
        views.find((view) => view.machineId === machineId) ?? {
          machineId,
          canManage: false,
          readSharedSessionIds: [],
        }
      );
    }
    if (!input.runtime?.readMachineSharing) throw new Error('session_access_unavailable');
    const view = await input.runtime?.readMachineSharing(workspaceId, machineId);
    assertSame(workspaceId, scope);
    if (view.machineId !== machineId) throw new Error('session_access_unavailable');
    return {
      machineId,
      canManage: view.canManage,
      needsResign: view.needsResign,
      generation: view.generation,
      ...(view.pendingRequest?.change.kind === 'session'
        ? {
            pendingRequest: {
              requestId: view.pendingRequest.requestId,
              sessionId: view.pendingRequest.change.sessionId,
              level: view.pendingRequest.change.level,
              audience: view.pendingRequest.change.audience,
            },
          }
        : {}),
      readSharedSessionIds:
        view.removed || view.unavailable
          ? []
          : view.sessions.filter((row) => row.audience === 'team').map((row) => row.sessionId),
      memberReadSharedSessions:
        view.removed || view.unavailable
          ? []
          : view.sessions.flatMap((row) =>
              row.audience === 'team'
                ? []
                : [{ sessionId: row.sessionId, userId: row.audience.userId }]
            ),
    };
  };
  return {
    read,
    async list(workspaceId) {
      const scope = input.assertScope(workspaceId);
      if (!scope.encrypted) {
        const views = await input.client.query(cloudOperations.machines.listSessionAccess, {
          workspaceId,
        });
        assertSame(workspaceId, scope);
        return views;
      }
      const hints = await input.client.query(cloudOperations.e2eeMachineSharing.listVersions, {
        workspaceId,
      });
      assertSame(workspaceId, scope);
      const views: SessionAccessView[] = [];
      const machines = [...new Set(hints.map((hint) => hint.machineId))];
      for (let i = 0; i < machines.length; i += 2) {
        const results = await Promise.allSettled(
          machines.slice(i, i + 2).map((id) => read(workspaceId, id))
        );
        assertSame(workspaceId, scope);
        for (const result of results) if (result.status === 'fulfilled') views.push(result.value);
      }
      return views;
    },
    async set(intent) {
      const scope = input.assertScope(intent.workspaceId);
      const view = await read(intent.workspaceId, intent.machineId);
      assertSame(intent.workspaceId, scope);
      if (!view.canManage) throw new Error('session_access_not_owned');
      if (scope.encrypted) {
        if (
          !input.runtime?.updateMachineSharing ||
          !intent.generation ||
          view.generation !== intent.generation
        )
          throw new Error('session_access_generation_changed');
        return input.runtime?.updateMachineSharing(
          intent.workspaceId,
          intent.machineId,
          intent.generation,
          intent.requestId,
          {
            kind: 'session',
            sessionId: intent.sessionId,
            level: intent.level,
            audience: intent.audience,
          }
        );
      }
      await input.client.mutation(cloudOperations.machines.setSessionReadSharedWithTeam, {
        workspaceId: intent.workspaceId,
        machineId: intent.machineId,
        sessionId: intent.sessionId,
        sharedWithTeam: intent.level === 'read',
        audience: intent.audience,
      });
      return { status: 'saved' };
    },
    subscribe(workspaceId, invalidate) {
      const scope = input.assertScope(workspaceId);
      const changed = () => {
        try {
          assertSame(workspaceId, scope);
        } catch {
          return;
        }
        invalidate();
      };
      const unsubscribe = scope.encrypted
        ? input.client.subscribe(
            cloudOperations.e2eeMachineSharing.listVersions,
            { workspaceId },
            changed
          )
        : input.client.subscribe(
            cloudOperations.machines.listSessionAccess,
            { workspaceId },
            changed
          );
      const ledger = scope.encrypted
        ? subscribeE2eeLedgerChanges(scope.accountId, workspaceId, changed)
        : () => {};
      return () => {
        unsubscribe();
        ledger();
      };
    },
  };
}
