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

type Operation = {
  state: IosSimulatorPreview;
  owner: string;
  abort: AbortController;
  done: Promise<void>;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  renewTunnel?: () => void;
  attachViewer?: (remote: boolean) => void;
  viewerAttached?: Promise<void>;
};
type Dependencies = {
  workspaceId: string;
  logger: Logger;
  runtimeBaseUrl: string;
  authorize(request: IosSimulatorRequest): Promise<void>;
  leases?: SimulatorControlLeases;
  now?: () => number;
  list?: typeof listSimulatorDevices;
  boot?: typeof bootSimulator;
  binary?: (signal: AbortSignal) => Promise<string>;
  process?: typeof startBaguetteProcess;
  gateway?: typeof createSimulatorGateway;
  localProxy?: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  tunnel?: (options: ConstructorParameters<typeof QuickTunnelSession>[0]) => QuickTunnelSession;
};
/** Simulator state is ephemeral, never Browser metadata or a second durable owner. */
export class IosSimulatorService {
  private readonly operations = new Map<string, Operation>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly leases: SimulatorControlLeases;
  private readonly local: Pick<LocalPreviewProxyManager, 'acquire' | 'closeSession'>;
  private readonly now: () => number;
  private disposed = false;
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
      if (command.action === 'status') {
        const op = this.operations.get(request.sessionId);
        const matches =
          op && (!command.operationId || op.state.operationId === command.operationId);
        // Agent starts have no viewer location. The first authenticated panel
        // selects its own local/remote plane; agent status reads never attach it.
        if (matches && !fromAgent && !op.abort.signal.aborted) op.attachViewer?.(remote);
        const preview = matches ? this.snapshot(op) : undefined;
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
          preview: op?.state.operationId === command.operationId ? this.snapshot(op) : undefined,
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
          if (!fromAgent) existing.attachViewer?.(remote);
          if (!fromAgent && existing.state.transport !== (remote ? 'remote' : 'local'))
            throw new Error('Stop the existing preview before changing its connection transport.');
          return { ...base, success: true, preview: this.snapshot(existing) };
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
        this.operations.set(request.sessionId, op);
        op.done = this.run(request.sessionId, op);
        return { ...base, success: true, preview: this.snapshot(op) };
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
  private snapshot(op: Operation): IosSimulatorPreview {
    return { ...op.state, viewerUrl: op.abort.signal.aborted ? undefined : op.state.viewerUrl };
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
      op.renewTunnel?.();
    };
    let process: Awaited<ReturnType<typeof startBaguetteProcess>> | undefined;
    let gateway: Awaited<ReturnType<typeof createSimulatorGateway>> | undefined;
    let tunnel: QuickTunnelSession | undefined;
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
        signal,
        hostControl: (control) => nativeProcess.control(device.udid, control),
        active,
        renew,
      });
      signal.throwIfAborted();
      const target: PreviewTarget = {
        protocol: 'http',
        host: '127.0.0.1',
        port: gateway.port,
        path: gateway.path,
      };
      if (op.state.transport === 'remote') {
        tunnel = (this.deps.tunnel ?? ((options) => new QuickTunnelSession(options)))({
          sessionId: sessionId as SessionId,
          target,
          runtimeBaseUrl: this.deps.runtimeBaseUrl,
          logger: this.deps.logger,
          now: this.now,
          visualAnnotation: false,
          renewOnTraffic: false,
        });
        const cancel = () => tunnel?.cancel('revoked');
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        op.renewTunnel = () => {
          tunnel?.activity(true);
        };
        void tunnel.closed.then(() => op.abort.abort());
        const endpoint = await tunnel.ready;
        op.state.viewerUrl = endpoint.viewerUrl;
      } else {
        const endpoint = await this.local.acquire({
          sessionId: sessionId as SessionId,
          target,
          visualAnnotation: false,
          onActivity: () => active(),
        });
        op.state.viewerUrl = endpoint.viewerUrl;
      }
      signal.throwIfAborted();
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
        tunnel?.close('revoked'),
        this.local.closeSession(sessionId as SessionId, 'Simulator stopped'),
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
      if (op.state.transport === 'remote') op.abort.abort();
  }
  async closeAll(): Promise<void> {
    this.disposed = true;
    for (const op of this.operations.values()) op.abort.abort();
    await Promise.all([...this.operations.values()].map((op) => op.done));
    await Promise.allSettled(this.queues.values());
    this.operations.clear();
  }
}
