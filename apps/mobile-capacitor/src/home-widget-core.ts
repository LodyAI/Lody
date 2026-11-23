import type { LiveActivityConversationItem } from '@lody/shared';

export type HomeWidgetConversation = {
  id: string;
  title: string;
  status: 'waiting' | 'running' | 'unread';
  agentLogoKind: LiveActivityConversationItem['agentLogoKind'];
  agentLogoText: string;
  agentName: string;
  updatedAt: number;
};

export type HomeWidgetSummary = {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  items: HomeWidgetConversation[];
};

const AGENT_NAMES: Record<LiveActivityConversationItem['agentLogoKind'], string> = {
  codex: 'Codex',
  claude: 'Claude',
  deepseek: 'DeepSeek',
  mimo: 'MiMo',
  minimax: 'MiniMax',
  glm: 'GLM',
  agent: 'Agent',
};

// Reuse Live Activity's selection and ordering, then explicitly project only
// the metadata the Home Screen displays. Permission commands/IDs never cross.
export function toHomeWidgetConversations(
  items: readonly LiveActivityConversationItem[],
  agentNames: ReadonlyMap<string, string>
): HomeWidgetConversation[] {
  return items.slice(0, 3).map((item) => {
    const name = (agentNames.get(item.id) ?? '').trim();
    return {
      id: item.id,
      title: item.title.trim().slice(0, 96),
      status: item.status === 'permission' || item.status === 'question' ? 'waiting' : item.status,
      agentLogoKind: item.agentLogoKind,
      agentLogoText: item.agentLogoText.slice(0, 3),
      agentName: (name.length > 0 ? name : AGENT_NAMES[item.agentLogoKind]).slice(0, 48),
      updatedAt: item.updatedAt,
    };
  });
}

type WorkspaceIdentity = { workspaceId: string; workspaceSlug: string };

export type HomeWidgetScope = Pick<HomeWidgetSummary, 'userId' | 'workspaceId' | 'workspaceName'>;
export type HomeWidgetPending = { pendingScope: Pick<HomeWidgetScope, 'userId' | 'workspaceId'> };
export type HomeWidgetBridgeOptions<Summary> = {
  summary: Summary | null;
  pendingScope?: HomeWidgetPending['pendingScope'];
};

export function homeWidgetBridgeOptions<Summary extends HomeWidgetScope>(
  publication: Summary | HomeWidgetPending | null
): HomeWidgetBridgeOptions<Summary> {
  if (publication !== null && 'pendingScope' in publication) {
    return { summary: null, pendingScope: publication.pendingScope };
  }
  return { summary: publication };
}

type HomeWidgetScopeInput = {
  userId: string | null;
  hasAuthToken: boolean;
  slug: string | null;
  runtime:
    | (WorkspaceIdentity & { accountId: string | null; contentMode?: 'plaintext' | 'e2ee' })
    | null;
};

// Authentication and the current runtime establish ownership. Session metadata
// readiness separately gates reading its caches, not authenticated usage queries.
export function resolveHomeWidgetIdentity({
  userId,
  hasAuthToken,
  slug,
  runtime,
}: HomeWidgetScopeInput): HomeWidgetScope | null {
  if (
    !userId ||
    !hasAuthToken ||
    !slug ||
    !runtime?.workspaceId ||
    runtime.contentMode !== 'plaintext' ||
    runtime.accountId !== userId ||
    runtime.workspaceSlug !== slug
  )
    return null;
  return { userId, workspaceId: runtime.workspaceId, workspaceName: slug };
}

export function resolveHomeWidgetScope({
  userId,
  hasAuthToken,
  slug,
  runtime,
  metadata,
}: HomeWidgetScopeInput & {
  metadata: (WorkspaceIdentity & { runtime: WorkspaceIdentity; ready: boolean }) | null;
}): Pick<HomeWidgetSummary, 'userId' | 'workspaceId' | 'workspaceName'> | null {
  const identity = resolveHomeWidgetIdentity({ userId, hasAuthToken, slug, runtime });
  if (
    !identity ||
    !runtime ||
    metadata?.ready !== true ||
    metadata.runtime !== runtime ||
    metadata.workspaceId !== runtime.workspaceId ||
    metadata.workspaceSlug !== slug
  )
    return null;
  return identity;
}

