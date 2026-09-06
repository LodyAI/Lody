import type { AccountProfileSummary, MachineAccountProfilesRequest } from '@lody/shared';
import type { WorkspaceRuntime } from '@/atoms/runtime';

type StatusRuntime = Pick<WorkspaceRuntime, 'requestAccountProfiles'>;
type StatusTarget = Pick<
  MachineAccountProfilesRequest,
  'workspaceId' | 'machineId' | 'agentType' | 'configId'
>;

export type AccountProfileStatus = {
  profiles: AccountProfileSummary[];
  loading: boolean;
  error: { message?: string } | null;
};

export const EMPTY_ACCOUNT_PROFILE_STATUS: AccountProfileStatus = {
  profiles: [],
  loading: false,
  error: null,
};

const STATUS_FRESHNESS_MS = 30_000;
const MAX_IDLE_STATUS_ENTRIES = 32;
const runtimeStores = new WeakMap<StatusRuntime, Map<string, AccountProfileStatusStore>>();

export class AccountProfileStatusStore {
  private snapshot = EMPTY_ACCOUNT_PROFILE_STATUS;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private queuedRefresh: Promise<void> | null = null;
  private updatedAt: number | null = null;
  private revision = 0;

  constructor(
    private readonly runtime: StatusRuntime,
    private readonly target: StatusTarget
  ) {}

  getSnapshot = (): AccountProfileStatus => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get idle(): boolean {
    return this.listeners.size === 0 && !this.pending && !this.queuedRefresh;
  }

  private publish(snapshot: AccountProfileStatus): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  refresh = (options: { force?: boolean; invalidate?: boolean } = {}): Promise<void> => {
    if (options.invalidate) {
      this.revision++;
      this.updatedAt = null;
    }
    if (this.pending) {
      if (options.invalidate && !this.queuedRefresh) {
        this.queuedRefresh = this.pending.then(() => {
          this.queuedRefresh = null;
          return this.refresh({ force: true });
        });
      }
      return this.queuedRefresh ?? this.pending;
    }
    if (
      !options.force &&
      this.updatedAt !== null &&
      Date.now() - this.updatedAt < STATUS_FRESHNESS_MS
    ) {
      return Promise.resolve();
    }

    const revision = this.revision;
    this.publish({ ...this.snapshot, loading: true, error: null });
    this.pending = Promise.resolve()
      .then(() =>
        this.runtime.requestAccountProfiles({
          ...this.target,
          type: 'machine/account-profiles',
          cliType: 'builtin',
          requestId: crypto.randomUUID(),
          action: 'list',
        })
      )
      .then((response) => {
        if (revision !== this.revision) return;
        if (!response?.success) {
          this.updatedAt = null;
          this.publish({
            ...this.snapshot,
            loading: false,
            error: response?.error ? { message: response.error } : {},
          });
          return;
        }
        this.updatedAt = Date.now();
        this.publish({ profiles: response.profiles ?? [], loading: false, error: null });
      })
      .catch((cause: unknown) => {
        if (revision !== this.revision) return;
        this.updatedAt = null;
        this.publish({
          ...this.snapshot,
          loading: false,
          error: { message: cause instanceof Error ? cause.message : String(cause) },
        });
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  };
}

export function getAccountProfileStatusStore(
  runtime: StatusRuntime,
  target: StatusTarget
): AccountProfileStatusStore {
  let stores = runtimeStores.get(runtime);
  if (!stores) {
    stores = new Map();
    runtimeStores.set(runtime, stores);
  }
  const key = JSON.stringify([
    target.workspaceId,
    target.machineId,
    target.agentType,
    target.configId,
  ]);
  const existing = stores.get(key);
  if (existing) return existing;
  // Keep mounted and pending stores alive; inactive provider history is bounded.
  let idleCount = 0;
  for (const store of stores.values()) if (store.idle) idleCount++;
  for (const [oldKey, store] of stores) {
    if (idleCount < MAX_IDLE_STATUS_ENTRIES) break;
    if (store.idle) {
      stores.delete(oldKey);
      idleCount--;
    }
  }
  const store = new AccountProfileStatusStore(runtime, target);
  stores.set(key, store);
  return store;
}
