import { createHash, randomBytes } from 'node:crypto';
import {
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Semaphore,
} from 'effect';
import {
  publicMcpServer,
  type McpAuthenticationResult,
  type McpLocalAuthentication,
  type ResolvedMcpServer,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import {
  McpStoredAuthenticationSchema,
  mcpOAuthChallenge,
  type McpAuthenticationIO,
  type McpRelayRequest,
  type McpStoredAuthentication,
} from './io';

type Reason = NonNullable<McpAuthenticationResult['reason']>;
export class McpAuthenticationError extends Data.TaggedError('McpAuthenticationError')<{
  readonly reason: Reason;
}> {
  override get message() {
    return `MCP authentication failed (${this.reason}).`;
  }
}
export interface McpCredentialStore {
  read(key: string): Effect.Effect<string | undefined, McpAuthenticationError>;
  write(key: string, value: string): Effect.Effect<void, McpAuthenticationError>;
  remove(key: string): Effect.Effect<void, McpAuthenticationError>;
}
const external = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new McpAuthenticationError({ reason: 'connection_failed' }),
  });
const targetOf = (server: WorkspaceMcpServerMeta) =>
  JSON.stringify(publicMcpServer(server).connection);
const result = (
  status: McpAuthenticationResult['status'],
  hasCredentials = false,
  reason?: Reason
): McpAuthenticationResult => ({
  type: 'mcp/authentication',
  status,
  hasCredentials,
  ...(reason ? { reason } : {}),
});
type Attempt = {
  id: string;
  fiber?: Fiber.Fiber<void, never>;
  status: McpAuthenticationResult;
  target: string;
};

export class McpAuthentication extends Context.Service<
  McpAuthentication,
  {
    status(
      server: WorkspaceMcpServerMeta
    ): Effect.Effect<McpAuthenticationResult, McpAuthenticationError>;
    configure(
      server: WorkspaceMcpServerMeta,
      settings: McpLocalAuthentication
    ): Effect.Effect<McpAuthenticationResult, McpAuthenticationError>;
    authorize(
      server: WorkspaceMcpServerMeta
    ): Effect.Effect<McpAuthenticationResult, McpAuthenticationError>;
    cancel(
      server: WorkspaceMcpServerMeta,
      attemptId?: string
    ): Effect.Effect<McpAuthenticationResult, McpAuthenticationError>;
    signout(
      server: WorkspaceMcpServerMeta
    ): Effect.Effect<McpAuthenticationResult, McpAuthenticationError>;
    observe(server: WorkspaceMcpServerMeta, response: Response): Effect.Effect<void>;
    connected(server: WorkspaceMcpServerMeta): Effect.Effect<void, McpAuthenticationError>;
    headers(
      server: WorkspaceMcpServerMeta,
      force?: boolean
    ): Effect.Effect<Record<string, string>, McpAuthenticationError>;
    environment(
      server: WorkspaceMcpServerMeta
    ): Effect.Effect<Record<string, string>, McpAuthenticationError>;
    prepare(
      server: WorkspaceMcpServerMeta,
      resolved: ResolvedMcpServer,
      owner: string,
      requesterUserId: string
    ): Effect.Effect<ResolvedMcpServer, McpAuthenticationError>;
    release(owner: string): Effect.Effect<void, McpAuthenticationError>;
  }
>()('lody/mcp/Authentication') {}

