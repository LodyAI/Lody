import http from 'http';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { Logger, getLogger } from '@/utils/logger';
import { GitHubTokenFetchError } from '@/lib/github-token-manager';
import type { CloudGithubTokenManager } from '@lody/platform';
import { formatErrorMessage } from '@/utils/format-error';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Path to the broker state file. This file contains the current broker URL and token,
 * allowing containers to always find the broker even after CLI restarts.
 */
export const BROKER_STATE_FILE_PATH = path.join(getLodyDataDir(), 'broker.json');

/**
 * Per-workspace broker state file.
 *
 * The shared `broker.json` is last-writer-wins across the workspaces of a fleet
 * process. The credential helper falls back to it when its broker URL refuses a
 * connection (e.g. the broker rebound to a new port), so with the shared file a
 * workspace A session could recover onto workspace B's broker and authenticate
 * through B's token manager. Sessions get their own file so that fallback stays
 * inside the workspace that owns the session.
 */
export const getBrokerStateFilePathForWorkspace = (workspaceId: string): string =>
  path.join(getLodyDataDir(), `broker-${encodeURIComponent(workspaceId)}.json`);
export const LODY_GIT_CRED_BROKER_STATE_FILE_ENV = 'LODY_GIT_CRED_BROKER_STATE_FILE';

/**
 * Path inside containers where the broker state file is mounted.
 */
export const BROKER_STATE_FILE_CONTAINER_PATH = '/home/node/.lody/broker.json';
export const LODY_GIT_CRED_CONTEXT_TOKEN_ENV = 'LODY_GIT_CRED_CONTEXT_TOKEN';

export type GitCredentialBrokerSessionContext = {
  sessionId: string;
  requesterUserId: string;
  machineId: string;
};

export type GitCredentialBrokerEnv = {
  /** URL for same-host access (127.0.0.1) */
  url: string;
  /** Port number the broker is listening on */
  port: number;
  token: string;
};