type HomeWidgetSyncOptions<Summary> = {
  read: () => Summary | null;
  sync: (summary: Summary | null) => Promise<void>;
  schedule: (callback: () => void) => () => void;
  scheduleRetry: (callback: () => void, delayMs: number) => () => void;
  now: () => number;
  onError: (error: unknown) => void;
};

// Bound both native writes and summary scans during metadata catch-up. The
// adapter's timer is anchored to the first input, so streaming cannot starve it.
export function createHomeWidgetSync<Summary>(options: HomeWidgetSyncOptions<Summary>) {
  let cancelScheduled: (() => void) | undefined;
  let pending: { summary: Summary | null; force: boolean } | undefined;
  let writing = false;
  let stopped = false;
  let lastKey: string | undefined;
  let lastSyncedAt = -Infinity;
  let requestedKey: string | undefined;
  let retryCount = 0;
  let cancelRetry: (() => void) | undefined;
  const retryDelays = [1_000, 5_000, 30_000];
  const idleWaiters = new Set<() => void>();
  const settledWaiters = new Set<() => void>();

  function resolveIdle(): void {
    if (writing || pending || cancelScheduled) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
    if (!cancelRetry) {
      for (const resolve of settledWaiters) resolve();
      settledWaiters.clear();
    }
  }

  async function drain(): Promise<void> {
    if (writing || stopped) return;
    writing = true;
    try {
      while (pending) {
        if (stopped) break;
        const { summary, force } = pending;
        pending = undefined;
        const key = JSON.stringify(summary);
        // A heartbeat also renews the widget's freshness without rewriting on
        // every presence tick. No heartbeat is synthesized while JS is suspended.
        if (!force && key === lastKey && options.now() - lastSyncedAt < 5 * 60_000) {
          continue;
        }
        try {
          await options.sync(summary);
          lastKey = key;
          lastSyncedAt = options.now();
          retryCount = 0;
        } catch (error) {
          // A lost acknowledgement can follow a successful native mutation.
          lastKey = undefined;
          options.onError(error);
          const delay = retryDelays[retryCount];
          if (!pending && !stopped && delay !== undefined) {
            retryCount += 1;
            cancelRetry = options.scheduleRetry(() => {
              cancelRetry = undefined;
              // Reread current ownership before entering the write queue.
              enqueue(false);
            }, delay);
          }
        }
      }
    } finally {
      writing = false;
      resolveIdle();
    }
  }

  function enqueue(force: boolean): void {
    const summary = options.read();
    const key = JSON.stringify(summary);
    if (force || key !== requestedKey) retryCount = 0;
    requestedKey = key;
    cancelRetry?.();
    cancelRetry = undefined;
    pending = { summary, force };
    void drain();
  }

  function whenIdle(): Promise<void> {
    if (!writing && !pending && !cancelScheduled) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  return {
    refresh({ immediate = false, force = false } = {}): void {
      if (stopped) return;
      if (immediate) {
        cancelScheduled?.();
        cancelScheduled = undefined;
        enqueue(force);
      } else if (!cancelScheduled) {
        cancelScheduled = options.schedule(() => {
          cancelScheduled = undefined;
          enqueue(force);
        });
      }
    },
    whenIdle,
    whenSettled(): Promise<void> {
      if (!writing && !pending && !cancelScheduled && !cancelRetry) return Promise.resolve();
      return new Promise((resolve) => settledWaiters.add(resolve));
    },
    stop(): Promise<void> {
      stopped = true;
      cancelRetry?.();
      cancelRetry = undefined;
      cancelScheduled?.();
      cancelScheduled = undefined;
      pending = undefined;
      resolveIdle();
      // Capacitor writes are not abortable. Retain their owner until the raw
      // write settles rather than reporting disposal while it can still write.
      return whenIdle();
    },
  };
}
