import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { ConvexHttpClient } from 'convex/browser';
import type { Logger } from '@/utils/logger';
import { UsageTrackingService, type RecordSessionUsageInput } from './usage-tracking-service';

type Payload = Omit<RecordSessionUsageInput, 'update'> & RecordSessionUsageInput['update'];
const logger: Logger = {
  info() {},
  warn() {},
  error() {},
  success() {},
  debug() {},
  setLevel() {},
  child: () => logger,
  close: async () => {},
};
const input = (
  tokens: number,
  cliType: RecordSessionUsageInput['cliType'] = 'grok'
): RecordSessionUsageInput => {
  const usage = {
    inputTokens: tokens,
    outputTokens: 20,
    cacheReadInputTokens: 30,
    cacheCreationInputTokens: 40,
    reasoningOutputTokens: 50,
  };
  return {
    workspaceId: 'w',
    sessionId: 's',
    acpSessionId: 'a',
    userId: 'u',
    machineId: 'm',
    cliType,
    update: { sessionId: 'a', usage, modelUsage: { synthetic: { ...usage } } },
  };
};
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('usage delivery', () => {
  let service: UsageTrackingService;
  let persisted: Payload[];
  let deliver: (payload: Payload) => Promise<{ success: boolean }>;
  beforeEach(() => {
    persisted = [];
    deliver = async (payload) => {
      // Mirror the legacy endpoint's strict field sets, including the different
      // aggregate/model scopes. Extra fields reject the whole mutation.
      const counters = [
        'inputTokens',
        'outputTokens',
        'cacheReadInputTokens',
        'cacheCreationInputTokens',
        'reasoningOutputTokens',
        'costUSD',
      ];
      const assertFields = (row: object, allowed: string[]) => {
        if (Object.keys(row).some((key) => !allowed.includes(key))) {
          throw new Error('Unexpected usage field');
        }
      };
      assertFields(payload.usage, [...counters, 'contextWindow']);
      for (const row of Object.values(payload.modelUsage ?? {})) {
        assertFields(row, [...counters, 'webSearchRequests']);
      }
      persisted.push(structuredClone(payload));
      return { success: true };
    };
    vi.spyOn(ConvexHttpClient.prototype, 'mutation').mockImplementation(async (_method, args) =>
      deliver(args as Payload)
    );
    service = new UsageTrackingService({
      convexUrl: 'https://synthetic.convex.cloud',
      cliToken: 'synthetic',
      logger,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('projects provider fields without losing token buckets, known costs or unknown costs', async () => {
    const report = input(100);
    report.update.usage.webSearchRequests = 2;
    report.update.usage.contextWindow = 128000;
    report.update.usage.costUSD = 0.25;
    report.update.modelUsage = {
      synthetic: { ...report.update.usage },
      unknown: { ...input(50).update.usage, contextWindow: 64000 },
    };
    service.recordSessionUsageUpdate(report);
    await service.flushSessionUsage('s');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.usage).toEqual({
      ...input(100).update.usage,
      contextWindow: 128000,
      costUSD: 0.25,
    });
    expect(persisted[0]?.modelUsage).toEqual({
      synthetic: { ...input(100).update.usage, costUSD: 0.25 },
      unknown: input(50).update.usage,
    });
  });

  it.each(['claude', 'codex', 'kimi', 'grok', 'deepseek'] as const)(
    'delivers %s cumulative snapshots without adding optional delta',
    async (provider) => {
      const first = input(100, provider);
      const next = input(150, provider);
      next.update.modelUsage = { synthetic: { ...next.update.usage, costUSD: 0.125 } };
      next.update.delta = {
        usage: { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 0 },
        modelUsage: { synthetic: { inputTokens: 50, outputTokens: 0, cacheReadInputTokens: 0 } },
      };
      service.recordSessionUsageUpdate(first);
      await service.flushSessionUsage('s');
      service.recordSessionUsageUpdate(next);
      await service.flushSessionUsage('s');
      expect(persisted.map((p) => p.modelUsage?.synthetic.inputTokens)).toEqual([100, 150]);
      expect(persisted[1]?.cliType).toBe(provider);
      expect(persisted[1]?.modelUsage?.synthetic.costUSD).toBe(0.125);
      // Legacy persistence receives snapshots only; delta is retained at the ACP boundary.
      expect(persisted[1]).not.toHaveProperty('delta');
    }
  );

  it('coalesces Grok cumulative snapshots without adding their delta again', async () => {
    const first = input(100);
    service.recordSessionUsageUpdate(first);
    const latest = input(200);
    latest.update.delta = {
      usage: input(100).update.usage,
      modelUsage: { synthetic: input(100).update.usage },
    };
    service.recordSessionUsageUpdate(latest);
    // Mutating caller-owned input must not change an enqueued bill.
    latest.update.usage.inputTokens = 999;
    const latestModel = latest.update.modelUsage?.synthetic;
    if (latestModel) latestModel.inputTokens = 999;
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([200]);
    expect(persisted[0]?.modelUsage?.synthetic).toEqual(input(200).update.usage);
    expect(persisted[0]?.modelUsage?.synthetic.costUSD).toBeUndefined();
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([200]);
  });

  it('retains a rejected head ahead of later prompts and retries on a later flush', async () => {
    service.recordSessionUsageUpdate(input(100));
    service.recordSessionUsageUpdate(input(200));
    const accept = deliver;
    deliver = async () => {
      throw new Error('synthetic rejection');
    };
    await service.flushSessionUsage('s');
    expect(persisted).toEqual([]);
    service.recordSessionUsageUpdate(input(300));
    deliver = accept;
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([200, 300]);
  });

  it('treats success false as unacknowledged instead of discarding usage', async () => {
    service.recordSessionUsageUpdate(input(100));
    const accept = deliver;
    deliver = async () => ({ success: false });
    await service.flushSessionUsage('s');
    deliver = accept;
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100]);
  });

  it('drains updates arriving during delivery with concurrent flush callers', async () => {
    const entered = deferred();
    const release = deferred();
    const accept = deliver;
    deliver = async (payload) => {
      entered.resolve();
      await release.promise;
      return accept(payload);
    };
    service.recordSessionUsageUpdate(input(100));
    const first = service.flushSessionUsage('s');
    await entered.promise;
    service.recordSessionUsageUpdate(input(200));
    const second = service.flushSessionUsage('s');
    release.resolve();
    await Promise.all([first, second]);
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100, 200]);
  });

  it('concurrent flushes do not spin on a rejected request or lose newer usage', async () => {
    const entered = deferred();
    const release = deferred();
    const accept = deliver;
    deliver = async () => {
      entered.resolve();
      await release.promise;
      throw new Error('synthetic');
    };
    service.recordSessionUsageUpdate(input(100));
    const first = service.flushSessionUsage('s');
    await entered.promise;
    service.recordSessionUsageUpdate(input(200));
    const second = service.flushSessionUsage('s');
    release.resolve();
    await Promise.all([first, second]);
    deliver = accept;
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100, 200]);
  });

  it('retains cumulative-provider coalescing and Codex compaction', async () => {
    service.recordSessionUsageUpdate(input(100, 'claude'));
    service.recordSessionUsageUpdate(input(200, 'claude'));
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([200]);
    persisted = [];
    service.recordSessionUsageUpdate(input(100, 'codex'));
    const reset = input(0, 'codex');
    reset.update.usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    reset.update.modelUsage = { synthetic: { ...reset.update.usage } };
    service.recordSessionUsageUpdate(reset);
    service.recordSessionUsageUpdate(input(20, 'codex'));
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([120]);
  });

  it('keeps legacy Codex compaction offsets after acknowledgement without inventing cost', async () => {
    service.recordSessionUsageUpdate(input(1000, 'codex'));
    await service.flushSessionUsage('s');
    const reset = input(0, 'codex');
    reset.update.usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    reset.update.modelUsage = { synthetic: { ...reset.update.usage } };
    service.recordSessionUsageUpdate(reset);
    await service.flushSessionUsage('s');
    service.recordSessionUsageUpdate(input(50, 'codex'));
    await service.flushSessionUsage('s');
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.modelUsage?.synthetic.inputTokens)).toEqual([1000, 1000, 1050]);
    expect(persisted[2]?.modelUsage?.synthetic.costUSD).toBeUndefined();
  });

  it('does not apply legacy compaction to adapter-owned cumulative accounting', async () => {
    const update = input(1000, 'codex');
    update.update.delta = {
      usage: update.update.usage,
      modelUsage: { synthetic: update.update.usage },
    };
    service.recordSessionUsageUpdate(update);
    await service.flushSessionUsage('s');
    const next = input(1050, 'codex');
    next.update.usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 };
    next.update.delta = { usage: next.update.usage, modelUsage: { synthetic: next.update.usage } };
    service.recordSessionUsageUpdate(next);
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.modelUsage?.synthetic.inputTokens)).toEqual([1000, 1050]);
  });

  it('keeps failed cumulative snapshots before newer cumulative snapshots', async () => {
    const accept = deliver;
    deliver = async () => {
      throw new Error('synthetic');
    };
    service.recordSessionUsageUpdate(input(100, 'claude'));
    await service.flushSessionUsage('s');
    service.recordSessionUsageUpdate(input(200, 'claude'));
    deliver = accept;
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100, 200]);
  });

  it('isolates ACP sessions and skips an unusable model map without blocking the queue', async () => {
    const missing = input(1);
    delete missing.update.modelUsage;
    service.recordSessionUsageUpdate(missing);
    await service.flushSessionUsage('s');
    expect(persisted).toEqual([]);
    service.recordSessionUsageUpdate(input(100));
    service.recordSessionUsageUpdate({ ...input(200), acpSessionId: 'b' });
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => [p.acpSessionId, p.usage.inputTokens])).toEqual([
      ['a', 100],
      ['b', 200],
    ]);
  });
});
