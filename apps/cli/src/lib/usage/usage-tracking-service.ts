import { ConvexHttpClient } from 'convex/browser';
import { api } from '@lody/cloud-api';
import type { Logger } from '@/utils/logger';
import type { BuiltinAgentType } from '@lody/shared';
import { PRICE_DATA } from './price';
import type { SessionUsageUpdate } from 'acp-extension-core';
import { formatErrorMessage } from '@/utils/format-error';

export type UsageTrackingServiceConfig = {
  convexUrl: string;
  cliToken: string;
  logger: Logger;
};

export type RecordSessionUsageInput = {
  workspaceId: string;
  sessionId: string;
  acpSessionId: string;
  userId: string;
  machineId: string;
  cliType: BuiltinAgentType;
  update: SessionUsageUpdate;
};

type PendingKey = string;

type PendingState = {
  latestMeta: Omit<RecordSessionUsageInput, 'update'>;
  staged: SessionUsageUpdate | null;
  // Keep one unacknowledged payload; newer updates coalesce separately in staged.
  unacknowledged: RecordSessionUsageInput | null;
  inFlight: Promise<void> | null;
};

// Keep delivery queues isolated by native session identity.
const toPendingKey = (
  input: Pick<RecordSessionUsageInput, 'workspaceId' | 'sessionId' | 'acpSessionId' | 'userId'>
): PendingKey => `${input.workspaceId}:${input.sessionId}:${input.acpSessionId}:${input.userId}`;

const cloneModelUsage = (
  modelUsage: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  if (!modelUsage) return undefined;
  const cloned: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    cloned[model] = { ...usage };
  }
  return cloned;
};

const cloneUsageUpdate = (update: SessionUsageUpdate): SessionUsageUpdate => ({
  sessionId: update.sessionId,
  usage: { ...update.usage },
  ...(update.modelUsage ? { modelUsage: cloneModelUsage(update.modelUsage) } : {}),
  ...(update.delta
    ? {
        delta: {
          usage: { ...update.delta.usage },
          modelUsage: cloneModelUsage(update.delta.modelUsage) ?? {},
        },
      }
    : {}),
});

// Core can carry fields the legacy persistence endpoint does not accept.
const persistedCounters = (usage: SessionUsageUpdate['usage']) => {
  const counters: SessionUsageUpdate['usage'] = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
  };
  for (const key of ['cacheCreationInputTokens', 'reasoningOutputTokens', 'costUSD'] as const) {
    if (usage[key] !== undefined) counters[key] = usage[key];
  }
  return counters;
};

export class UsageTrackingService {
  private readonly client: ConvexHttpClient;
  private readonly cliToken: string;
  private readonly logger: Logger;
  private readonly pending = new Map<PendingKey, PendingState>();
  private readonly sessionToPendingKeys = new Map<string, Set<PendingKey>>();

  constructor(config: UsageTrackingServiceConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.cliToken = config.cliToken;
    this.logger = config.logger;
  }

  recordSessionUsageUpdate(input: RecordSessionUsageInput): void {
    const key = toPendingKey(input);
    // Own the snapshot while coalescing or retrying delivery.
    const update = this.calculatePrice(cloneUsageUpdate(input.update), input.cliType);
    const latestMeta = {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      acpSessionId: input.acpSessionId,
      userId: input.userId,
      machineId: input.machineId,
      cliType: input.cliType,
    } as const;

    const existing = this.pending.get(key);
    if (existing) {
      existing.latestMeta = latestMeta;
      existing.staged = update;
      return;
    }

    const state: PendingState = {
      latestMeta,
      staged: update,
      unacknowledged: null,
      inFlight: null,
    };
    this.pending.set(key, state);
    this.addPendingKeyToSession(input.sessionId, key);
  }

  async flushSessionUsage(sessionId: string): Promise<void> {
    const keys = [...(this.sessionToPendingKeys.get(sessionId) ?? [])];
    await Promise.all(keys.map((key) => this.flushKey(key)));
  }

