import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
  type PreviewTarget,
  type PreviewCloseReason,
  type SessionId,
  type SessionPreviewEndpoint,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { getCliHttpFetch } from '@/utils/http-transport';
import { ensureCloudflaredBinary } from './cloudflared-binary';
import { startCloudflaredProcess, type CloudflaredProcess } from './cloudflared-process';
import { LocalPreviewProxyManager } from './local-preview-proxy';
import { verifyPreviewTunnelRoundTrip } from './preview-tunnel-readiness';

export type { PreviewCloseReason } from '@lody/shared';
export type QuickTunnelClosed = { reason?: PreviewCloseReason; error?: Error };

type Options = {
  sessionId: SessionId;
  target: PreviewTarget;
  connectionAddress?: string;
  runtimeBaseUrl: string;
  logger: Logger;
  now: () => number;
  download?: typeof ensureCloudflaredBinary;
  start?: typeof startCloudflaredProcess;
  verify?: typeof verifyPreviewTunnelRoundTrip;
};

class PreviewStopped extends Error {
  constructor(readonly reason: PreviewCloseReason) {
    super(`Preview closed: ${reason}`);
  }
}

/** One remote endpoint's resource owner. No state is recovered from persisted URLs. */
export class QuickTunnelSession {
  readonly ready: Promise<SessionPreviewEndpoint>;
  private resolveReady!: (endpoint: SessionPreviewEndpoint) => void;
  private rejectReady!: (error: unknown) => void;
  /** Resolves only after all resources have been released, including failed creation. */
  readonly closed: Promise<QuickTunnelClosed>;
  private readonly controller = new AbortController();
  private readonly proxy: LocalPreviewProxyManager;
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: number;
  private endpoint?: SessionPreviewEndpoint;
  private healthCheck?: Promise<void>;

  constructor(private readonly options: Options) {
    this.proxy = new LocalPreviewProxyManager({ logger: options.logger, now: options.now });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.closed = this.run();
  }

  get expiresAt(): number | undefined {
    return this.deadline;
  }

  get active(): boolean {
    return this.endpoint !== undefined && this.activity(false);
  }

  /** Observe the public route on demand; never renew or recreate an endpoint. */
  async checkHealth(): Promise<void> {
    if (!this.active || !this.endpoint) return;
    this.healthCheck ??= (this.options.verify ?? verifyPreviewTunnelRoundTrip)({
      publicUrl: this.endpoint.viewerUrl,
      target: this.options.target,
      signal: this.controller.signal,
      fetch: getCliHttpFetch({ logger: this.options.logger }),
      mode: 'health',
    })
      .catch((error: unknown) => {
        this.controller.abort(
          error instanceof Error
            ? error
            : new Error('Preview health check failed', { cause: error })
        );
      })
      .finally(() => {
        this.healthCheck = undefined;
      });
    await this.healthCheck;
  }

  /** Only authenticated remote traffic or an authorized foreground viewer may renew. */
  activity(renew: boolean): boolean {
    if (this.controller.signal.aborted) return false;
    if (this.deadline === undefined) return true; // Public readiness, before activation.
    if (this.options.now() >= this.deadline) {
      this.controller.abort(new PreviewStopped('idle_timeout'));
      return false;
    }
    if (renew) this.armIdleTimeout();
    return true;
  }

  async close(reason: PreviewCloseReason): Promise<void> {
    this.cancel(reason);
    const result = await this.closed;
    if (result.error) throw result.error;
  }

  cancel(reason: PreviewCloseReason): void {
    this.controller.abort(new PreviewStopped(reason));
  }

  private armIdleTimeout(): void {
    clearTimeout(this.timer);
    this.deadline = this.options.now() + DEFAULT_PREVIEW_IDLE_TIMEOUT_MS;
    this.timer = setTimeout(() => this.activity(false), DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
    this.timer.unref?.();
  }

  private async run(): Promise<QuickTunnelClosed> {
    let child: CloudflaredProcess | undefined;
    let outcome: QuickTunnelClosed = {};
    const signal = this.controller.signal;
    try {
      const binary = await (this.options.download ?? ensureCloudflaredBinary)({
        runtimeBaseUrl: this.options.runtimeBaseUrl,
        signal,
      });
      signal.throwIfAborted();
      const local = await this.proxy.acquire({
        sessionId: this.options.sessionId,
        target: this.options.target,
        connectionAddress: this.options.connectionAddress,
        remote: true,
        onActivity: (renew) => this.activity(renew),
      });
      signal.throwIfAborted();
      child = await (this.options.start ?? startCloudflaredProcess)({
        binary,
        proxyOrigin: new URL(local.viewerUrl).origin,
        signal,
      });
      void child.closed.then((error) => {
        if (!signal.aborted)
          this.controller.abort(error ?? new Error('cloudflared exited unexpectedly'));
      });
      signal.throwIfAborted();
      const endpoint = this.proxy.bindViewerOrigin(this.options.sessionId, child.origin);
      await (this.options.verify ?? verifyPreviewTunnelRoundTrip)({
        publicUrl: endpoint.viewerUrl,
        target: this.options.target,
        signal,
        fetch: getCliHttpFetch({ logger: this.options.logger }),
      });
      signal.throwIfAborted();
      this.endpoint = endpoint;
      this.armIdleTimeout();
      this.resolveReady(endpoint);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      signal.throwIfAborted();
    } catch (error) {
      const diagnostic = child?.diagnostic();
      const failure =
        error instanceof Error ? error : new Error('Quick Tunnel failed', { cause: error });
      outcome =
        error instanceof PreviewStopped
          ? { reason: error.reason }
          : {
              error: diagnostic
                ? new Error(`${failure.message}; last cloudflared error: ${diagnostic}`, {
                    cause: failure,
                  })
                : failure,
            };
    } finally {
      this.endpoint = undefined;
      clearTimeout(this.timer);
      this.controller.abort(outcome.error ?? new PreviewStopped(outcome.reason ?? 'session_ended'));
      const cleanup = await Promise.allSettled([
        this.proxy.closeAll('Remote preview closed'),
        child?.stop(),
      ]);
      const failures = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (failures.length) {
        outcome = {
          error: new AggregateError(
            [...(outcome.error ? [outcome.error] : []), ...failures],
            'Quick Tunnel resource cleanup failed',
            { cause: outcome.error }
          ),
        };
      }
      this.rejectReady(outcome.error ?? new PreviewStopped(outcome.reason ?? 'session_ended'));
    }
    return outcome;
  }
}
