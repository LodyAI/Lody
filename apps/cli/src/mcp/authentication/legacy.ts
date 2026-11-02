import { Cause, Effect } from 'effect';
import { AsyncEntry } from '@napi-rs/keyring';
import {
  assertPublicMcpServer,
  resolveSessionMcpServers,
  type LocalMachineRpcRequestValidated,
  type McpAuthenticationResult,
  type ResolvedMcpServer,
  type WorkspaceMcpServerMeta,
} from '@lody/shared';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import {
  McpAuthentication,
  McpAuthenticationError,
  mcpAuthenticationLayer,
  type McpCredentialStore,
} from './service';
import { makeMcpAuthenticationIO, type McpAuthenticationIO } from './io';
import { listMcpTools } from '../list-mcp-tools';

export function systemMcpCredentialStore(): McpCredentialStore {
  const operation = <A>(
    key: string,
    action: (entry: AsyncEntry, signal: AbortSignal) => Promise<A>
  ) =>
    Effect.tryPromise({
      try: (signal) =>
        action(
          new AsyncEntry('Lody MCP Authentication', key, { linux: { store: 'secret-service' } }),
          AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        ),
      catch: () => new McpAuthenticationError({ reason: 'storage_unavailable' }),
    });
  return {
    read: (key) => operation(key, (entry, signal) => entry.getPassword(signal)),
    write: (key, value) =>
      operation(key, async (entry, signal) => {
        await entry.setPassword(value, signal);
      }),
    remove: (key) =>
      operation(key, async (entry, signal) => {
        await entry.deleteCredential(signal);
      }),
  };
}

/** @deprecated Promise boundary for SessionManager, local Machine RPC and tool discovery. */
export class McpAuthenticationLegacy {
  private readonly userId: string;
  private readonly io: McpAuthenticationIO;
  private readonly owner;
  constructor(options: {
    machineId: string;
    workspaceId: string;
    userId: string;
    store?: McpCredentialStore;
    io?: McpAuthenticationIO;
  }) {
    this.userId = options.userId;
    this.io = options.io ?? makeMcpAuthenticationIO();
    this.owner = makeApplicationRuntime(
      mcpAuthenticationLayer({
        namespace: JSON.stringify([options.machineId, options.workspaceId, options.userId]),
        userId: options.userId,
        store: options.store ?? systemMcpCredentialStore(),
        io: this.io,
      }),
      { recover: (cause) => Effect.failCause(cause), project: (cause) => Cause.squash(cause) }
    );
  }
  private run<A>(
    f: (service: McpAuthentication['Service']) => Effect.Effect<A, McpAuthenticationError>,
    signal?: AbortSignal
  ) {
    if (this.owner.isClosing())
      return Promise.reject(new Error('MCP authentication is shutting down.'));
    return this.owner.runtime.runPromise(Effect.flatMap(McpAuthentication, f), { signal });
  }
  private connectionTarget(
    server: WorkspaceMcpServerMeta,
    resolved?: ResolvedMcpServer
  ): WorkspaceMcpServerMeta {
    assertPublicMcpServer(server);
    const target =
      resolved ??
      resolveSessionMcpServers({
        catalog: { [server.id]: server },
        selectedIds: [server.id],
        agentCapabilities: { http: true },
        env: process.env,
      }).servers[0];
    if (!target || !server.connection)
      throw new Error('MCP connection configuration is incomplete.');
    const normalized: WorkspaceMcpServerMeta = {
      ...server,
      connection:
        'type' in target && server.connection.transport === 'http'
          ? { ...server.connection, url: target.url }
          : !('type' in target) && server.connection.transport === 'stdio'
            ? { ...server.connection, command: target.command, args: target.args }
            : undefined,
    };
    if (!normalized.connection) throw new Error('MCP connection transport mismatch.');
    assertPublicMcpServer(normalized);
    return normalized;
  }
  status(server: WorkspaceMcpServerMeta) {
    return this.run((service) => service.status(this.connectionTarget(server)));
  }
  async request(
    request: Extract<LocalMachineRpcRequestValidated, { method: 'mcp/authentication' }>
  ): Promise<McpAuthenticationResult> {
    const { server: authoredServer, action, authentication, attemptId } = request.params;
    if (request.params.requesterUserId !== this.userId)
      throw new Error('MCP authentication account mismatch.');
    const server = this.connectionTarget(authoredServer);
    try {
      return await this.run((service) => {
        switch (action) {
          case 'configure':
            if (!authentication || server.connection?.authentication !== 'local')
              return Effect.fail(new McpAuthenticationError({ reason: 'unsupported' }));
            return service.configure(server, authentication);
          case 'authorize':
            return service.authorize(server);
          case 'cancel':
            return service.cancel(server, attemptId);
          case 'signout':
            return service.signout(server);
          case 'status':
            return service.status(server);
        }
        return Effect.fail(new McpAuthenticationError({ reason: 'unsupported' }));
      });
    } catch (error) {
      return {
        type: 'mcp/authentication',
        status: 'error',
        hasCredentials: false,
        reason: error instanceof McpAuthenticationError ? error.reason : 'connection_failed',
      };
    }
  }
  async listTools(authoredServer: WorkspaceMcpServerMeta, requesterUserId?: string) {
    assertPublicMcpServer(authoredServer);
    if (!requesterUserId) return listMcpTools(authoredServer, { env: {} });
    if (requesterUserId !== this.userId) throw new Error('MCP authentication account mismatch.');
    const server = this.connectionTarget(authoredServer);
    const headers =
      server.transport === 'http'
        ? await this.run((service) =>
            service
              .headers(server)
              .pipe(
                Effect.catch((error) =>
                  error.reason === 'oauth_required' || error.reason === 'expired'
                    ? Effect.succeed({})
                    : Effect.fail(error)
                )
              )
          )
        : {};
    const localEnv =
      server.transport === 'stdio' ? await this.run((service) => service.environment(server)) : {};
    const tools = await listMcpTools(server, {
      headers,
      localEnv,
      fetch: async (input, init) => {
        const response = await this.io.fetch(input, {
          ...init,
          redirect: 'error',
          credentials: 'omit',
        });
        if (response.status === 401)
          await this.run(
            (service) => service.observe(server, response),
            init?.signal ?? (input instanceof Request ? input.signal : undefined)
          );
        return response;
      },
    });
    await this.run((service) => service.connected(server));
    return tools;
  }
  prepare(
    server: WorkspaceMcpServerMeta,
    resolved: ResolvedMcpServer,
    owner: string,
    requesterUserId: string
  ) {
    return this.run((service) =>
      service.prepare(this.connectionTarget(server, resolved), resolved, owner, requesterUserId)
    );
  }
  release(owner: string) {
    return this.run((service) => service.release(owner));
  }
  close() {
    return this.owner.closeLegacy();
  }
}