export const createGitCredentialBrokerHandler = (options: {
  authToken: string;
  tokenManager: CloudGithubTokenManager;
  logger: Logger;
  resolveContext?: (contextToken: string) => GitCredentialBrokerSessionContext | null;
}): http.RequestListener => {
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      // Health check endpoint - no auth required, used for internal liveness checks
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        return;
      }

      if (
        req.method !== 'POST' ||
        ![
          '/git-credential',
          '/github-token',
          '/git-credential/reject',
          '/github-token/reject',
        ].includes(req.url ?? '')
      ) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found', message: 'Endpoint not found.' }));
        return;
      }

      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${options.authToken}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'unauthorized',
            message: 'Invalid or missing authorization token.',
          })
        );
        return;
      }

      const body = await readJson(req);
      const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      const repoFullName = obj && typeof obj.repoFullName === 'string' ? obj.repoFullName : null;
      const contextToken = obj && typeof obj.contextToken === 'string' ? obj.contextToken : null;
      if (!repoFullName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: 'bad_request', message: 'Missing required field: repoFullName.' })
        );
        return;
      }
      const context = contextToken ? (options.resolveContext?.(contextToken) ?? null) : null;
      if (contextToken && !context) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'invalid_context',
            message: 'Invalid or expired GitHub credential context.',
          })
        );
        return;
      }
      if (req.url === '/git-credential/reject' || req.url === '/github-token/reject') {
        const invalidatedToken =
          obj && typeof obj.invalidatedToken === 'string' ? obj.invalidatedToken : undefined;
        options.tokenManager.invalidate(repoFullName, {
          ...(context ? { requesterUserId: context.requesterUserId } : {}),
          ...(invalidatedToken ? { invalidatedToken } : { markPersonalTokenInvalid: true }),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // The git credential protocol does not tell us whether this credential
      // will be used for fetch or push. Session-scoped contexts get requester-bound
      // write tokens; host infrastructure without a context gets the installation token.
      const tokenValue = context
        ? await options.tokenManager.getWriteTokenForRepo(repoFullName, {
            requesterUserId: context.requesterUserId,
            machineId: context.machineId,
          })
        : await options.tokenManager.getAppTokenForRepo(repoFullName);
      if (!tokenValue) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'no_token',
            message: 'No token available for the requested repository.',
          })
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/github-token') {
        res.end(JSON.stringify({ token: tokenValue }));
        return;
      }

      res.end(JSON.stringify({ username: 'x-access-token', password: tokenValue }));
    } catch (error) {
      if (error instanceof GitHubTokenFetchError) {
        options.logger.debug(
          `[git-cred-broker] Token fetch failed for repo: code=${error.code} message="${error.message}"`
        );
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.code, message: error.message }));
        return;
      }
      const errorMessage = formatErrorMessage(error);
      options.logger.debug(`credential broker request failed: ${errorMessage}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message: errorMessage }));
    }
  };
  return (req, res) => {
    void handleRequest(req, res);
  };
};

const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const HEALTH_CHECK_TIMEOUT_MS = 5_000; // 5 seconds

/**
 * Write the broker state to a file so containers can always find the current broker.
 */
const writeBrokerStateFile = (env: GitCredentialBrokerEnv, workspaceId?: string): void => {
  const dir = path.dirname(BROKER_STATE_FILE_PATH);
  mkdirSync(dir, { recursive: true });
  const contents = JSON.stringify({ url: env.url, port: env.port, token: env.token }, null, 2);
  const options = { encoding: 'utf8', mode: 0o600 } as const; // Readable only by owner for security
  // The shared file stays for containers and CLI-restart recovery that only know
  // the legacy path. It is last-writer-wins across workspaces, so the per-workspace
  // file is the one sessions are pointed at.
  writeFileSync(BROKER_STATE_FILE_PATH, contents, options);
  if (workspaceId) {
    writeFileSync(getBrokerStateFilePathForWorkspace(workspaceId), contents, options);
  }
};

const removeFileIfExists = (filePath: string): void => {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Ignore errors during cleanup
  }
};

/**
 * Remove the broker state file on shutdown.
 */
const removeBrokerStateFile = (workspaceId?: string): void => {
  removeFileIfExists(BROKER_STATE_FILE_PATH);
  if (workspaceId) {
    removeFileIfExists(getBrokerStateFilePathForWorkspace(workspaceId));
  }
};

export class GitCredentialBroker {
  private readonly logger: Logger;
  private readonly tokenManager: CloudGithubTokenManager;
  private readonly workspaceId: string | undefined;
  private readonly contexts = new Map<string, GitCredentialBrokerSessionContext>();
  private readonly sessionContextTokens = new Map<string, string>();
  private server: http.Server | null = null;
  private env: GitCredentialBrokerEnv | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private isRecovering = false;

  constructor(options: {
    tokenManager: CloudGithubTokenManager;
    workspaceId?: string;
    logger?: Logger;
  }) {
    this.logger = options.logger ?? getLogger('git-cred-broker');
    this.tokenManager = options.tokenManager;
    this.workspaceId = options.workspaceId;
  }

  /** Path this broker publishes its state to, for callers pointing a session at it. */
  getStateFilePath(): string | undefined {
    return this.workspaceId ? getBrokerStateFilePathForWorkspace(this.workspaceId) : undefined;
  }

  private readonly resolveContext = (
    contextToken: string
  ): GitCredentialBrokerSessionContext | null => this.contexts.get(contextToken) ?? null;

  private createHandler(authToken: string): http.RequestListener {
    return createGitCredentialBrokerHandler({
      authToken,
      tokenManager: this.tokenManager,
      logger: this.logger,
      resolveContext: this.resolveContext,
    });
  }

  async ensureStarted(): Promise<GitCredentialBrokerEnv> {
    if (this.env && this.server) {
      return this.env;
    }

    const token = randomBytes(32).toString('hex');
    const server = http.createServer(this.createHandler(token));

    // Bind to 0.0.0.0 to allow connections from Docker containers via bridge network.
    // Security is provided by the auth token, not IP restriction.
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '0.0.0.0', () => resolve());
      server.once('error', (err) => reject(err));
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Failed to bind credential broker');
    }

    const port = address.port;
    const url = `http://127.0.0.1:${port}`;
    this.server = server;
    this.env = { url, port, token };
    process.env.LODY_GIT_CRED_BROKER_URL = url;
    process.env.LODY_GIT_CRED_BROKER_TOKEN = token;

    // Write state file so containers can always find the current broker
    writeBrokerStateFile(this.env, this.workspaceId);

    this.logger.debug(`Git credential broker listening on 0.0.0.0:${port}`);

    // Start periodic health checks
    this.startHealthCheck();

    return this.env;
  }

  activateSessionContext(context: GitCredentialBrokerSessionContext): string {
    const existingToken = this.sessionContextTokens.get(context.sessionId);
    if (existingToken) {
      const existing = this.contexts.get(existingToken);
      if (
        existing &&
        existing.requesterUserId === context.requesterUserId &&
        existing.machineId === context.machineId
      ) {
        return existingToken;
      }
      // A different requester is taking over this session. Drop the old token
      // so stale subprocesses still holding it via env get invalid_context (403)
      // instead of silently resolving to the new requester's identity.
      this.contexts.delete(existingToken);
    }

    const contextToken = randomBytes(32).toString('hex');
    this.sessionContextTokens.set(context.sessionId, contextToken);
    this.contexts.set(contextToken, context);
    return contextToken;
  }

  /**
   * Check if the broker is healthy by making a request to the /health endpoint.
   * Returns true if the broker responds correctly, false otherwise.
   */
  async checkHealth(): Promise<boolean> {
    if (!this.env || !this.server) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve(false);
      }, HEALTH_CHECK_TIMEOUT_MS);

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: (this.server?.address() as { port: number } | null)?.port,
          path: '/health',
          method: 'GET',
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          clearTimeout(timeoutId);
          resolve(res.statusCode === 200);
          // Drain response body
          res.resume();
        }
      );

      req.on('error', () => {
        clearTimeout(timeoutId);
        resolve(false);
      });

      req.on('timeout', () => {
        clearTimeout(timeoutId);
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  /**
   * Start periodic health checks. If a health check fails, attempt to recover
   * by restarting the broker.
   */
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }

    this.healthCheckTimer = setInterval(() => {
      void (async () => {
        if (this.isRecovering) {
          return;
        }

        const isHealthy = await this.checkHealth();
        if (!isHealthy && this.env) {
          this.logger.debug('Git credential broker health check failed, attempting recovery...');
          await this.recover();
        }
      })();
    }, DEFAULT_HEALTH_CHECK_INTERVAL_MS);

    // Don't prevent process exit
    this.healthCheckTimer.unref();
  }

  /**
   * Stop periodic health checks.
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Attempt to recover the broker by restarting it.
   * Preserves the same auth token and tries to bind to the same port so existing
   * containers can still connect without needing new environment variables.
   */
  private async recover(): Promise<void> {
    if (this.isRecovering) {
      return;
    }

    this.isRecovering = true;
    const previousToken = this.env?.token;
    const previousUrl = this.env?.url;
    // Extract previous port from URL
    const previousPort = previousUrl ? parseInt(new URL(previousUrl).port, 10) : null;

    try {
      // Close the old server if it exists
      if (this.server) {
        const oldServer = this.server;
        this.server = null;
        await new Promise<void>((resolve) => oldServer.close(() => resolve()));
      }

      if (!previousToken) {
        this.logger.error('Cannot recover broker: no previous token available');
        this.env = null;
        delete process.env.LODY_GIT_CRED_BROKER_URL;
        delete process.env.LODY_GIT_CRED_BROKER_TOKEN;
        return;
      }

      // Create a new server with the same token so containers don't need new env
      const server = http.createServer(this.createHandler(previousToken));

      // Try to bind to the same port first so existing containers keep working.
      // If that fails (port in use), fall back to a dynamic port.
      // Bind to 0.0.0.0 to allow container access via bridge network.
      let boundPort: number;
      if (previousPort) {
        try {
          await new Promise<void>((resolve, reject) => {
            server.listen(previousPort, '0.0.0.0', () => resolve());
            server.once('error', (err) => reject(err));
          });
          boundPort = previousPort;
        } catch {
          // Previous port unavailable, try dynamic port
          this.logger.debug(
            `Could not rebind to previous port ${previousPort}, using dynamic port`
          );
          await new Promise<void>((resolve, reject) => {
            server.listen(0, '0.0.0.0', () => resolve());
            server.once('error', (err) => reject(err));
          });
          const address = server.address();
          if (!address || typeof address === 'string') {
            server.close();
            throw new Error('Failed to bind credential broker during recovery');
          }
          boundPort = address.port;
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          server.listen(0, '0.0.0.0', () => resolve());
          server.once('error', (err) => reject(err));
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
          server.close();
          throw new Error('Failed to bind credential broker during recovery');
        }
        boundPort = address.port;
      }

      const url = `http://127.0.0.1:${boundPort}`;
      this.server = server;
      this.env = { url, port: boundPort, token: previousToken };
      process.env.LODY_GIT_CRED_BROKER_URL = url;
      // Token stays the same, but update env in case it was cleared
      process.env.LODY_GIT_CRED_BROKER_TOKEN = previousToken;

      // Update state file so containers can find the new broker
      writeBrokerStateFile(this.env, this.workspaceId);

      if (boundPort === previousPort) {
        this.logger.debug(`Git credential broker recovered on same port ${boundPort}`);
      } else {
        this.logger.debug(
          `Git credential broker recovered on port ${boundPort} (was ${previousPort}). ` +
            `State file updated - containers will use new address.`
        );
      }
    } catch (error) {
      this.logger.error(`Failed to recover git credential broker: ${formatErrorMessage(error)}`);
      this.env = null;
      delete process.env.LODY_GIT_CRED_BROKER_URL;
      delete process.env.LODY_GIT_CRED_BROKER_TOKEN;
      removeBrokerStateFile(this.workspaceId);
    } finally {
      this.isRecovering = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopHealthCheck();
    this.contexts.clear();
    this.sessionContextTokens.clear();

    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    this.env = null;
    delete process.env.LODY_GIT_CRED_BROKER_URL;
    delete process.env.LODY_GIT_CRED_BROKER_TOKEN;
    removeBrokerStateFile(this.workspaceId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const readJson = async (req: http.IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
};
