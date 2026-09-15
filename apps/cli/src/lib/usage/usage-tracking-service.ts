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
  compacted: SessionUsageUpdate | null;
  // Legacy Codex accounting baseline outlives delivery acknowledgement.
  lastLegacyCodex: SessionUsageUpdate | null;
  // Keep one unacknowledged payload; newer updates coalesce separately in staged.
  unacknowledged: RecordSessionUsageInput | null;
  inFlight: Promise<void> | null;
};

// Keep per-ACP-session accumulation isolated to avoid snapshot baseline resets
// when one Lody session is resumed as a brand new ACP session.
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

const mergeModelUsage = (
  base: SessionUsageUpdate['modelUsage'],
  delta: SessionUsageUpdate['modelUsage']
): SessionUsageUpdate['modelUsage'] => {
  const merged: NonNullable<SessionUsageUpdate['modelUsage']> = {};
  if (base) {
    for (const [model, usage] of Object.entries(base)) {
      merged[model] = { ...usage };
    }
  }
  if (!delta) {
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  for (const [model, usage] of Object.entries(delta)) {
    const prev = merged[model];
    merged[model] = {
      inputTokens: (prev?.inputTokens ?? 0) + usage.inputTokens,
      outputTokens: (prev?.outputTokens ?? 0) + usage.outputTokens,
      cacheReadInputTokens: (prev?.cacheReadInputTokens ?? 0) + usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        (prev?.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0),
      reasoningOutputTokens:
        (prev?.reasoningOutputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0),
      ...((!prev || prev.costUSD !== undefined) && usage.costUSD !== undefined
        ? { costUSD: (prev?.costUSD ?? 0) + usage.costUSD }
        : {}),
      contextWindow: usage.contextWindow ?? prev?.contextWindow,
    };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
};

const mergeUsageUpdate = (
  base: SessionUsageUpdate,
  delta: SessionUsageUpdate
): SessionUsageUpdate => ({
  sessionId: delta.sessionId,
  usage: {
    inputTokens: base.usage.inputTokens + delta.usage.inputTokens,
    outputTokens: base.usage.outputTokens + delta.usage.outputTokens,
    cacheReadInputTokens: base.usage.cacheReadInputTokens + delta.usage.cacheReadInputTokens,
    cacheCreationInputTokens:
      (base.usage.cacheCreationInputTokens ?? 0) + (delta.usage.cacheCreationInputTokens ?? 0),
    reasoningOutputTokens:
      (base.usage.reasoningOutputTokens ?? 0) + (delta.usage.reasoningOutputTokens ?? 0),
    ...(base.usage.costUSD !== undefined && delta.usage.costUSD !== undefined
      ? { costUSD: base.usage.costUSD + delta.usage.costUSD }
      : {}),
    contextWindow: delta.usage.contextWindow ?? base.usage.contextWindow,
  },
  modelUsage: mergeModelUsage(base.modelUsage, delta.modelUsage),
});

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
    // Take ownership once; staged/compaction/delivery only replace or merge snapshots.
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
      this.applyUpdateToState(existing, input.cliType, update);
      return;
    }

    const state: PendingState = {
      latestMeta,
      staged: null,
      compacted: null,
      lastLegacyCodex: null,
      unacknowledged: null,
      inFlight: null,
    };
    this.applyUpdateToState(state, input.cliType, update);
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
        const update = this.buildFinalUpdate(state);
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

  private applyUpdateToState(
    state: PendingState,
    cliType: BuiltinAgentType,
    update: SessionUsageUpdate
  ): void {
    if (cliType === 'codex' && !update.delta && this.isCodexCompaction(update)) {
      if (state.lastLegacyCodex && !this.isCodexCompaction(state.lastLegacyCodex)) {
        state.compacted = state.compacted
          ? mergeUsageUpdate(state.compacted, state.lastLegacyCodex)
          : state.lastLegacyCodex;
      }
      state.lastLegacyCodex = update;
      state.staged = update;
      return;
    }
    if (cliType === 'codex' && !update.delta) state.lastLegacyCodex = update;
    else {
      state.lastLegacyCodex = null;
      state.compacted = null;
    }
    state.staged = update;
  }

  private buildFinalUpdate(state: PendingState): SessionUsageUpdate | null {
    if (!state.staged) {
      return null;
    }
    if (!state.compacted) {
      return state.staged;
    }
    return mergeUsageUpdate(state.compacted, state.staged);
  }

  private isCodexCompaction(update: SessionUsageUpdate): boolean {
    return (
      update.usage.inputTokens === 0 &&
      update.usage.outputTokens === 0 &&
      update.usage.cacheReadInputTokens === 0 &&
      (update.usage.cacheCreationInputTokens ?? 0) === 0 &&
      (update.usage.reasoningOutputTokens ?? 0) === 0
    );
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
    if (state.staged || state.compacted || state.unacknowledged) return;
    if (state.lastLegacyCodex) return;

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
