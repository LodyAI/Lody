import { readIdleSimulatorExterior } from './exterior';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PREVIEW_IDLE_TIMEOUT_MS,
  type IosSimulatorRequest,
  type IosSimulatorResponse,
  type IosSimulatorPreview,
  type SessionId,
  type PreviewTarget,
} from '@lody/shared';
import type { Logger } from '@/utils/logger';
import { QuickTunnelSession } from '@/preview/quick-tunnel-session';
import { LocalPreviewProxyManager } from '@/preview/local-preview-proxy';
import { ensureBaguetteBinary } from './baguette-binary';
import { startBaguetteProcess } from './baguette-process';
import { createSimulatorGateway } from './gateway';
import { listSimulatorDevices, bootSimulator } from './devices';
import { simulatorControlLeases, type SimulatorControlLeases } from './control-leases';

type ViewerEndpoint = {
  phase: IosSimulatorPreview['phase'];
  viewerUrl?: string;
  message?: string;
  done: Promise<void>;
  renew?: () => void;
};
type Operation = {
  state: IosSimulatorPreview;
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
type Dependencies = {
  workspaceId: string;
  logger: Logger;
  runtimeBaseUrl: string;
  authorize(request: IosSimulatorRequest): Promise<void>;
  onAgentPreviewStarted?: (sessionId: string, operationId: string) => Promise<void>;
  leases?: SimulatorControlLeases;
  now?: () => number;
  list?: typeof listSimulatorDevices;
  boot?: typeof bootSimulator;
  exterior?: typeof readIdleSimulatorExterior;
  binary?: (signal: AbortSignal) => Promise<string>;
  process?: typeof startBaguetteProcess;
  gateway?: typeof createSimulatorGateway;
  localProxy?: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  tunnel?: (
    options: ConstructorParameters<typeof QuickTunnelSession>[0]
  ) => Pick<QuickTunnelSession, 'ready' | 'closed' | 'cancel' | 'activity'>;
};
/** Simulator state is ephemeral, never Browser metadata or a second durable owner. */
export class IosSimulatorService {
  private readonly operations = new Map<string, Operation>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly leases: SimulatorControlLeases;
  private readonly local: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  private readonly now: () => number;
  private disposed = false;
  private readonly exteriorAbort = new AbortController();
  private readonly exteriors = new Map<
    string,
    Awaited<ReturnType<typeof readIdleSimulatorExterior>>
  >();
  private remoteGeneration = 0;
  private remoteEnabled = false;
  private readonly generations = new Map<string, number>();
  constructor(private readonly deps: Dependencies) {
    this.leases = deps.leases ?? simulatorControlLeases;
    this.now = deps.now ?? Date.now;
    this.local =
      deps.localProxy ?? new LocalPreviewProxyManager({ logger: deps.logger, now: this.now });
  }
  controlFromAgent(request: IosSimulatorRequest): Promise<IosSimulatorResponse> {
    return this.handleControl(request, false, undefined, true);
  }
  control(
    request: IosSimulatorRequest,
    remote: boolean,
    authorizeRemote?: () => Promise<unknown>
  ): Promise<IosSimulatorResponse> {
    return this.handleControl(request, remote, authorizeRemote, false);
  }
  private async handleControl(
    request: IosSimulatorRequest,
    remote: boolean,
    authorizeRemote: (() => Promise<unknown>) | undefined,
    fromAgent: boolean
  ): Promise<IosSimulatorResponse> {
    const base = { type: 'ios-simulator/control_response' as const, sessionId: request.sessionId };
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
        const devices = await (this.deps.list ?? listSimulatorDevices)();
        return {
          ...base,
          success: true,
          devices: devices.map((device) => ({
            ...device,
            occupancy: this.leases.occupancy(device.udid, owner),
          })),
        };
      }
      if (command.action === 'exterior') {
        if (fromAgent) return { ...base, success: false, error: 'unsupported' };
        return await this.serialize('device-exterior', async () => {
          if (this.disposed || !current()) throw new Error('Simulator authorization changed.');
          const devices = await (this.deps.list ?? listSimulatorDevices)();
          if (!devices.some((device) => device.udid === command.udid))
            return { ...base, success: false, error: 'unavailable' as const };
          let exterior = this.exteriors.get(command.udid);
          if (!exterior) {
            const signal = AbortSignal.any([this.exteriorAbort.signal, AbortSignal.timeout(30000)]);
            const binary = await (this.deps.binary?.(signal) ??
              ensureBaguetteBinary(signal, this.deps.runtimeBaseUrl));
            exterior = await (this.deps.exterior ?? readIdleSimulatorExterior)(
              binary,
              command.udid,
              signal
            );
            if (this.exteriors.size >= 16) this.exteriors.clear();
            this.exteriors.set(command.udid, exterior);
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
          existing.state.udid.toUpperCase() === command.udid.toUpperCase()
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
        if (!this.leases.acquire(command.udid, owner, operationId))
          return {
            ...base,
            success: false,
            error: 'occupied' as const,
            message: 'Another session is controlling this simulator.',
          };
        const op: Operation = {
          owner,
          endpoints: new Map(),
          state: {
            operationId,
            udid: command.udid,
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
        message:
          'Unable to manage iOS Simulator. Check machine access, Xcode and the installed iOS runtime.',
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
  private snapshot(op: Operation, remote = op.state.transport === 'remote'): IosSimulatorPreview {
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
      this.leases.owns(op.state.udid, op.owner, op.state.operationId);
    const renew = () => {
      if (!active()) return;
      op.deadline = this.now() + DEFAULT_PREVIEW_IDLE_TIMEOUT_MS;
      clearTimeout(op.timer);
      op.timer = setTimeout(() => op.abort.abort(), DEFAULT_PREVIEW_IDLE_TIMEOUT_MS);
      op.timer.unref?.();
      for (const endpoint of op.endpoints.values()) endpoint.renew?.();
    };
    let process: Awaited<ReturnType<typeof startBaguetteProcess>> | undefined;
    let gateway: Awaited<ReturnType<typeof createSimulatorGateway>> | undefined;
    try {
      const devices = await (this.deps.list ?? listSimulatorDevices)(signal);
      signal.throwIfAborted();
      const device = devices.find((d) => d.udid.toUpperCase() === op.state.udid.toUpperCase());
      if (!device?.available) throw new Error('Selected simulator or its runtime is unavailable.');
      const binary = await (
        this.deps.binary ??
        ((runtimeSignal) => ensureBaguetteBinary(runtimeSignal, this.deps.runtimeBaseUrl))
      )(signal);
      signal.throwIfAborted();
      op.state.phase = 'booting';
      await (this.deps.boot ?? bootSimulator)(device.udid, signal);
      signal.throwIfAborted();
      op.state.phase = 'connecting';
      await op.viewerAttached;
      signal.throwIfAborted();
      // Abort native startup promptly, but keep a ready capture process alive
      // until the gateway has flushed touch-up during shutdown.
      const processStartup = new AbortController();
      const cancelProcessStartup = () => processStartup.abort();
      signal.addEventListener('abort', cancelProcessStartup, { once: true });
      if (signal.aborted) cancelProcessStartup();
      try {
        process = await (this.deps.process ?? startBaguetteProcess)(binary, processStartup.signal);
      } finally {
        signal.removeEventListener('abort', cancelProcessStartup);
      }
      void process.closed.then(() => op.abort.abort());
      const nativeProcess = process;
      gateway = await (this.deps.gateway ?? createSimulatorGateway)({
        operationId: op.state.operationId,
        udid: device.udid,
        port: process.port,
        softwareKeyboard: /iphone|ipad/i.test(device.deviceType ?? ''),
        signal,
        hostControl: (control) => nativeProcess.control(device.udid, control),
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
        let tunnel: ReturnType<NonNullable<Dependencies['tunnel']>> | undefined;
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
            : 'Simulator preview preparation failed. Check Xcode, runtime compatibility and network access, then retry.';
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
      results.push(...(await Promise.allSettled([process?.stop()])));
      if (results.some((r) => r.status === 'rejected')) {
        op.state.phase = 'failed';
        op.state.message = 'Simulator resource cleanup failed.';
      }
      if (op.state.phase !== 'failed') op.state.phase = 'closed';
      this.leases.release(op.state.udid, op.owner, op.state.operationId);
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
