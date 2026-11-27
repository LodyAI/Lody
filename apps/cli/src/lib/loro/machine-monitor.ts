import {
  EphemeralStoreAdaptor,
  EphemeralStreamCrdt,
  type EphemeralStreamSubscription,
} from '@loro-dev/streams-crdt/loro';
import { EphemeralStore, type Value } from 'loro-crdt';
import {
  LODY_MACHINE_MONITOR_STATE_TTL_MS,
  LODY_MACHINE_MONITOR_MACOS_SAMPLE_MS,
  LODY_MACHINE_MONITOR_UNIX_SAMPLE_MS,
  LODY_MACHINE_MONITOR_WINDOWS_SAMPLE_MS,
  LORO_STREAMS_BUCKET_ID,
  createLoroStreamUrl,
  getLoroMetaStreamId,
  getLoroStreamsPresenceBaseUrl,
  getMachineMonitorSnapshotKey,
  getServerNow,
  loroStreamsWebSocketOptions,
  parseMachineMonitorStates,
  toLodyMachineMonitorStreamUrl,
  type MachineId,
  type MachineMonitorStateMap,
  type MachineMonitorSnapshot,
  type WorkspaceId,
} from '@lody/shared';
import { resolveCliLoroStreamsWebSocketEnabled } from '@/platform/presence';
import type { Logger } from '@/utils/logger';
import { formatErrorMessage } from '@/utils/format-error';
import { withTimeout } from '@/lib/loro/timeout-utils';

type StreamsAuthCallback = (context?: { reason: string }) => Promise<string | undefined>;
type SnapshotProvider = () => Promise<MachineMonitorSnapshot>;

export type CliMachineMonitorRuntimeOptions = {
  workspaceId: WorkspaceId;
  logger: Logger;
};

export type CliMachineMonitorStreamsOptions = {
  streamsBaseUrl: string;
  auth: StreamsAuthCallback;
  /** Hosted shard topology from the token response; the monitor room lives on the presence host when set. */
  shardHostSuffix?: string;
  webSocketEnabled?: boolean;
};

export function resolveMachineMonitorObservers(args: {
  states: MachineMonitorStateMap;
  machineId: MachineId;
  nowMs: number;
  lastForceSampleAtMs: number;
}): { hasObserver: boolean; newestForceSampleAtMs: number } {
  let hasObserver = false;
  let newestForceSampleAtMs = args.lastForceSampleAtMs;
  for (const state of Object.values(args.states)) {
    if (state.kind !== 'observer' || state.machineId !== args.machineId) continue;
    if (state.expiresAtMs <= args.nowMs) continue;
    hasObserver = true;
    newestForceSampleAtMs = Math.max(newestForceSampleAtMs, state.forceSampleAtMs ?? 0);
  }
  return { hasObserver, newestForceSampleAtMs };
}

const JOIN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function platformSampleIntervalMs(): number {
  return process.platform === 'win32'
    ? LODY_MACHINE_MONITOR_WINDOWS_SAMPLE_MS
    : process.platform === 'darwin'
      ? LODY_MACHINE_MONITOR_MACOS_SAMPLE_MS
      : LODY_MACHINE_MONITOR_UNIX_SAMPLE_MS;
}

export class CliMachineMonitorRuntime {
  private readonly store = new EphemeralStore(LODY_MACHINE_MONITOR_STATE_TTL_MS);
  private readonly detachStoreListener: () => void;
  private transport: EphemeralStreamCrdt | null = null;
  private subscription: EphemeralStreamSubscription | null = null;
  private machineId: MachineId | null = null;
  private snapshotProvider: SnapshotProvider | null = null;
  private sampleTimer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;
  private joinRetryTimer: NodeJS.Timeout | null = null;
  private sampleInFlight: Promise<void> | null = null;
  private lastForceSampleAtMs = 0;
  private forcePending = false;
  private started = false;
  private stopped = false;

  constructor(private readonly options: CliMachineMonitorRuntimeOptions) {
    this.detachStoreListener = this.store.subscribe(() => this.reconcileObservers());
  }

  applyLocalState(update: Uint8Array): void {
    this.store.apply(update);
  }

  encodeLocalState(): Uint8Array {
    return this.store.encodeAll();
  }