export function mcpAuthenticationLayer(options: {
  namespace: string;
  userId: string;
  store: McpCredentialStore;
  io: McpAuthenticationIO;
}) {
  return Layer.effect(
    McpAuthentication,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const attempts = new Map<string, Attempt>();
      const states = new Map<string, { target: string; value: McpAuthenticationResult }>();
      const locks = new Map<string, Semaphore.Semaphore>();
      const leases = new Map<
        string,
        { owner: string; key: string; scope: Scope.Closeable; server: ResolvedMcpServer }
      >();
      const leaseLock = Semaphore.makeUnsafe(1);
      const closedOwners = new Set<string>();
      const keyOf = (server: WorkspaceMcpServerMeta) =>
        createHash('sha256')
          .update(JSON.stringify([options.namespace, server.id]))
          .digest('hex');
      const locked = <A, E, R>(server: WorkspaceMcpServerMeta, work: Effect.Effect<A, E, R>) => {
        const key = keyOf(server);
        let lock = locks.get(key);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock.withPermits(1)(work);
      };
      const remember = (server: WorkspaceMcpServerMeta, value: McpAuthenticationResult) => {
        states.set(keyOf(server), { target: targetOf(server), value });
        return value;
      };
      const read = Effect.fnUntraced(function* (server: WorkspaceMcpServerMeta) {
        if (server.connection?.authentication !== 'local') return undefined;
        const raw = yield* options.store.read(keyOf(server));
        if (!raw) return undefined;
        const parsed = yield* Effect.try({
          try: () => McpStoredAuthenticationSchema.parse(JSON.parse(raw)),
          catch: () => new McpAuthenticationError({ reason: 'storage_unavailable' }),
        });
        return parsed.target === targetOf(server) ? parsed : undefined;
      });
      const write = Effect.fnUntraced(function* (
        server: WorkspaceMcpServerMeta,
        record: McpStoredAuthentication
      ) {
        if (record.tokens?.expires_in !== undefined)
          record.expiresAt = (yield* Clock.currentTimeMillis) + record.tokens.expires_in * 1000;
        else record.expiresAt = undefined;
        yield* options.store.write(
          keyOf(server),
          JSON.stringify(McpStoredAuthenticationSchema.parse(record))
        );
      });
      const status = Effect.fnUntraced(function* (server: WorkspaceMcpServerMeta) {
        const cached = states.get(keyOf(server));
        if (cached?.target === targetOf(server)) return cached.value;
        const record = yield* read(server);
        if (!record)
          return result(server.connection?.authentication === 'local' ? 'required' : 'unknown');
        const hasCredentials =
          record.settings.mode === 'oauth'
            ? Boolean(record.tokens)
            : Boolean(
                record.settings.bearerToken ||
                Object.keys(record.settings.headers ?? {}).length ||
                Object.keys(record.settings.env ?? {}).length
              );
        return remember(server, {
          ...result(hasCredentials ? 'authorized' : 'required', hasCredentials),
          mode: record.settings.mode,
        });
      });
      const stopAttempt = Effect.fnUntraced(function* (
        server: WorkspaceMcpServerMeta,
        attemptId?: string
      ) {
        const attempt = attempts.get(keyOf(server));
        if (!attempt || (attemptId && attempt.id !== attemptId)) return;
        if (attempt.fiber) yield* Fiber.interrupt(attempt.fiber);
        if (attempts.get(keyOf(server)) === attempt) attempts.delete(keyOf(server));
      });
      const revokeLeases = (predicate: (lease: { owner: string; key: string }) => boolean) =>
        leaseLock.withPermits(1)(
          Effect.gen(function* () {
            for (const [key, lease] of leases)
              if (predicate(lease)) {
                yield* Scope.close(lease.scope, Exit.void);
                leases.delete(key);
              }
          })
        );
      const configure = (server: WorkspaceMcpServerMeta, settings: McpLocalAuthentication) =>
        Effect.gen(function* () {
          yield* revokeLeases((lease) => lease.key === keyOf(server));
          return yield* locked(
            server,
            Effect.gen(function* () {
              yield* stopAttempt(server);
              yield* write(server, { target: targetOf(server), settings });
              states.delete(keyOf(server));
              return yield* status(server);
            })
          );
        });
      const observe = (server: WorkspaceMcpServerMeta, response: Response) =>
        Effect.gen(function* () {
          const metadata = yield* Effect.try({
            try: () => mcpOAuthChallenge(response),
            catch: () => new McpAuthenticationError({ reason: 'unsupported' }),
          });
          const connection = server.connection;
          if (!metadata || connection?.transport !== 'http') return;
          const info = yield* external((signal) =>
            options.io.discover(connection.url, metadata, signal)
          );
          const supported =
            info.resourceMetadata &&
            info.authorizationServerMetadata?.authorization_endpoint &&
            info.authorizationServerMetadata.token_endpoint;
          if (supported) remember(server, result('required', false, 'oauth_required'));
        }).pipe(Effect.catch(() => Effect.void));
      const headers = (server: WorkspaceMcpServerMeta, force = false) =>
        locked(
          server,
          Effect.gen(function* () {
            const record = yield* read(server);
            if (!record) {
              if (server.connection?.authentication === 'local')
                return yield* new McpAuthenticationError({ reason: 'oauth_required' });
              return {};
            }
            const values = Object.fromEntries(
              Object.entries(record.settings.headers ?? {}).map(([key, value]) => [
                key.toLowerCase(),
                value,
              ])
            );
            if (record.settings.mode === 'manual') {
              if (record.settings.bearerToken)
                values.authorization = `Bearer ${record.settings.bearerToken}`;
              return values;
            }
            if (!record.tokens)
              return yield* new McpAuthenticationError({ reason: 'oauth_required' });
            const now = yield* Clock.currentTimeMillis;
            if (force || (record.expiresAt !== undefined && record.expiresAt <= now + 30_000)) {
              const connection = server.connection;
              if (connection?.transport !== 'http')
                return yield* new McpAuthenticationError({ reason: 'unsupported' });
              const refreshed = yield* external((signal) =>
                options.io.authorize(record, { url: connection.url, signal })
              ).pipe(
                Effect.catch(() => {
                  remember(server, result('required', false, 'expired'));
                  return Effect.fail(new McpAuthenticationError({ reason: 'expired' }));
                })
              );
              if (!refreshed.record.tokens || refreshed.url)
                return yield* new McpAuthenticationError({ reason: 'expired' });
              yield* write(server, refreshed.record).pipe(Effect.uninterruptible);
              remember(server, { ...result('authorized', true), mode: 'oauth' });
              values.authorization = `Bearer ${refreshed.record.tokens.access_token}`;
            } else values.authorization = `Bearer ${record.tokens.access_token}`;
            return values;
          })
        );
      const authorize = (server: WorkspaceMcpServerMeta) =>
        locked(
          server,
          Effect.gen(function* () {
            if (
              server.connection?.transport !== 'http' ||
              server.connection.authentication !== 'local'
            )
              return yield* new McpAuthenticationError({ reason: 'unsupported' });
            yield* stopAttempt(server);
            const existing = yield* read(server);
            const staged: McpStoredAuthentication = {
              target: targetOf(server),
              settings: { ...existing?.settings, mode: 'oauth' },
              client: existing?.client,
            };
            const ready = yield* Deferred.make<McpAuthenticationResult, McpAuthenticationError>();
            const attempt: Attempt = {
              id: randomBytes(24).toString('hex'),
              target: targetOf(server),
              status: result('waiting'),
            };
            attempts.set(keyOf(server), attempt);
            const url = server.connection.url;
            const worker = Effect.scoped(
              Effect.gen(function* () {
                const state = randomBytes(32).toString('base64url');
                const endpoint = yield* Effect.acquireRelease(
                  external(() => options.io.callback(state)),
                  (acquired) =>
                    external(() => acquired.close()).pipe(Effect.timeout('5 seconds'), Effect.orDie)
                );
                const discovery = yield* external((signal) =>
                  options.io.discover(url, undefined, signal)
                );
                if (
                  !discovery.resourceMetadata ||
                  !discovery.authorizationServerMetadata?.authorization_endpoint ||
                  !discovery.authorizationServerMetadata.token_endpoint
                )
                  return yield* new McpAuthenticationError({ reason: 'unsupported' });
                if (
                  !discovery.authorizationServerMetadata.registration_endpoint &&
                  !staged.settings.clientId
                )
                  return yield* new McpAuthenticationError({ reason: 'client_required' });
                const started = yield* external((signal) =>
                  options.io.authorize(staged, {
                    url,
                    state,
                    redirectUrl: endpoint.redirectUrl,
                    discovery,
                    signal,
                  })
                );
                if (!started.url || !started.verifier)
                  return yield* new McpAuthenticationError({ reason: 'unsupported' });
                const waiting = {
                  ...result('waiting'),
                  mode: 'oauth' as const,
                  attemptId: attempt.id,
                  authorizationUrl: started.url,
                };
                attempt.status = waiting;
                remember(server, { ...waiting, authorizationUrl: undefined });
                yield* Deferred.succeed(ready, waiting);
                const callback = yield* external((signal) => endpoint.wait(signal));
                const completed = yield* external((signal) =>
                  options.io.authorize(started.record, {
                    url,
                    state,
                    redirectUrl: endpoint.redirectUrl,
                    verifier: started.verifier,
                    discovery: started.discovery,
                    code: callback.code,
                    iss: callback.iss,
                    signal,
                  })
                );
                if (!completed.record.tokens)
                  return yield* new McpAuthenticationError({ reason: 'oauth_required' });
                yield* locked(
                  server,
                  Effect.gen(function* () {
                    if (attempts.get(keyOf(server)) !== attempt) return;
                    yield* write(server, completed.record);
                    attempt.status = remember(server, {
                      ...result('authorized', true),
                      mode: 'oauth',
                    });
                  }).pipe(Effect.uninterruptible)
                );
                return undefined;
              })
            ).pipe(
              Effect.timeout('10 minutes'),
              Effect.catch((error) =>
                Effect.gen(function* () {
                  const failure =
                    error instanceof McpAuthenticationError
                      ? error
                      : new McpAuthenticationError({ reason: 'connection_failed' });
                  attempt.status = remember(server, {
                    ...result(
                      'error',
                      Boolean(
                        existing?.tokens ||
                        existing?.settings.bearerToken ||
                        Object.keys(existing?.settings.headers ?? {}).length
                      ),
                      failure.reason
                    ),
                    ...(existing ? { mode: existing.settings.mode } : {}),
                  });
                  yield* Deferred.fail(ready, failure);
                })
              ),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  attempt.status = remember(server, result('required', false, 'cancelled'));
                })
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  if (attempts.get(keyOf(server)) === attempt) attempts.delete(keyOf(server));
                })
              )
            );
            attempt.fiber = yield* Effect.forkIn(worker, scope);
            return yield* Deferred.await(ready).pipe(
              Effect.onInterrupt(() => stopAttempt(server, attempt.id))
            );
          })
        );
      const cancel = (server: WorkspaceMcpServerMeta, id?: string) =>
        Effect.gen(function* () {
          const attempt = attempts.get(keyOf(server));
          if (!attempt || (id && attempt.id !== id)) return yield* status(server);
          yield* stopAttempt(server, id);
          states.delete(keyOf(server));
          const previous = yield* status(server);
          return previous.hasCredentials
            ? previous
            : remember(server, { ...previous, reason: 'cancelled' });
        });
      const signout = (server: WorkspaceMcpServerMeta) =>
        Effect.gen(function* () {
          yield* stopAttempt(server);
          yield* revokeLeases((lease) => lease.key === keyOf(server));
          return yield* locked(
            server,
            Effect.gen(function* () {
              yield* options.store.remove(keyOf(server));
              return remember(server, result('required'));
            })
          );
        });
      const reject = (job: McpRelayRequest) =>
        Effect.sync(() => {
          if (!job.response.headersSent)
            job.response.writeHead(503, {
              'content-type': 'text/plain',
              'cache-control': 'no-store',
            });
          job.response.end('MCP connection unavailable. Check this service in Lody Settings.');
        });
      const prepare = (
        server: WorkspaceMcpServerMeta,
        resolved: ResolvedMcpServer,
        owner: string,
        requesterUserId: string
      ) =>
        leaseLock.withPermits(1)(
          Effect.gen(function* () {
            if (closedOwners.has(owner))
              return yield* new McpAuthenticationError({ reason: 'cancelled' });
            const own = requesterUserId === options.userId;
            if (
              'type' in resolved &&
              (server.connection?.transport !== 'http' || server.connection.url !== resolved.url)
            )
              return yield* new McpAuthenticationError({ reason: 'unsupported' });
            if (
              !('type' in resolved) &&
              (server.connection?.transport !== 'stdio' ||
                server.connection.command !== resolved.command ||
                JSON.stringify(server.connection.args ?? []) !== JSON.stringify(resolved.args))
            )
              return yield* new McpAuthenticationError({ reason: 'unsupported' });
            if (!own && server.connection?.authentication === 'local')
              return yield* new McpAuthenticationError({ reason: 'oauth_required' });
            if (!('type' in resolved)) {
              const record = own ? yield* locked(server, read(server)) : undefined;
              if (server.connection?.authentication === 'local' && !record)
                return yield* new McpAuthenticationError({ reason: 'oauth_required' });
              return {
                ...resolved,
                env: Object.entries({
                  ...Object.fromEntries(resolved.env.map(({ name, value }) => [name, value])),
                  ...record?.settings.env,
                }).map(([name, value]) => ({ name, value })),
              };
            }
            if (own && server.connection?.authentication === 'local') yield* headers(server);
            const leaseKey = JSON.stringify([owner, server.id, targetOf(server)]);
            const previous = leases.get(leaseKey);
            if (previous) return previous.server;
            const leaseScope = yield* Scope.fork(scope);
            const queue = yield* Queue.bounded<McpRelayRequest>(32);
            const endpoint = yield* Effect.acquireRelease(
              external(() => options.io.relay((job) => Queue.offerUnsafe(queue, job))),
              (acquired) =>
                external(() => acquired.close()).pipe(Effect.timeout('5 seconds'), Effect.orDie)
            ).pipe(
              Effect.provideService(Scope.Scope, leaseScope),
              Effect.onError(() => Scope.close(leaseScope, Exit.void))
            );
            const handle = (job: McpRelayRequest) =>
              Effect.gen(function* () {
                const base = Object.fromEntries(
                  resolved.headers.map(({ name, value }) => [name.toLowerCase(), value])
                );
                const credentials = own ? yield* headers(server) : {};
                let response = yield* external((signal) =>
                  options.io.forward(job, resolved.url, { ...base, ...credentials }, signal)
                );
                if (
                  response?.status === 401 &&
                  own &&
                  server.connection?.authentication === 'local'
                ) {
                  const fresh = yield* headers(server, true);
                  response = yield* external((signal) =>
                    options.io.forward(job, resolved.url, { ...base, ...fresh }, signal)
                  );
                }
                if (response) {
                  if (own) yield* observe(server, response);
                  yield* reject(job);
                }
              }).pipe(
                Effect.catch(() => reject(job)),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (!job.response.writableEnded) job.response.destroy();
                  })
                )
              );
            yield* Effect.forEach(
              [0, 1, 2, 3],
              () =>
                Effect.forever(Queue.take(queue).pipe(Effect.flatMap(handle))).pipe(
                  Effect.forkIn(leaseScope)
                ),
              { discard: true }
            );
            const connection: ResolvedMcpServer = {
              type: 'http',
              name: resolved.name,
              url: endpoint.url,
              headers: [{ name: 'Authorization', value: `Bearer ${endpoint.capability}` }],
            };
            leases.set(leaseKey, {
              owner,
              key: keyOf(server),
              scope: leaseScope,
              server: connection,
            });
            return connection;
          })
        );
      const release = (owner: string) =>
        Effect.gen(function* () {
          closedOwners.add(owner);
          yield* revokeLeases((lease) => lease.owner === owner);
        });
      const environment = (server: WorkspaceMcpServerMeta) =>
        locked(
          server,
          Effect.gen(function* () {
            const record = yield* read(server);
            if (!record && server.connection?.authentication === 'local')
              return yield* new McpAuthenticationError({ reason: 'oauth_required' });
            return record?.settings.env ?? {};
          })
        );
      const connected = (server: WorkspaceMcpServerMeta) =>
        Effect.gen(function* () {
          if (server.connection?.authentication === 'local') {
            yield* status(server);
            return;
          }
          const references =
            server.connection?.transport === 'http' &&
            (server.connection.bearerToken || Object.keys(server.connection.headers ?? {}).length);
          remember(
            server,
            references ? { ...result('authorized'), mode: 'manual' } : result('not_required')
          );
        });
      return McpAuthentication.of({
        status,
        configure,
        authorize,
        cancel,
        signout,
        observe,
        connected,
        headers,
        environment,
        prepare,
        release,
      });
    })
  );
}
