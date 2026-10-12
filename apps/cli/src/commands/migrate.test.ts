import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  AuthClient: class {
    constructor() {
      throw new Error('Authentication must not be reached');
    }
  },
  performLogin: () => {
    throw new Error('Login must not be reached');
  },
}));
import { migrateCommand, withMigrationLock, withMigrationTokens } from './migrate';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Effect, Exit } from 'effect';
import type { LoroStreamsTokenProvider } from '@lody/platform';
import { migrationStep } from '@/lib/oss-migration/engine';
const previous = process.env.LODY_PLATFORM;
afterEach(() => {
  if (previous === undefined) delete process.env.LODY_PLATFORM;
  else process.env.LODY_PLATFORM = previous;
});
it('rejects OSS execution before accessing auth or any source/target data', async () => {
  process.env.LODY_PLATFORM = 'local';
  await expect(migrateCommand.parseAsync(['--from-oss'], { from: 'user' })).rejects.toThrow(
    'requires the cloud CLI'
  );
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'joins migration cleanup and removes listeners on %s',
  async (event) => {
    const signals = new EventEmitter();
    const events: string[] = [];
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const name = `migration-signal-test-${randomUUID()}`;
    const result = withMigrationLock(
      name,
      async (signal) => {
        await Effect.runPromise(
          migrationStep(
            (uploadSignal) =>
              new Promise<void>((_resolve, reject) => {
                uploadSignal.addEventListener(
                  'abort',
                  () => {
                    events.push('upload-aborted');
                    void cleanup.then(() => {
                      events.push('upload-joined');
                      reject(uploadSignal.reason);
                    });
                  },
                  { once: true }
                );
                ready();
              })
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                events.push('target-closed');
              })
            )
          ),
          { signal }
        );
      },
      signals as unknown as Pick<NodeJS.Process, 'on' | 'off'>
    ).then(
      () => 'success',
      () => 'interrupted'
    );
    await started;
    signals.emit(event);
    expect(events).toEqual(['upload-aborted']);
    release();
    expect(await result).toBe('interrupted');
    expect(events).toEqual(['upload-aborted', 'upload-joined', 'target-closed']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
    await withMigrationLock(
      name,
      async () => {
        events.push('lock-reacquired');
      },
      signals as unknown as Pick<NodeJS.Process, 'on' | 'off'>
    );
    expect(events.at(-1)).toBe('lock-reacquired');
  }
);

it.each([false, true])('owns native token cleanup after migration failure=%s', async (fail) => {
  const events: string[] = [];
  const provider: LoroStreamsTokenProvider = {
    getToken: () =>
      Effect.sync(() => {
        events.push('get-token');
        return 'synthetic';
      }),
    createAuthCallback: () => () => Effect.succeed('synthetic-auth'),
    getGatewayBaseUrl: () => 'https://streams.test.invalid',
    getShardHostSuffix: () => undefined,
    invalidate: () => Effect.void,
    health: Effect.die('Health is not read by migration'),
    close: Effect.sync(() => {
      events.push('token-closed');
    }),
    retryCleanup: Effect.void,
  };
  const owned = Effect.acquireRelease(Effect.succeed(provider), () =>
    Effect.sync(() => {
      events.push('scope-closed');
    })
  );
  const exit = await Effect.runPromiseExit(
    withMigrationTokens(owned, (tokens) =>
      Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          events.push('target-closed');
        })
      ).pipe(
        Effect.flatMap(() =>
          migrationStep(async () => {
            expect(await tokens.getToken()).toBe('synthetic');
            expect(await tokens.createAuthCallback()({ reason: 'initial' })).toBe('synthetic-auth');
            expect(tokens.getGatewayBaseUrl()).toBe('https://streams.test.invalid');
            if (fail) throw new Error('Synthetic migration failure');
          })
        ),
        Effect.scoped
      )
    )
  );
  expect(Exit.isFailure(exit)).toBe(fail);
  expect(events).toEqual(['get-token', 'target-closed', 'token-closed', 'scope-closed']);
});