  subscribeLocalState(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  attachStreams(streamsOptions: CliMachineMonitorStreamsOptions): void {
    if (this.started || this.stopped || this.transport) return;
    const durableStreamUrl = createLoroStreamUrl({
      bucketId: LORO_STREAMS_BUCKET_ID,
      streamId: getLoroMetaStreamId(this.options.workspaceId),
      baseUrl: getLoroStreamsPresenceBaseUrl(
        streamsOptions.streamsBaseUrl,
        undefined,
        streamsOptions.shardHostSuffix
      ),
    });
    this.transport = new EphemeralStreamCrdt({
      streamUrl: toLodyMachineMonitorStreamUrl(durableStreamUrl),
      auth: streamsOptions.auth,
      ...loroStreamsWebSocketOptions(
        resolveCliLoroStreamsWebSocketEnabled(
          streamsOptions.webSocketEnabled,
          process.env.LODY_LORO_STREAMS_WS_ENABLED
        ),
        streamsOptions.streamsBaseUrl,
        this.options.workspaceId
      ),
      adaptor: EphemeralStoreAdaptor(this.store),
    });
    this.started = true;
    void this.joinWithRetry(0);
  }

  configure(machineId: MachineId, snapshotProvider: SnapshotProvider): void {
    this.machineId = machineId;
    this.snapshotProvider = snapshotProvider;
    this.reconcileObservers();
  }

  clearProvider(): void {
    this.snapshotProvider = null;
    this.stopSampler();
  }

  async detachStreams(): Promise<void> {
    if (this.stopped || !this.transport) return;
    this.stopSampler();
    if (this.joinRetryTimer) clearTimeout(this.joinRetryTimer);
    this.joinRetryTimer = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
    const transport = this.transport;
    this.transport = null;
    this.started = false;
    await transport.close();
    // A local renderer observer remains authoritative while the cloud sink is
    // detached; resume it immediately instead of waiting for the next renewal.
    this.reconcileObservers();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stopSampler();
    this.detachStoreListener();
    if (this.joinRetryTimer) clearTimeout(this.joinRetryTimer);
    this.joinRetryTimer = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
    await this.transport?.close();
    this.transport = null;
    this.store.destroy();
  }

  private async joinWithRetry(attempt: number): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    try {
      const result = await transport.join({
        onStatusChange: (status) => {
          if (status === 'joined') this.reconcileObservers();
          if (status === 'error' || status === 'disconnected') this.scheduleRejoin();
        },
      });
      if (this.stopped || this.transport !== transport) {
        if (result.ok) result.value.unsubscribe();
        return;
      }
      if (result.ok) {
        this.subscription = result.value;
        this.reconcileObservers();
        return;
      }
      throw result.error;
    } catch (error) {
      if (this.stopped || this.transport !== transport) return;
      const delayMs =
        JOIN_RETRY_DELAYS_MS[Math.min(attempt, JOIN_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
      this.options.logger.warn(
        `[${this.options.workspaceId}] Failed to join machine monitor room; retrying in ${delayMs}ms: ${formatErrorMessage(error)}`
      );
      this.joinRetryTimer = setTimeout(() => {
        this.joinRetryTimer = null;
        void this.joinWithRetry(attempt + 1);
      }, delayMs);
      this.joinRetryTimer.unref?.();
    }
  }

  private scheduleRejoin(): void {
    if (this.stopped || this.joinRetryTimer) return;
    this.joinRetryTimer = setTimeout(() => {
      this.joinRetryTimer = null;
      this.transport?.rejoin();
    }, 2_000);
    this.joinRetryTimer.unref?.();
  }

  private reconcileObservers(): void {
    if (this.stopped || !this.machineId || !this.snapshotProvider) {
      this.stopSampler();
      return;
    }
    const nowMs = getServerNow();
    const states = parseMachineMonitorStates(this.store.getAllStates());
    const observerState = resolveMachineMonitorObservers({
      states,
      machineId: this.machineId,
      nowMs,
      lastForceSampleAtMs: this.lastForceSampleAtMs,
    });
    if (!observerState.hasObserver) {
      this.stopSampler();
      return;
    }
    this.ensureLeaseTimer();
    if (observerState.newestForceSampleAtMs > this.lastForceSampleAtMs) {
      this.lastForceSampleAtMs = observerState.newestForceSampleAtMs;
      this.forcePending = true;
      if (this.sampleTimer) {
        clearTimeout(this.sampleTimer);
        this.sampleTimer = null;
      }
    }
    if (!this.sampleTimer && !this.sampleInFlight) void this.runSample();
  }

  private ensureLeaseTimer(): void {
    if (this.leaseTimer) return;
    this.leaseTimer = setInterval(() => this.reconcileObservers(), 1_000);
    this.leaseTimer.unref?.();
  }

  private stopSampler(): void {
    if (this.sampleTimer) clearTimeout(this.sampleTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.sampleTimer = null;
    this.leaseTimer = null;
    this.forcePending = false;
  }

  private async runSample(): Promise<void> {
    if (this.sampleInFlight || !this.snapshotProvider || !this.machineId || this.stopped) return;
    const provider = this.snapshotProvider;
    const machineId = this.machineId;
    this.forcePending = false;
    // Bound the provider call so a hung OS probe or wedged fs read can never leave
    // `sampleInFlight` set forever, which would silently kill sampling for the
    // process lifetime (reconcileObservers only resamples when it is null).
    const operation = withTimeout(
      provider(),
      platformSampleIntervalMs() * 2,
      'Machine monitor sample timed out'
    )
      .then((snapshot) => {
        if (this.stopped || this.machineId !== machineId) return;
        const key = getMachineMonitorSnapshotKey(machineId, snapshot.instanceId);
        this.store.set(key, snapshot as unknown as Value);
      })
      .catch((error: unknown) => {
        this.options.logger.debug(
          `[${this.options.workspaceId}] Machine monitor sample failed: ${formatErrorMessage(error)}`
        );
      })
      .finally(() => {
        this.sampleInFlight = null;
        if (!this.leaseTimer || this.stopped) return;
        if (this.forcePending) {
          void this.runSample();
          return;
        }
        const delayMs = platformSampleIntervalMs();
        this.sampleTimer = setTimeout(() => {
          this.sampleTimer = null;
          this.reconcileObservers();
        }, delayMs);
        this.sampleTimer.unref?.();
      });
    this.sampleInFlight = operation;
    await operation;
  }
}