  private async flushKey(key: PendingKey): Promise<void> {
    const state = this.pending.get(key);
    if (!state) return;

    if (state.inFlight) {
      await state.inFlight;
      return;
    }

    state.inFlight = this.drainPending(state).finally(() => {
      state.inFlight = null;
      this.maybeCleanupPendingState(key);
    });
    await state.inFlight;
  }

  private async drainPending(state: PendingState): Promise<void> {
    for (;;) {
      if (!state.unacknowledged) {
        const update = state.staged;
        if (!update) return;
        state.unacknowledged = { ...state.latestMeta, update };
        state.staged = null;
      }
      const snapshot = state.unacknowledged;
      const { update, ...meta } = snapshot;
      if (!update.modelUsage || Object.keys(update.modelUsage).length === 0) {
        this.logger.debug(
          `[usage] Skipping persist for session=${meta.sessionId} acpSessionId=${meta.acpSessionId}: missing modelUsage`
        );
        state.unacknowledged = null;
        continue;
      }
      try {
        const result = await this.client.mutation(api.usage.upsertSessionUsageFromCli, {
          cliToken: this.cliToken,
          ...meta,
          usage: {
            ...persistedCounters(update.usage),
            ...(update.usage.contextWindow !== undefined
              ? { contextWindow: update.usage.contextWindow }
              : {}),
          },
          modelUsage: Object.fromEntries(
            Object.entries(update.modelUsage).map(([model, usage]) => [
              model,
              persistedCounters(usage),
            ])
          ),
        });
        if (!result.success) throw new Error('Usage persistence was not acknowledged');
        state.unacknowledged = null;
      } catch (error: unknown) {
        this.logger.debug(
          `[usage] Failed to persist usage for session=${meta.sessionId} acpSessionId=${meta.acpSessionId}: ${formatErrorMessage(error)}`
        );
        // Leave the exact payload at the head, ahead of newer updates. A later
        // explicit flush retries it; concurrent flush callers share this attempt.
        return;
      }
    }
  }

  private addPendingKeyToSession(sessionId: string, key: PendingKey): void {
    const keys = this.sessionToPendingKeys.get(sessionId);
    if (keys) {
      keys.add(key);
      return;
    }
    this.sessionToPendingKeys.set(sessionId, new Set([key]));
  }

  private removePendingKeyFromSession(sessionId: string, key: PendingKey): void {
    const keys = this.sessionToPendingKeys.get(sessionId);
    if (!keys) return;
    keys.delete(key);
    if (keys.size === 0) {
      this.sessionToPendingKeys.delete(sessionId);
    }
  }

  private maybeCleanupPendingState(key: PendingKey): void {
    const state = this.pending.get(key);
    if (!state) return;
    if (state.inFlight) return;
    if (state.staged || state.unacknowledged) return;

    this.pending.delete(key);
    this.removePendingKeyFromSession(state.latestMeta.sessionId, key);
  }

  private calculatePrice(
    update: SessionUsageUpdate,
    cliType: BuiltinAgentType
  ): SessionUsageUpdate {
    switch (cliType) {
      case 'claude':
        return update;
      case 'codex':
      case 'kimi':
        if (!update.modelUsage) return update;
        for (const [model, usage] of Object.entries(update.modelUsage)) {
          if (usage.costUSD !== undefined) continue;
          // No cache-write tariff is known in this legacy price table. A read
          // tariff is not a substitute; preserve unknown rather than underprice.
          if ((usage.cacheCreationInputTokens ?? 0) > 0) continue;
          let costUSD = 0;
          const modelName = model.split('/')[0];
          if (!modelName) continue;
          const price = PRICE_DATA[modelName];
          if (!price) {
            this.logger.debug(`${modelName} have not set price`);
            continue;
          }
          costUSD += usage.inputTokens * price.inputCostPerToken;
          costUSD +=
            (usage.outputTokens + (usage.reasoningOutputTokens || 0)) * price.outputCostPerToken;
          costUSD +=
            (usage.cacheReadInputTokens + (usage.cacheCreationInputTokens || 0)) *
            price.cacheReadInputTokenCost;
          usage.costUSD = costUSD;
        }
        return update;
      default:
        return update;
    }
  }
}
