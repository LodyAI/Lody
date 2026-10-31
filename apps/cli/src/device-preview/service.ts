import type { SimulatorIceServer } from './webrtc-protocol';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
  type SessionId,
  type PreviewTarget,
  type AndroidEmulatorQuality,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { QuickTunnelSession } from '@/preview/quick-tunnel-session';
import { LocalPreviewProxyManager } from '@/preview/local-preview-proxy';
import { deviceControlLeases, type DeviceControlLeases } from './control-leases';
import type { DeviceEntry, DeviceRequest, DeviceResponse, DevicePreview } from './types';
type ViewerEndpoint = {
  phase: DevicePreview['phase'];
  viewerUrl?: string;
  message?: string;
  done: Promise<void>;
  renew?: () => void;
};
type Operation = {
  quality?: AndroidEmulatorQuality;
  state: DevicePreview;
  owner: string;
  abort: AbortController;
  done: Promise<void>;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  endpoints: Map<boolean, ViewerEndpoint>;
  connect?: (remote: boolean, endpoint: ViewerEndpoint) => Promise<void>;
  attachViewer?: (remote: boolean) => void;
  viewerAttached?: Promise<void>;
};
export type GatewayContext = {
  operationId: string;
  signal: AbortSignal;
  active(): boolean;
  renew(): void;
  iceServers(): Promise<SimulatorIceServer[]>;
};
export type DeviceConnection = {
  closed: Promise<void>;
  stop(): Promise<void>;
  gateway(context: GatewayContext): Promise<{
    port: number;
    path: string;
    remotePath: string;
    close(): Promise<void>;
  }>;
};
export type DevicePreviewAdapter = {
  platform: 'ios' | 'android';
  viewerAttachTimeoutMs?: number;
  normalize(id: string): string;
  list(signal?: AbortSignal): Promise<DeviceEntry[]>;
  prepare(signal: AbortSignal): Promise<string>;
  boot(id: string, signal: AbortSignal): Promise<void>;
  open(
    runtime: string,
    device: DeviceEntry,
    signal: AbortSignal,
    quality?: AndroidEmulatorQuality
  ): Promise<DeviceConnection>;
  exterior?(id: string, signal: AbortSignal): Promise<NonNullable<DeviceResponse['exterior']>>;
  environmentMessage: string;
};
export type DevicePreviewDependencies = {
  workspaceId: string;
  logger: Logger;
  runtimeBaseUrl: string;
  adapter: DevicePreviewAdapter;
  iceServers?: (
    sessionId: string
  ) => Promise<{ iceServers: SimulatorIceServer[]; expiresAt: number }>;
  authorize(request: DeviceRequest): Promise<void>;
  onAgentPreviewStarted?: (sessionId: string, operationId: string) => Promise<void>;
  leases?: DeviceControlLeases;
  now?: () => number;
  localProxy?: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  tunnel?: (
    options: ConstructorParameters<typeof QuickTunnelSession>[0]
  ) => Pick<QuickTunnelSession, 'ready' | 'closed' | 'cancel' | 'activity'>;
};
/** Simulator state is ephemeral, never Browser metadata or a second durable owner. */
export class DevicePreviewService {
  private readonly operations = new Map<string, Operation>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly leases: DeviceControlLeases;
  private readonly local: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  private readonly now: () => number;
  private disposed = false;
  private readonly exteriorAbort = new AbortController();
  private readonly exteriors = new Map<string, NonNullable<DeviceResponse['exterior']>>();
  private remoteGeneration = 0;
  private remoteEnabled = false;
  private readonly generations = new Map<string, number>();
  constructor(private readonly deps: DevicePreviewDependencies) {
    this.leases = deps.leases ?? deviceControlLeases;
    this.now = deps.now ?? Date.now;
    this.local =
      deps.localProxy ?? new LocalPreviewProxyManager({ logger: deps.logger, now: this.now });
  }
  private deviceKey(id: string): string {
    return `${this.deps.adapter.platform}:${this.deps.adapter.normalize(id)}`;
  }
  controlFromAgent(request: DeviceRequest): Promise<DeviceResponse> {
    return this.handleControl(request, false, undefined, true);
  }
  control(
    request: DeviceRequest,
    remote: boolean,
    authorizeRemote?: () => Promise<unknown>
  ): Promise<DeviceResponse> {
    return this.handleControl(request, remote, authorizeRemote, false);
  }
  private async handleControl(
    request: DeviceRequest,
    remote: boolean,
    authorizeRemote: (() => Promise<unknown>) | undefined,
    fromAgent: boolean
  ): Promise<DeviceResponse> {
    const base = { sessionId: request.sessionId };
    const generation = this.generations.get(request.sessionId) ?? 0;
    const remoteGeneration = this.remoteGeneration;
    const current = () =>
      generation === (this.generations.get(request.sessionId) ?? 0) &&
      (!remote || (this.remoteEnabled && remoteGeneration === this.remoteGeneration));
    try {
      try {
        if (!current()) throw new Error('Remote simulator access is disabled.');
        if (remote) {
          if (!authorizeRemote) throw new Error('Missing remote simulator authorization.');
          await authorizeRemote();
        }
        await this.deps.authorize(request);
      } catch {
        return {
          ...base,
          success: false,
          error: 'denied',
          message: 'This session cannot control the simulator.',
        };
      }
      if (!current()) throw new Error('Simulator authorization changed.');
      if (this.disposed || !current()) throw new Error('Simulator service is stopping.');
      const command = request.command;
      const owner = JSON.stringify([this.deps.workspaceId, request.sessionId]);
      if (command.action === 'list') {
        const devices = await this.deps.adapter.list();
        return {
          ...base,
          success: true,
          devices: devices.map((device) => ({
            ...device,
            occupancy: this.leases.occupancy(this.deviceKey(device.id), owner),
          })),
        };
      }
      if (command.action === 'exterior') {
        if (fromAgent || !this.deps.adapter.exterior)
          return { ...base, success: false, error: 'unsupported' };
        const readExterior = this.deps.adapter.exterior;
        return await this.serialize('device-exterior', async () => {
          if (this.disposed || !current()) throw new Error('Simulator authorization changed.');
          const devices = await this.deps.adapter.list();
          if (!devices.some((device) => device.id === command.id))
            return { ...base, success: false, error: 'unavailable' as const };
          let exterior = this.exteriors.get(command.id);
          if (!exterior) {
            const signal = AbortSignal.any([this.exteriorAbort.signal, AbortSignal.timeout(30000)]);
            exterior = await readExterior(command.id, signal);
            if (this.exteriors.size >= 16) this.exteriors.clear();
            this.exteriors.set(command.id, exterior);
          }
          await this.deps.authorize(request);
          if (this.disposed || !current()) throw new Error('Simulator authorization changed.');
          return { ...base, success: true, exterior };
        });
      }
      if (command.action === 'status') {
        const op = this.operations.get(request.sessionId);
        const matches =
          op && (!command.operationId || op.state.operationId === command.operationId);
        // Agent starts have no viewer location. The first authenticated panel
        // selects its own local/remote plane; agent status reads never attach it.
        if (matches && !fromAgent && !op.abort.signal.aborted) this.attachViewer(op, remote);
        const preview = matches ? this.snapshot(op, fromAgent ? undefined : remote) : undefined;
        return { ...base, success: true, preview };
      }
      // Cancellation is eager, before joining an earlier replacement's cleanup barrier.
      if (command.action === 'stop') {
        const op = this.operations.get(request.sessionId);
        if (op?.state.operationId === command.operationId) {
          op.abort.abort();
          await op.done;
        }
        return {
          ...base,
          success: true,
          preview:
            op?.state.operationId === command.operationId
              ? this.snapshot(op, fromAgent ? undefined : remote)
              : undefined,
        };
      }
      return await this.serialize(request.sessionId, async () => {
        if (this.disposed || !current()) throw new Error('Simulator service is stopping.');
        const existing = this.operations.get(request.sessionId);
        if (
          existing &&
          !existing.abort.signal.aborted &&
          this.deviceKey(existing.state.id) === this.deviceKey(command.id) &&
          existing.quality === command.quality
        ) {
          if (!fromAgent) this.attachViewer(existing, remote, true);
          else await this.reportAgentPreview(request.sessionId, existing.state.operationId);
          return {
            ...base,
            success: true,
            preview: this.snapshot(existing, fromAgent ? undefined : remote),
          };
        }
        if (existing) {
          existing.abort.abort();
          await existing.done;
        }
        if (this.disposed || !current()) throw new Error('Simulator authorization changed.');
        const operationId = randomUUID();
        if (!this.leases.acquire(this.deviceKey(command.id), owner, operationId))
          return {
            ...base,
            success: false,
            error: 'occupied' as const,
            message: 'Another session is controlling this simulator.',
          };
        const op: Operation = {
          owner,
          quality: command.quality,
          endpoints: new Map(),
          state: {
            operationId,
            id: command.id,
            phase: 'preparing',
            transport: remote ? 'remote' : 'local',
          },
          abort: new AbortController(),
          done: Promise.resolve(),
          deadline: this.now() + DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
        };
        if (fromAgent) {
          op.viewerAttached = new Promise<void>((resolve) => {
            op.attachViewer = (viewerRemote) => {
              op.state.transport = viewerRemote ? 'remote' : 'local';
              op.attachViewer = undefined;
              resolve();
            };
            op.abort.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          // An unattended agent start must not hold the device indefinitely.
          op.timer = setTimeout(() => op.abort.abort(), DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
          op.timer.unref?.();
        }
        if (!fromAgent) this.attachViewer(op, remote);
        this.operations.set(request.sessionId, op);
        op.done = this.run(request.sessionId, op);
        if (fromAgent) await this.reportAgentPreview(request.sessionId, operationId);
        return {
          ...base,
          success: true,
          preview: this.snapshot(op, fromAgent ? undefined : remote),
        };
      });
    } catch {
      return {
        ...base,
        success: false,
        error: request.command.action === 'list' ? 'environment' : 'failed',
        message: this.deps.adapter.environmentMessage,
      };
    }
  }
  private async reportAgentPreview(sessionId: string, operationId: string): Promise<void> {
    try {
      await this.deps.onAgentPreviewStarted?.(sessionId, operationId);
    } catch {
      // Discovery is best effort; it must not turn an accepted start into a failure.
      this.deps.logger.warn('Failed to publish simulator preview discovery hint.');
    }
  }
  private attachViewer(op: Operation, remote: boolean, retry = false): void {
    if (op.abort.signal.aborted) return;
    op.attachViewer?.(remote);
    const previous = op.endpoints.get(remote);
    if (previous && !(retry && previous.phase === 'failed')) return;
    const endpoint: ViewerEndpoint = { phase: 'connecting', done: Promise.resolve() };
    op.endpoints.set(remote, endpoint);
    if (op.connect) {
      const connect = op.connect;
      endpoint.done = previous
        ? previous.done.then(() => connect(remote, endpoint))
        : connect(remote, endpoint);
      void endpoint.done.catch(() => op.abort.abort());
    }
  }
  private snapshot(op: Operation, remote = op.state.transport === 'remote'): DevicePreview {
    const endpoint = op.endpoints.get(remote);
    const terminal =
      op.abort.signal.aborted || op.state.phase === 'failed' || op.state.phase === 'closed';
    return {
      ...op.state,
      transport: remote ? 'remote' : 'local',
      ...(op.state.phase === 'ready' && !terminal
        ? { phase: endpoint?.phase ?? 'connecting', message: endpoint?.message }
        : {}),
      viewerUrl: terminal ? undefined : endpoint?.viewerUrl,
    };
  }
  private serialize<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.queues.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(sessionId, pending);
    void pending
      .finally(() => {
        if (this.queues.get(sessionId) === pending) this.queues.delete(sessionId);
      })
      .catch(() => {});
    return pending;
  }
  private async run(sessionId: string, op: Operation): Promise<void> {
    const signal = op.abort.signal;
    const active = () =>
      !signal.aborted &&
      this.now() < op.deadline &&
      this.leases.owns(this.deviceKey(op.state.id), op.owner, op.state.operationId);
    const renew = () => {
      if (!active()) return;
      op.deadline = this.now() + DEFAULT_PREVIEW_IDLE_TIMEOUT_MS;
      clearTimeout(op.timer);
      op.timer = setTimeout(() => op.abort.abort(), DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
      op.timer.unref?.();
      for (const endpoint of op.endpoints.values()) endpoint.renew?.();
    };
    let process: DeviceConnection | undefined;
    let gateway: Awaited<ReturnType<DeviceConnection['gateway']>> | undefined;
    try {
      const devices = await this.deps.adapter.list(signal);
      signal.throwIfAborted();
      const device = devices.find((d) => this.deviceKey(d.id) === this.deviceKey(op.state.id));
      if (!device?.available) throw new Error('Selected simulator or its runtime is unavailable.');
      const binary = await this.deps.adapter.prepare(signal);
      signal.throwIfAborted();
      op.state.phase = 'booting';
      await this.deps.adapter.boot(device.id, signal);
      signal.throwIfAborted();
      op.state.phase = 'connecting';
      const attachTimer =
        op.viewerAttached && this.deps.adapter.viewerAttachTimeoutMs !== undefined
          ? setTimeout(() => op.abort.abort(), this.deps.adapter.viewerAttachTimeoutMs)
          : undefined;
      attachTimer?.unref?.();
      try {
        await op.viewerAttached;
      } finally {
        clearTimeout(attachTimer);
      }
      signal.throwIfAborted();
      // Abort native startup promptly, but keep a ready capture process alive
      // until the gateway has flushed touch-up during shutdown.
      const processStartup = new AbortController();
      const cancelProcessStartup = () => processStartup.abort();
      signal.addEventListener('abort', cancelProcessStartup, { once: true });
      if (signal.aborted) cancelProcessStartup();
      try {
        process = await this.deps.adapter.open(binary, device, processStartup.signal, op.quality);
      } finally {
        signal.removeEventListener('abort', cancelProcessStartup);
      }
      void process.closed.then(
        () => op.abort.abort(),
        () => op.abort.abort()
      );
      const nativeProcess = process;
      let ice: { iceServers: SimulatorIceServer[]; expiresAt: number } | undefined;
      let icePending: Promise<{ iceServers: SimulatorIceServer[]; expiresAt: number }> | undefined;
      gateway = await nativeProcess.gateway({
        operationId: op.state.operationId,
        iceServers: async () => {
          if (!active()) throw new Error('Simulator closed.');
          if (!this.deps.iceServers) return [];
          if (!ice || ice.expiresAt - this.now() < 60_000) {
            icePending ??= this.deps.iceServers(sessionId).finally(() => {
              icePending = undefined;
            });
            ice = await icePending;
          }
          if (!active()) throw new Error('Simulator closed.');
          return ice.iceServers;
        },
        signal,
        active,
        renew,
      });
      signal.throwIfAborted();
      const boundGateway = gateway;
      op.connect = async (remote, endpoint) => {
        const target: PreviewTarget = {
          protocol: 'http',
          host: '127.0.0.1',
          port: boundGateway.port,
          path: remote ? boundGateway.remotePath : boundGateway.path,
        };
        let tunnel: ReturnType<NonNullable<DevicePreviewDependencies['tunnel']>> | undefined;
        const cancel = () => tunnel?.cancel('revoked');
        try {
          signal.throwIfAborted();
          if (remote) {
            tunnel = (this.deps.tunnel ?? ((options) => new QuickTunnelSession(options)))({
              sessionId: sessionId as SessionId,
              target,
              runtimeBaseUrl: this.deps.runtimeBaseUrl,
              logger: this.deps.logger,
              now: this.now,
              visualAnnotation: false,
              renewOnTraffic: false,
            });
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            endpoint.renew = () => {
              tunnel?.activity(true);
            };
            endpoint.viewerUrl = (await tunnel.ready).viewerUrl;
          } else {
            endpoint.viewerUrl = (
              await this.local.acquire({
                sessionId: sessionId as SessionId,
                target,
                visualAnnotation: false,
                onActivity: () => active(),
              })
            ).viewerUrl;
          }
          signal.throwIfAborted();
          endpoint.phase = 'ready';
          // A second viewer must not reset the operation's expiry merely by polling.
          if (tunnel) await tunnel.closed;
          else
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
          if (!signal.aborted) throw new Error('Simulator tunnel closed.');
        } catch {
          endpoint.phase = signal.aborted ? 'closed' : 'failed';
          endpoint.message =
            'Simulator preview connection failed. Check network access, then retry.';
        }
        endpoint.viewerUrl = undefined;
        endpoint.renew = undefined;
        signal.removeEventListener('abort', cancel);
        if (tunnel) {
          tunnel.cancel('revoked');
          const closed = await tunnel.closed;
          if (closed.cleanupFailed)
            throw closed.error ?? new Error('Simulator tunnel cleanup failed.');
        } else if (!remote)
          await this.local.closeSession(sessionId as SessionId, 'Simulator stopped');
      };
      for (const [remote, endpoint] of op.endpoints) {
        endpoint.done = op.connect(remote, endpoint);
        void endpoint.done.catch(() => op.abort.abort());
      }
      op.state.phase = 'ready';
      renew();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } catch (error) {
      if (!signal.aborted) {
        op.state.phase = 'failed';
        op.state.message =
          error instanceof Error && error.message.startsWith('Selected simulator')
            ? error.message
            : this.deps.adapter.environmentMessage;
      }
    } finally {
      op.abort.abort();
      clearTimeout(op.timer);
      op.state.viewerUrl = undefined;
      // Revoke viewers before relinquishing the machine-wide input lease.
      const results = await Promise.allSettled([
        ...[...op.endpoints.values()].map((endpoint) => endpoint.done),
        gateway?.close(),
      ]);
      const captureCleanup = await Promise.allSettled([process?.stop()]);
      results.push(...captureCleanup);
      if (results.some((r) => r.status === 'rejected')) {
        op.state.phase = 'failed';
        op.state.message = 'Simulator resource cleanup failed.';
      }
      if (op.state.phase !== 'failed') op.state.phase = 'closed';
      // A revoked endpoint cannot send input; an unconfirmed capture may still do so.
      // Fence only that device, never the workspace or the other platform.
      if (captureCleanup.every((result) => result.status === 'fulfilled'))
        this.leases.release(this.deviceKey(op.state.id), op.owner, op.state.operationId);
    }
  }
  async closeSession(sessionId: string): Promise<void> {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    const op = this.operations.get(sessionId);
    if (op) {
      op.abort.abort();
      await op.done;
      if (this.operations.get(sessionId) === op) this.operations.delete(sessionId);
    }
  }
  enableRemote(): void {
    this.remoteGeneration++;
    this.remoteEnabled = true;
  }
  revokeRemote(): void {
    this.remoteEnabled = false;
    this.remoteGeneration++;
    for (const op of this.operations.values())
      if (op.endpoints.has(true) || op.state.transport === 'remote') op.abort.abort();
  }
  async closeAll(): Promise<void> {
    this.disposed = true;
    this.exteriorAbort.abort();
    this.exteriors.clear();
    for (const op of this.operations.values()) op.abort.abort();
    await Promise.all([...this.operations.values()].map((op) => op.done));
    await Promise.allSettled(this.queues.values());
    this.operations.clear();
  }
}
