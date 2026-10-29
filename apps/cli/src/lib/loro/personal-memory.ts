import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Context, Effect, Layer, ManagedRuntime } from 'effect';
import { SqliteRepoStore } from 'loro-repo/storage/sqlite';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { MemoryIdSchema } from '@lody/memory';
import { createPersonalMemoryRepository, type PersonalMemoryRepository } from '@lody/memory/repo';

class PersonalMemory extends Context.Service<PersonalMemory, PersonalMemoryRepository>()(
  'lody/PersonalMemory'
) {}

/** Lazy, daemon-owned store. No Streams transport, token provider, or workspace metadata. */
export function createCliPersonalMemoryRuntime(ownerId: string, workspaceId: string) {
  const layer = Layer.effect(
    PersonalMemory,
    Effect.acquireRelease(
      Effect.promise(async () => {
        const directory = path.join(
          getLodyDataDir(),
          'personal-memory',
          encodeURIComponent(MemoryIdSchema.parse(workspaceId)),
          encodeURIComponent(MemoryIdSchema.parse(ownerId))
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const storage = new SqliteRepoStore({ path: path.join(directory, 'memory.sqlite3') });
        try {
          const repo = await createPersonalMemoryRepository({ ownerId, storage: storage.storage });
          return {
            ...repo,
            close: async () => {
              await repo.close();
              storage.close();
            },
          };
        } catch (error) {
          storage.close();
          throw error;
        }
      }),
      (repo) => Effect.promise(() => repo.close())
    )
  );
  const runtime = ManagedRuntime.make(layer);
  const run = <A>(use: (repo: PersonalMemoryRepository) => Promise<A>) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* PersonalMemory;
        return yield* Effect.promise(() => use(repo));
      })
    );
  return {
    open: (memoryId: string) =>
      run((repo) =>
        repo.open(memoryId, {
          changeId: randomUUID(),
          recordedAt: Date.now(),
          source: { actor: 'user' },
        })
      ),
    openCatalog: () => run((repo) => repo.openCatalog()),
    acquireRoom: (roomId: string) => run((repo) => repo.acquireRoom(roomId)),
    close: () => runtime.dispose(),
  };
}
