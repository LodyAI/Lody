import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  getBuiltinMcpProvider,
  type McpHttpConnection,
  type WorkspaceMcpConnectionResult,
  type WorkspaceMcpServerMeta,
  type WorkspaceId,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';
import {
  WorkspaceMcpCredentialStore,
  asOAuthClientInformation,
  asOAuthDiscoveryState,
  asOAuthTokens,
  type StoredWorkspaceMcpBinding,
} from './workspace-mcp-credential-store';

const OAUTH_CALLBACK_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Lody MCP</title><style>body{font:16px system-ui;margin:64px;max-width:560px;line-height:1.5}h1{font-size:22px}</style><h1>Authorization complete</h1><p>You can close this tab and return to Lody.</p>`;

type OAuthTransaction = {
  id: string;
  server: http.Server;
  transport: StreamableHTTPClientTransport;
  expiresAt: number;
  timeout?: NodeJS.Timeout;
};

type MutableOAuthState = {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  codeVerifier?: string;
  authorizationUrl?: URL;
};

export type WorkspaceMcpAuthServiceOptions = {
  store?: WorkspaceMcpCredentialStore;
  fetch?: typeof fetch;
  now?: () => number;
  providerRequestSignal?: () => AbortSignal;
};

type WorkspaceMcpLogger = { debug(message: string): void };

export class WorkspaceMcpAuthService {
  private readonly store: WorkspaceMcpCredentialStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly providerRequestSignal: () => AbortSignal;
  private readonly transactions = new Map<string, OAuthTransaction>();
  private readonly generations = new Map<string, number>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly refreshes = new Map<string, Promise<McpHttpConnection | null>>();
  private readonly connectionTests = new Map<string, Set<Promise<WorkspaceMcpConnectionResult>>>();
  private readonly connectionTestControllers = new Map<string, Set<AbortController>>();
  private readonly orphanedEntryIds = new Set<string>();
  private readonly disconnectingEntryIds = new Set<string>();
  private readonly errors = new Map<string, string>();
  private disposed = false;
  private disposePromise?: Promise<void>;

  constructor(
    private readonly workspaceId: WorkspaceId,
    private readonly userId: string,
    private readonly logger: WorkspaceMcpLogger,
    options: WorkspaceMcpAuthServiceOptions = {}
  ) {
    this.store = options.store ?? new WorkspaceMcpCredentialStore();
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.providerRequestSignal =
      options.providerRequestSignal ?? (() => AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS));
  }

  async status(entry: WorkspaceMcpServerMeta): Promise<WorkspaceMcpConnectionResult> {
    this.assertEntryAvailable(entry);
    const provider = this.getProvider(entry);
    const key = this.bindingKey(entry);
    const transaction = this.transactions.get(key);
    if (transaction && transaction.expiresAt > this.now()) {
      return {
        type: 'workspace-mcp/connection-status',
        mcpServerId: entry.id,
        providerId: provider.id,
        state: 'authorizing',
      };
    }
    if (transaction) {
      this.nextGeneration(key);
      await this.closeTransaction(key, transaction.id);
      this.assertEntryAvailable(entry);
    }

    const binding = await this.store.get(key);
    this.assertEntryAvailable(entry);
    const error = this.errors.get(key);
    if (!binding) {
      return {
        type: 'workspace-mcp/connection-status',
        mcpServerId: entry.id,
        providerId: provider.id,
        state: error ? 'error' : 'not_connected',
        ...(error ? { error } : {}),
      };
    }
    if (!this.bindingMatches(entry, binding)) {
      return {
        type: 'workspace-mcp/connection-status',
        mcpServerId: entry.id,
        providerId: provider.id,
        state: 'not_connected',
        error: 'The connector definition changed. Authorize it again.',
      };
    }
    if (binding.kind === 'secret_url') {
      return {
        type: 'workspace-mcp/connection-status',
        mcpServerId: entry.id,
        providerId: provider.id,
        state: 'connected',
        connectedAt: binding.connectedAt,
      };
    }
    const expiresAt = this.oauthExpiresAt(binding);
    return {
      type: 'workspace-mcp/connection-status',
      mcpServerId: entry.id,
      providerId: provider.id,
      state:
        expiresAt !== undefined && expiresAt <= this.now() && !binding.tokens.refresh_token
          ? 'expired'
          : 'connected',
      connectedAt: binding.connectedAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(error ? { error } : {}),
    };
  }

  async startOAuth(entry: WorkspaceMcpServerMeta): Promise<WorkspaceMcpConnectionResult> {
    this.assertEntryAvailable(entry);
    const key = this.bindingKey(entry);
    return await this.withBindingOperation(key, async () => {
      const generation = this.nextGeneration(key);
      return await this.startOAuthLocked(entry, generation);
    });
  }

  private async startOAuthLocked(
    entry: WorkspaceMcpServerMeta,
    generation: number
  ): Promise<WorkspaceMcpConnectionResult> {
    const provider = this.getProvider(entry);
    if (provider.authKind !== 'mcp_oauth' || !provider.endpoint) {
      return this.error(entry, 'wrong_auth_kind', 'This connector does not use OAuth.', false);
    }

    const key = this.bindingKey(entry);
    await this.closeTransaction(key);
    this.errors.delete(key);
    const state = randomBytes(32).toString('base64url');
    const mutable: MutableOAuthState = {};
    const transactionId = randomBytes(16).toString('base64url');
    const callback = await this.createCallbackServer(entry, state, transactionId);
    if (this.disposed) {
      await this.closeServer(callback.server);
      this.assertActive();
    }
    this.assertEntryAvailable(entry);
    const redirectUrl = `http://127.0.0.1:${callback.port}/oauth/callback`;
    const oauthProvider = this.createOAuthProvider(
      entry,
      redirectUrl,
      state,
      mutable,
      undefined,
      generation
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.endpointFor(entry)), {
      authProvider: oauthProvider,
      fetch: this.providerFetch(entry),
    });
    const expiresAt = this.now() + OAUTH_CALLBACK_TTL_MS;
    this.transactions.set(key, {
      id: transactionId,
      server: callback.server,
      transport,
      expiresAt,
    });
    callback.setTransport(transport);

    let connectError: unknown;
    try {
      const client = new Client({ name: 'lody', version: '1.0.0' });
      await client.connect(transport);
    } catch (error) {
      connectError = error;
      // An auth-required transport intentionally rejects after producing the
      // authorization URL. Validate that redirectToAuthorization actually ran.
    }
    this.assertEntryAvailable(entry);
    if (!mutable.authorizationUrl) {
      await this.closeTransaction(key, transactionId);
      return this.error(
        entry,
        'provider_error',
        connectError
          ? `The provider did not return an OAuth authorization URL: ${formatErrorMessage(connectError)}`
          : 'The provider did not return an OAuth authorization URL.',
        true
      );
    }

    const timeout = setTimeout(() => {
      if (this.transactions.get(key)?.id !== transactionId) return;
      this.nextGeneration(key);
      this.errors.set(key, 'OAuth authorization timed out.');
      void this.closeTransaction(key, transactionId);
    }, OAUTH_CALLBACK_TTL_MS);
    timeout.unref();
    const transaction = this.transactions.get(key);
    if (transaction?.id === transactionId) transaction.timeout = timeout;

    return {
      type: 'workspace-mcp/oauth-started',
      mcpServerId: entry.id,
      providerId: provider.id,
      authorizationUrl: mutable.authorizationUrl.toString(),
      expiresAt,
    };
  }

  async setSecretUrl(
    entry: WorkspaceMcpServerMeta,
    rawUrl: string
  ): Promise<WorkspaceMcpConnectionResult> {
    this.assertEntryAvailable(entry);
    const key = this.bindingKey(entry);
    return await this.withBindingOperation(key, async () => {
      const generation = this.nextGeneration(key);
      await this.closeTransaction(key);
      this.assertEntryAvailable(entry);
      return await this.setSecretUrlLocked(entry, rawUrl, generation);
    });
  }

  private async setSecretUrlLocked(
    entry: WorkspaceMcpServerMeta,
    rawUrl: string,
    generation: number
  ): Promise<WorkspaceMcpConnectionResult> {
    const provider = this.getProvider(entry);
    if (provider.authKind !== 'provider_secret_url') {
      return this.error(
        entry,
        'wrong_auth_kind',
        'This connector does not use a secret URL.',
        false
      );
    }
    const url = this.parseFeishuSecretUrl(rawUrl);
    if (!url) {
      return this.error(
        entry,
        'invalid_secret_url',
        'Enter the HTTPS MCP URL generated by Feishu Open Platform.',
        false
      );
    }
    const connectedAt = this.now();
    const key = this.bindingKey(entry);
    const credentialId = randomBytes(16).toString('base64url');
    this.assertEntryAvailable(entry);
    await this.store.set(key, {
      kind: 'secret_url',
      url: url.toString(),
      authorizationFingerprint: this.authorizationFingerprint(entry),
      credentialId,
      connectedAt,
    });
    if (this.disposed || this.currentGeneration(key) !== generation) {
      await this.store.deleteIf(key, (binding) => binding.credentialId === credentialId);
      this.assertActive();
      throw new Error('This connector update is no longer active.');
    }
    this.errors.delete(key);
    return {
      type: 'workspace-mcp/connection-status',
      mcpServerId: entry.id,
      providerId: provider.id,
      state: 'connected',
      connectedAt,
    };
  }

  async disconnect(entry: WorkspaceMcpServerMeta): Promise<WorkspaceMcpConnectionResult> {
    const provider = this.getProvider(entry);
    const key = this.bindingKey(entry);
    return await this.withBindingOperation(key, async () => {
      this.disconnectingEntryIds.add(entry.id);
      try {
        this.nextGeneration(key);
        await this.closeTransaction(key);
        await this.abortAndDrainConnectionTests(
          key,
          new Error('This Workspace MCP connector is being disconnected.')
        );
        this.assertActive();
        await this.store.delete(key);
        this.assertActive();
        this.errors.delete(key);
        return {
          type: 'workspace-mcp/connection-status',
          mcpServerId: entry.id,
          providerId: provider.id,
          state: 'not_connected',
        };
      } finally {
        this.disconnectingEntryIds.delete(entry.id);
      }
    });
  }

  async test(entry: WorkspaceMcpServerMeta): Promise<WorkspaceMcpConnectionResult> {
    this.assertEntryAvailable(entry);
    const key = this.bindingKey(entry);
    const controller = new AbortController();
    const pending = this.testConnection(entry, controller.signal);
    const controllers = this.connectionTestControllers.get(key) ?? new Set<AbortController>();
    const tests = this.connectionTests.get(key) ?? new Set<Promise<WorkspaceMcpConnectionResult>>();
    controllers.add(controller);
    tests.add(pending);
    this.connectionTestControllers.set(key, controllers);
    this.connectionTests.set(key, tests);
    try {
      return await pending;
    } finally {
      controllers.delete(controller);
      tests.delete(pending);
      if (controllers.size === 0) this.connectionTestControllers.delete(key);
      if (tests.size === 0) this.connectionTests.delete(key);
    }
  }

  private async testConnection(
    entry: WorkspaceMcpServerMeta,
    lifecycleSignal: AbortSignal
  ): Promise<WorkspaceMcpConnectionResult> {
    try {
      const connection = await this.resolveConnection(entry);
      if (!connection) {
        return this.error(entry, 'provider_error', 'Connect this provider first.', false);
      }
      const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: {
          headers: connection.headers,
        },
        fetch: this.boundedFetch(entry, lifecycleSignal),
      });
      const client = new Client({ name: 'lody-mcp-connection-test', version: '1.0.0' });
      try {
        await client.connect(transport);
        await client.listTools();
      } finally {
        await client.close().catch(() => undefined);
      }
      return await this.status(entry);
    } catch (error) {
      this.assertEntryAvailable(entry);
      const message = formatErrorMessage(error);
      this.errors.set(this.bindingKey(entry), message);
      return this.error(entry, 'provider_error', message, true);
    }
  }

  async resolveConnection(entry: WorkspaceMcpServerMeta): Promise<McpHttpConnection | null> {
    this.assertEntryAvailable(entry);
    const provider = this.getProvider(entry);
    const key = this.bindingKey(entry);
    const binding = await this.store.get(key);
    this.assertEntryAvailable(entry);
    if (!binding) return null;
    if (!this.bindingMatches(entry, binding)) return null;
    if (binding.kind === 'secret_url') {
      return { transport: 'http', url: binding.url };
    }
    if (provider.authKind !== 'mcp_oauth') return null;

    const expiresAt = this.oauthExpiresAt(binding);
    if (expiresAt !== undefined && expiresAt <= this.now() + TOKEN_REFRESH_SKEW_MS) {
      const existing = this.refreshes.get(key);
      if (existing) return await existing;
      const refresh = this.refreshConnection(entry, binding).finally(() => {
        if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
      });
      this.refreshes.set(key, refresh);
      return await refresh;
    }
    return {
      transport: 'http',
      url: this.endpointFor(entry),
      headers: { Authorization: `Bearer ${binding.tokens.access_token}` },
    };
  }

  private boundedFetch(entry: WorkspaceMcpServerMeta, lifecycleSignal: AbortSignal): typeof fetch {
    return async (input, init) => {
      this.assertEntryAvailable(entry);
      const signals = [lifecycleSignal, this.providerRequestSignal()];
      if (init?.signal) signals.push(init.signal);
      return await this.fetchImpl(input, {
        ...init,
        signal: AbortSignal.any(signals),
      });
    };
  }

  private async refreshConnection(
    entry: WorkspaceMcpServerMeta,
    observed: Extract<StoredWorkspaceMcpBinding, { kind: 'oauth' }>
  ): Promise<McpHttpConnection | null> {
    const key = this.bindingKey(entry);
    const latest = await this.store.get(key);
    this.assertEntryAvailable(entry);
    if (!latest || latest.kind !== 'oauth' || !this.bindingMatches(entry, latest)) return null;
    const latestExpiry = this.oauthExpiresAt(latest);
    if (
      latest.savedAt !== observed.savedAt &&
      latestExpiry &&
      latestExpiry > this.now() + TOKEN_REFRESH_SKEW_MS
    ) {
      return {
        transport: 'http',
        url: this.endpointFor(entry),
        headers: { Authorization: `Bearer ${latest.tokens.access_token}` },
      };
    }
    if (!latest.tokens.refresh_token) return null;
    const generation = this.currentGeneration(key);
    const mutable: MutableOAuthState = {
      tokens: asOAuthTokens(latest),
      clientInformation: asOAuthClientInformation(latest),
      discoveryState: asOAuthDiscoveryState(latest),
    };
    const oauthProvider = this.createOAuthProvider(
      entry,
      latest.redirectUrl,
      randomBytes(32).toString('base64url'),
      mutable,
      latest.connectedAt,
      generation,
      latest.credentialId
    );
    const result = await auth(oauthProvider, {
      serverUrl: this.endpointFor(entry),
      fetchFn: this.providerFetch(entry, mutable.discoveryState !== undefined),
    });
    this.assertEntryAvailable(entry);
    if (result !== 'AUTHORIZED') return null;
    const refreshed = await this.store.get(key);
    if (!refreshed || refreshed.kind !== 'oauth' || !this.bindingMatches(entry, refreshed)) {
      return null;
    }
    return {
      transport: 'http',
      url: this.endpointFor(entry),
      headers: { Authorization: `Bearer ${refreshed.tokens.access_token}` },
    };
  }

  private async createCallbackServer(
    entry: WorkspaceMcpServerMeta,
    expectedState: string,
    transactionId: string
  ): Promise<{
    server: http.Server;
    port: number;
    setTransport(transport: StreamableHTTPClientTransport): void;
  }> {
    let transport: StreamableHTTPClientTransport | undefined;
    let claimed = false;
    const server = http.createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (request.method !== 'GET' || url.pathname !== '/oauth/callback') {
          response.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const providerError = url.searchParams.get('error');
        if (this.disposed) {
          response
            .writeHead(410, { 'content-type': 'text/plain; charset=utf-8' })
            .end('This OAuth authorization is no longer active.');
          return;
        }
        if (state !== expectedState) {
          response
            .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            .end('OAuth callback validation failed.');
          return;
        }
        if (claimed) {
          response
            .writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
            .end('This OAuth callback has already been used.');
          return;
        }
        const transaction = this.transactions.get(this.bindingKey(entry));
        if (transaction?.id !== transactionId) {
          response
            .writeHead(410, { 'content-type': 'text/plain; charset=utf-8' })
            .end('This OAuth authorization is no longer active.');
          return;
        }
        claimed = true;
        if (!code || providerError || !transport) {
          const message = providerError
            ? `OAuth authorization failed: ${providerError}`
            : 'OAuth callback validation failed.';
          this.errors.set(this.bindingKey(entry), message);
          response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
          await this.closeTransaction(this.bindingKey(entry), transactionId);
          return;
        }
        if (transaction.timeout) {
          clearTimeout(transaction.timeout);
          transaction.timeout = undefined;
        }
        try {
          await transport.finishAuth(code);
          this.errors.delete(this.bindingKey(entry));
          response
            .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            .end(CALLBACK_HTML);
        } catch (error) {
          const message = formatErrorMessage(error);
          this.errors.set(this.bindingKey(entry), message);
          response
            .writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            .end('Authorization could not be completed. Return to Lody and try again.');
          this.logger.debug(`[workspace-mcp] OAuth callback failed: ${message}`);
        } finally {
          await this.closeTransaction(this.bindingKey(entry), transactionId);
        }
      })().catch((error) => {
        this.logger.debug(
          `[workspace-mcp] OAuth callback handler failed: ${formatErrorMessage(error)}`
        );
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    if (this.disposed) {
      await this.closeServer(server);
      this.assertActive();
    }
    const address = server.address() as AddressInfo;
    return {
      server,
      port: address.port,
      setTransport: (next) => {
        transport = next;
      },
    };
  }

  private createOAuthProvider(
    entry: WorkspaceMcpServerMeta,
    redirectUrl: string,
    state: string,
    mutable: MutableOAuthState,
    connectedAt = this.now(),
    generation = this.currentGeneration(this.bindingKey(entry)),
    expectedCredentialId?: string
  ): OAuthClientProvider {
    const provider = this.getProvider(entry);
    const clientMetadata: OAuthClientMetadata = {
      client_name: 'Lody',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    return {
      redirectUrl,
      clientMetadata,
      state: () => state,
      clientInformation: () => mutable.clientInformation,
      saveClientInformation: (information) => {
        mutable.clientInformation = information;
      },
      tokens: () => mutable.tokens,
      saveTokens: async (tokens) => {
        this.assertEntryAvailable(entry);
        if (this.currentGeneration(this.bindingKey(entry)) !== generation) {
          throw new Error('This OAuth authorization is no longer active.');
        }
        const merged: OAuthTokens = {
          ...tokens,
          ...(tokens.refresh_token || !mutable.tokens?.refresh_token
            ? {}
            : { refresh_token: mutable.tokens.refresh_token }),
        };
        mutable.tokens = merged;
        const credentialId = randomBytes(16).toString('base64url');
        await this.store.set(this.bindingKey(entry), {
          kind: 'oauth',
          tokens: merged,
          ...(mutable.clientInformation
            ? {
                clientInformation: mutable.clientInformation as unknown as Record<string, unknown>,
              }
            : {}),
          ...(mutable.discoveryState
            ? { discoveryState: mutable.discoveryState as unknown as Record<string, unknown> }
            : {}),
          redirectUrl,
          authorizationFingerprint: this.authorizationFingerprint(entry),
          credentialId,
          savedAt: this.now(),
          connectedAt,
        });
        if (this.disposed || this.currentGeneration(this.bindingKey(entry)) !== generation) {
          await this.store.deleteIf(
            this.bindingKey(entry),
            (binding) => binding.credentialId === credentialId
          );
          this.assertEntryAvailable(entry);
          throw new Error('This OAuth authorization is no longer active.');
        }
      },
      redirectToAuthorization: (authorizationUrl) => {
        this.assertAllowedOAuthUrl(entry, authorizationUrl);
        mutable.authorizationUrl = authorizationUrl;
      },
      saveCodeVerifier: (verifier) => {
        mutable.codeVerifier = verifier;
      },
      codeVerifier: () => {
        if (!mutable.codeVerifier) throw new Error('OAuth PKCE verifier is unavailable.');
        return mutable.codeVerifier;
      },
      saveDiscoveryState: (discoveryState) => {
        mutable.discoveryState = discoveryState;
      },
      discoveryState: () => mutable.discoveryState,
      invalidateCredentials: async (scope) => {
        if (scope === 'all' || scope === 'tokens') mutable.tokens = undefined;
        if (scope === 'all' || scope === 'client') mutable.clientInformation = undefined;
        if (scope === 'all' || scope === 'verifier') mutable.codeVerifier = undefined;
        if (scope === 'all' || scope === 'discovery') mutable.discoveryState = undefined;
        if (
          !this.disposed &&
          this.currentGeneration(this.bindingKey(entry)) === generation &&
          (scope === 'all' || scope === 'tokens') &&
          expectedCredentialId !== undefined
        ) {
          await this.store.deleteIf(
            this.bindingKey(entry),
            (binding) => binding.kind === 'oauth' && binding.credentialId === expectedCredentialId
          );
        }
      },
      validateResourceURL: async (_serverUrl, resource) => {
        if (!resource) return undefined;
        const candidate = new URL(resource);
        const expected = new URL(this.oauthResourceFor(entry));
        if (candidate.toString() !== expected.toString()) {
          throw new Error(`OAuth resource mismatch for ${provider.displayName}.`);
        }
        return candidate;
      },
    };
  }

  private endpointFor(entry: WorkspaceMcpServerMeta): string {
    const provider = this.getProvider(entry);
    if (!provider.endpoint) throw new Error(`${provider.displayName} has no OAuth endpoint.`);
    if (provider.id === 'linear' && entry.source?.accessProfile === 'read_write') {
      return 'https://mcp.linear.app/mcp';
    }
    if (provider.id === 'posthog') {
      const url = new URL(provider.endpoint);
      url.searchParams.set('mode', String(entry.source?.publicOptions?.mode ?? 'cli'));
      url.searchParams.set('readonly', String(entry.source?.accessProfile !== 'read_write'));
      return url.toString();
    }
    return provider.endpoint;
  }

  private oauthResourceFor(entry: WorkspaceMcpServerMeta): string {
    const provider = this.getProvider(entry);
    return provider.oauthResource ?? this.endpointFor(entry);
  }

  private providerFetch(
    entry: WorkspaceMcpServerMeta,
    hasValidatedDiscoveryState = false
  ): typeof fetch {
    let protectedResourceValidated = hasValidatedDiscoveryState;
    let fatalPolicyError: unknown;
    return async (input, init) => {
      this.assertEntryAvailable(entry);
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (fatalPolicyError) throw fatalPolicyError;
      try {
        this.assertAllowedOAuthUrl(entry, url);
      } catch (error) {
        fatalPolicyError = error;
        throw error;
      }
      const isProtectedResourceMetadata = url.pathname.includes('oauth-protected-resource');
      const isPinnedMcpEndpoint = url.toString() === new URL(this.endpointFor(entry)).toString();
      if (!protectedResourceValidated && !isProtectedResourceMetadata && !isPinnedMcpEndpoint) {
        fatalPolicyError = new Error(
          `OAuth protected resource metadata is required for ${this.getProvider(entry).displayName}.`
        );
        throw fatalPolicyError;
      }
      const timeoutSignal = this.providerRequestSignal();
      const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      const response = await this.fetchImpl(input, {
        ...init,
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(
          `OAuth redirects are not allowed for ${this.getProvider(entry).displayName}.`
        );
      }
      try {
        await this.validateOAuthMetadataResponse(entry, url, response);
        const normalized = await this.applyOAuthMetadataPolicy(entry, url, response);
        if (isProtectedResourceMetadata && response.ok) protectedResourceValidated = true;
        return normalized;
      } catch (error) {
        fatalPolicyError = error;
        throw error;
      }
    };
  }

  private async applyOAuthMetadataPolicy(
    entry: WorkspaceMcpServerMeta,
    requestUrl: URL,
    response: Response
  ): Promise<Response> {
    if (
      !response.ok ||
      !requestUrl.pathname.includes('oauth-protected-resource') ||
      entry.source?.kind !== 'builtin' ||
      entry.source.providerId !== 'posthog' ||
      entry.source.accessProfile !== 'readonly'
    ) {
      return response;
    }
    const payload = (await response.clone().json()) as Record<string, unknown>;
    if (!Array.isArray(payload.scopes_supported)) {
      throw new Error('PostHog OAuth metadata has no scope list.');
    }
    const scopes = payload.scopes_supported.filter(
      (scope): scope is string =>
        typeof scope === 'string' &&
        (scope === 'openid' || scope === 'profile' || scope === 'email' || scope.endsWith(':read'))
    );
    if (scopes.length === 0) {
      throw new Error('PostHog OAuth metadata has no read-only scopes.');
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    return new Response(JSON.stringify({ ...payload, scopes_supported: scopes }), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  private assertAllowedOAuthUrl(entry: WorkspaceMcpServerMeta, url: URL): void {
    const provider = this.getProvider(entry);
    const allowedOrigins = provider.oauthAllowedOrigins ?? [];
    if (url.protocol !== 'https:' || !allowedOrigins.includes(url.origin)) {
      throw new Error(`OAuth URL is not allowed for ${provider.displayName}.`);
    }
  }

  private async validateOAuthMetadataResponse(
    entry: WorkspaceMcpServerMeta,
    requestUrl: URL,
    response: Response
  ): Promise<void> {
    if (!response.ok || !requestUrl.pathname.includes('/.well-known/')) return;
    const payload = (await response.clone().json()) as Record<string, unknown>;
    if (requestUrl.pathname.includes('oauth-protected-resource')) {
      if (payload.resource !== this.oauthResourceFor(entry)) {
        throw new Error(
          `OAuth protected resource mismatch for ${this.getProvider(entry).displayName}.`
        );
      }
      const authorizationServers = payload.authorization_servers;
      if (
        !Array.isArray(authorizationServers) ||
        authorizationServers.length === 0 ||
        authorizationServers.some((value) => {
          if (typeof value !== 'string') return true;
          try {
            this.assertAllowedOAuthUrl(entry, new URL(value));
            return false;
          } catch {
            return true;
          }
        })
      ) {
        throw new Error(
          `OAuth authorization server is not allowed for ${this.getProvider(entry).displayName}.`
        );
      }
      return;
    }
    if (
      requestUrl.pathname.includes('oauth-authorization-server') ||
      requestUrl.pathname.includes('openid-configuration')
    ) {
      if (typeof payload.issuer !== 'string') {
        throw new Error('OAuth authorization metadata has no issuer.');
      }
      const issuer = new URL(payload.issuer);
      this.assertAllowedOAuthUrl(entry, issuer);
      const expectedIssuer = this.getProvider(entry).oauthIssuer;
      if (
        !expectedIssuer ||
        issuer.toString() !== new URL(expectedIssuer).toString() ||
        issuer.origin !== requestUrl.origin
      ) {
        throw new Error(`OAuth issuer mismatch for ${this.getProvider(entry).displayName}.`);
      }
      for (const field of [
        'authorization_endpoint',
        'token_endpoint',
        'registration_endpoint',
      ] as const) {
        const value = payload[field];
        if (value !== undefined) {
          if (typeof value !== 'string') throw new Error(`OAuth ${field} is invalid.`);
          this.assertAllowedOAuthUrl(entry, new URL(value));
        }
      }
    }
  }

  private authorizationFingerprint(entry: WorkspaceMcpServerMeta): string {
    if (entry.source?.kind !== 'builtin') throw new Error('Workspace MCP entry is not built in.');
    const publicOptions = Object.fromEntries(
      Object.entries(entry.source.publicOptions ?? {}).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    );
    return JSON.stringify({
      providerId: entry.source.providerId,
      presetVersion: entry.source.presetVersion,
      accessProfile: entry.source.accessProfile,
      publicOptions,
      endpoint: this.getProvider(entry).endpoint ? this.endpointFor(entry) : null,
      oauthResource: this.getProvider(entry).endpoint ? this.oauthResourceFor(entry) : null,
      issuer: this.getProvider(entry).oauthIssuer ?? null,
    });
  }

  private bindingMatches(
    entry: WorkspaceMcpServerMeta,
    binding: StoredWorkspaceMcpBinding
  ): boolean {
    return binding.authorizationFingerprint === this.authorizationFingerprint(entry);
  }

  async removeOrphanedBindings(validEntryIds: ReadonlySet<string>): Promise<void> {
    const prefix = `${this.userId}:${this.workspaceId}:`;
    const cleanupKey = `${prefix}orphan-cleanup`;
    await this.withBindingOperation(cleanupKey, async () => {
      for (const validEntryId of validEntryIds) this.orphanedEntryIds.delete(validEntryId);
      const storedKeys = await this.store.keys(prefix);
      this.assertActive();
      const keys = new Set([
        ...storedKeys,
        ...this.transactions.keys(),
        ...this.refreshes.keys(),
        ...this.connectionTests.keys(),
        ...this.connectionTestControllers.keys(),
        ...this.operationTails.keys(),
      ]);
      const orphanKeys = [...keys].filter(
        (key) =>
          key !== cleanupKey &&
          key.startsWith(prefix) &&
          !validEntryIds.has(key.slice(prefix.length))
      );
      for (const key of orphanKeys) this.orphanedEntryIds.add(key.slice(prefix.length));
      await Promise.all(
        orphanKeys.map((key) =>
          this.withBindingOperation(key, async () => {
            this.nextGeneration(key);
            const transaction = this.transactions.get(key);
            const refresh = this.refreshes.get(key);
            const tests = [...(this.connectionTests.get(key) ?? [])];
            for (const controller of this.connectionTestControllers.get(key) ?? []) {
              controller.abort(
                new Error('This Workspace MCP connector is no longer in the catalog.')
              );
            }
            if (transaction) await this.closeTransaction(key, transaction.id);
            if (refresh) await refresh.catch(() => null);
            await Promise.allSettled(tests);
            this.assertActive();
            await this.store.delete(key);
            this.assertActive();
          })
        )
      );
      this.assertActive();
    });
  }

  async hasStoredBindings(): Promise<boolean> {
    this.assertActive();
    const prefix = `${this.userId}:${this.workspaceId}:`;
    const keys = await this.store.keys(prefix);
    this.assertActive();
    return keys.length > 0;
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true;
      this.disposePromise = this.disposeActiveOperations();
    }
    await this.disposePromise;
  }

  private async disposeActiveOperations(): Promise<void> {
    for (const controllers of this.connectionTestControllers.values()) {
      for (const controller of controllers) {
        controller.abort(new Error('Workspace MCP authorization service is disposed.'));
      }
    }
    const keys = new Set([
      ...this.generations.keys(),
      ...this.transactions.keys(),
      ...this.operationTails.keys(),
      ...this.refreshes.keys(),
      ...this.connectionTests.keys(),
      ...this.connectionTestControllers.keys(),
    ]);
    for (const key of keys) this.nextGeneration(key);

    const pending = [
      ...this.operationTails.values(),
      ...this.refreshes.values(),
      ...[...this.connectionTests.values()].flatMap((tests) => [...tests]),
    ];
    const transactions = [...this.transactions.entries()];
    await Promise.allSettled([
      ...pending,
      ...transactions.map(([key, transaction]) => this.closeTransaction(key, transaction.id)),
    ]);

    const lateTransactions = [...this.transactions.entries()];
    await Promise.allSettled(
      lateTransactions.map(([key, transaction]) => this.closeTransaction(key, transaction.id))
    );
    this.errors.clear();
  }

  private parseFeishuSecretUrl(rawUrl: string): URL | null {
    try {
      const url = new URL(rawUrl.trim());
      const hostname = url.hostname.toLowerCase();
      const allowed =
        hostname === 'feishu.cn' ||
        hostname.endsWith('.feishu.cn') ||
        hostname === 'larksuite.com' ||
        hostname.endsWith('.larksuite.com');
      return url.protocol === 'https:' && allowed && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  private oauthExpiresAt(
    binding: Extract<StoredWorkspaceMcpBinding, { kind: 'oauth' }>
  ): number | undefined {
    return binding.tokens.expires_in === undefined
      ? undefined
      : binding.savedAt + binding.tokens.expires_in * 1_000;
  }

  private getProvider(entry: WorkspaceMcpServerMeta) {
    if (entry.source?.kind !== 'builtin') throw new Error('Workspace MCP entry is not built in.');
    return getBuiltinMcpProvider(entry.source.providerId);
  }

  private bindingKey(entry: WorkspaceMcpServerMeta): string {
    return `${this.userId}:${this.workspaceId}:${entry.id}`;
  }

  private currentGeneration(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private nextGeneration(key: string): number {
    const generation = this.currentGeneration(key) + 1;
    this.generations.set(key, generation);
    return generation;
  }

  private async abortAndDrainConnectionTests(key: string, reason: Error): Promise<void> {
    const tests = [...(this.connectionTests.get(key) ?? [])];
    for (const controller of this.connectionTestControllers.get(key) ?? []) {
      controller.abort(reason);
    }
    await Promise.allSettled(tests);
  }

  private async withBindingOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const previous = this.operationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.operationTails.set(key, tail);
    await previous;
    try {
      this.assertActive();
      return await operation();
    } finally {
      release();
      if (this.operationTails.get(key) === tail) this.operationTails.delete(key);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Workspace MCP authorization service is disposed.');
  }

  private assertEntryAvailable(entry: WorkspaceMcpServerMeta): void {
    this.assertActive();
    if (this.disconnectingEntryIds.has(entry.id)) {
      throw new Error('This Workspace MCP connector is being disconnected.');
    }
    if (this.orphanedEntryIds.has(entry.id)) {
      throw new Error('This Workspace MCP connector is no longer in the catalog.');
    }
  }

  private error(
    entry: WorkspaceMcpServerMeta,
    code: Extract<WorkspaceMcpConnectionResult, { type: 'workspace-mcp/connection-error' }>['code'],
    message: string,
    retryable: boolean
  ): WorkspaceMcpConnectionResult {
    return {
      type: 'workspace-mcp/connection-error',
      mcpServerId: entry.id,
      code,
      message,
      retryable,
    };
  }

  private async closeTransaction(key: string, expectedId?: string): Promise<void> {
    const transaction = this.transactions.get(key);
    if (!transaction) return;
    if (expectedId !== undefined && transaction.id !== expectedId) return;
    this.transactions.delete(key);
    if (transaction.timeout) clearTimeout(transaction.timeout);
    await transaction.transport.close().catch(() => undefined);
    await this.closeServer(transaction.server);
  }

  private async closeServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
  }
}
