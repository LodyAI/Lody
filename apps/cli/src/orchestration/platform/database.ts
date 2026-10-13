import Database from 'better-sqlite3';
import { Context, Effect, Layer } from 'effect';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type DatabaseLocation = { kind: 'memory' } | { kind: 'disk'; path: string };
type Synchronous<A> = A extends PromiseLike<unknown> | Effect.Effect<unknown, unknown, unknown>
  ? never
  : A;

/** Platform-private connection. Workflows use domain repositories, never this driver. */
export class OrchestrationConnection {
  readonly raw: Database.Database;
  constructor(location: DatabaseLocation) {
    if (location.kind === 'disk') {
      const directory = path.dirname(location.path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    this.raw = new Database(location.kind === 'memory' ? ':memory:' : location.path);
    try {
      if (location.kind === 'disk') {
        chmodSync(location.path, 0o600);
        this.raw.pragma('journal_mode = WAL');
      }
      this.raw.pragma('busy_timeout = 5000');
      this.raw.pragma('foreign_keys = ON');
    } catch (cause) {
      this.close();
      throw cause;
    }
  }
  withImmediate<A>(body: () => Synchronous<A>): A {
    return this.raw
      .transaction(() => {
        const value = body();
        if (Effect.isEffect(value)) throw new Error('ASYNC_SQLITE_TRANSACTION_FORBIDDEN');
        if (
          value !== null &&
          (typeof value === 'object' || typeof value === 'function') &&
          'then' in value &&
          typeof value.then === 'function'
        ) {
          throw new Error('ASYNC_SQLITE_TRANSACTION_FORBIDDEN');
        }
        return value;
      })
      .immediate();
  }
  close(): void {
    if (this.raw.open) this.raw.close();
  }
}

export class OrchestrationDatabase extends Context.Service<
  OrchestrationDatabase,
  OrchestrationConnection
>()('lody/orchestration/Database') {
  static layer(location: DatabaseLocation) {
    return Layer.effect(
      OrchestrationDatabase,
      Effect.acquireRelease(
        Effect.try({ try: () => new OrchestrationConnection(location), catch: (cause) => cause }),
        (connection) => Effect.sync(() => connection.close())
      )
    );
  }
}
