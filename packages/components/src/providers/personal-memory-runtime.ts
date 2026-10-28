import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { createPersonalMemoryRepository, type PersonalMemoryRepository } from '@lody/memory/repo';
import { LocalLoroTransportAdapter } from '@lody/shared/local-loro-transport';
import type { WorkspaceId } from '@lody/shared';
import { createWorkspaceRepoStorage } from './workspace-repo-storage';
import { createLocalLoroDataPlaneConnection } from './local-loro-data-plane-connection';

class PersonalMemory extends Context.Service<PersonalMemory, PersonalMemoryRepository>()(
  'lody/RendererPersonalMemory'
) {}

export function createPersonalMemoryRuntime(
  ownerId: string,
  workspaceId: WorkspaceId,
  dbName: string
) {
  const runtime = ManagedRuntime.make(
    Layer.effect(
      PersonalMemory,
      Effect.acquireRelease(
        Effect.promise(async () => {
          const local = createLocalLoroDataPlaneConnection();
          if (!local) throw new Error('memory_local_connection_unavailable');
          try {
            const repo = await createPersonalMemoryRepository({
              ownerId,
              storage: createWorkspaceRepoStorage(dbName),
              localTransport: new LocalLoroTransportAdapter({
                workspaceId,
                peerId: `memory:${crypto.randomUUID()}`,
                connection: local.connection,
              }),
            });
            return {
              ...repo,
              close: async () => {
                await repo.close();
                local.dispose();
              },
            };
          } catch (error) {
            local.dispose();
            throw error;
          }
        }),
        (repo) => Effect.promise(() => repo.close())
      )
    )
  );
  return {
    open: (roleId: string) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const repo = yield* PersonalMemory;
          return yield* Effect.promise(() =>
            repo.open(roleId, {
              changeId: crypto.randomUUID(),
              recordedAt: Date.now(),
              source: { actor: 'user' },
            })
          );
        })
      ),
    close: () => runtime.dispose(),
  };
}
