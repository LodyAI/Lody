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

  it('preserves each Grok prompt and every token bucket across a skipped flush', async () => {
    const first = input(100);
    service.recordSessionUsageUpdate(first);
    service.recordSessionUsageUpdate(input(200));
    // Mutating caller-owned input must not change an enqueued bill.
    first.update.usage.inputTokens = 999;
    first.update.modelUsage = {};
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100, 200]);
    expect(persisted[0]?.modelUsage?.synthetic).toEqual(input(100).update.usage);
    expect(persisted[0]?.modelUsage?.synthetic.costUSD).toBeUndefined();
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100, 200]);
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
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([100, 200, 300]);
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
    reset.update.usage.outputTokens = 0;
    service.recordSessionUsageUpdate(reset);
    service.recordSessionUsageUpdate(input(20, 'codex'));
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => p.usage.inputTokens)).toEqual([120]);
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
    service.recordSessionUsageUpdate(input(100));
    service.recordSessionUsageUpdate({ ...input(200), acpSessionId: 'b' });
    await service.flushSessionUsage('s');
    expect(persisted.map((p) => [p.acpSessionId, p.usage.inputTokens])).toEqual([
      ['a', 100],
      ['b', 200],
    ]);
  });
});
