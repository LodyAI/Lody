import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Run from the repository root; pass an installed esbuild module path.
const { build } = await import(pathToFileURL(process.argv[2]));
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'grok-usage-fixture-'));
console.log(`Generated bundles: ${scratch}`);
const core = `${root}/packages/acp-extension-core/src/index.ts`;
const aliases = { 'acp-extension-core': core };
await build({
  entryPoints: [`${root}/packages/acp-extension-grok/src/proxy.js`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: aliases,
  outfile: `${scratch}/proxy.mjs`,
});
await build({
  entryPoints: [`${root}/packages/acp-extension-grok/test/proxy.test.js`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: aliases,
  outfile: `${scratch}/existing-tests.mjs`,
});
await build({
  entryPoints: [`${root}/apps/cli/src/lib/usage/usage-tracking-service.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: `${scratch}/service.mjs`,
  plugins: [
    {
      name: 'offline-boundaries',
      setup(b) {
        b.onResolve(
          { filter: /^(convex\/browser|@lody\/cloud-api|@\/utils\/format-error)$/ },
          (args) => ({ path: args.path, namespace: 'offline' })
        );
        b.onLoad({ filter: /.*/, namespace: 'offline' }, (args) => ({
          contents:
            args.path === 'convex/browser'
              ? 'export class ConvexHttpClient { async mutation(api,params){ globalThis.captured.push(structuredClone(params)); if(globalThis.failMutation) throw new Error("synthetic failure"); return {success:true}; } }'
              : args.path === '@lody/cloud-api'
                ? 'export const api={usage:{upsertSessionUsageFromCli:"synthetic"}};'
                : 'export const formatErrorMessage=String;',
          loader: 'js',
        }));
      },
    },
  ],
});
const { GrokAcpCompatibilityProxy, normalizePromptUsage } = await import(
  pathToFileURL(`${scratch}/proxy.mjs`)
);
const { UsageTrackingService } = await import(pathToFileURL(`${scratch}/service.mjs`));
const raw = (input = 1000, output = 250) => ({
  inputTokens: input,
  outputTokens: output,
  cachedReadTokens: 300,
  cacheCreationTokens: 100,
  reasoningTokens: 50,
  costUsdTicks: 250000000,
  modelUsage: {
    synthetic: {
      inputTokens: input,
      outputTokens: output,
      cachedReadTokens: 300,
      cacheCreationTokens: 100,
      reasoningTokens: 50,
      costUsdTicks: 250000000,
    },
  },
});
const total = (u) =>
  u.inputTokens +
  u.outputTokens +
  u.cacheReadInputTokens +
  (u.cacheCreationInputTokens ?? 0) +
  (u.reasoningOutputTokens ?? 0);
function proxy() {
  const p = new GrokAcpCompatibilityProxy();
  p.handleClient({ id: 1, method: 'session/new', params: { cwd: '/synthetic', mcpServers: [] } });
  p.handleRuntime({
    id: 1,
    result: {
      sessionId: 's',
      models: {
        currentModelId: 'synthetic',
        availableModels: [{ modelId: 'synthetic', name: 'Synthetic' }],
      },
    },
  });
  return p;
}
function completion(p, id, usage, replay = false) {
  return p
    .handleRuntime({
      method: '_x.ai/session/update',
      params: {
        sessionId: 's',
        _meta: { isReplay: replay },
        update: { sessionUpdate: 'turn_completed', prompt_id: id, usage },
      },
    })
    .toClient.filter((m) => m.method === '_lody/session/usage_update');
}
const p = proxy();
const one = completion(p, 'p1', raw())[0].params;
const two = completion(p, 'p2', raw(2000, 500))[0].params;
assert.equal(total(one.usage), 1250);
assert.equal(total(two.usage), 2500);
assert.equal(one.usage.costUSD, 0.025);
assert.equal(completion(p, 'p1', raw()).length, 0);
assert.equal(completion(p, 'history', raw(), true).length, 0);
const q = proxy();
assert.equal(completion(q, 'partial', { usageIsIncomplete: true }).length, 1);
assert.equal(completion(q, 'partial', raw()).length, 0);
const r = proxy();
r.handleClient({ id: 20, method: 'session/prompt', params: { sessionId: 's', prompt: [] } });
const first = r.handleRuntime({
  id: 20,
  result: { stopReason: 'end_turn', _meta: { promptId: 'p', usage: { usageIsIncomplete: true } } },
});
assert.equal(first.toClient.filter((m) => m.method === '_lody/session/usage_update').length, 1);
assert.equal(completion(r, 'p', raw()).length, 0);
const logger = { debug() {} };
globalThis.captured = [];
function service() {
  return new UsageTrackingService({
    convexUrl: 'https://synthetic.invalid',
    cliToken: 'synthetic',
    logger,
  });
}
function record(s, update) {
  s.recordSessionUsageUpdate({
    workspaceId: 'w',
    sessionId: 's',
    acpSessionId: 'a',
    userId: 'u',
    machineId: 'm',
    cliType: 'grok',
    update,
  });
}
const s = service();
record(s, one);
record(s, two);
await s.flushSessionUsage('s');
assert.deepEqual(
  captured.map((x) => total(x.usage)),
  [1250, 2500]
);
console.log('two prompt deltas before one flush: emitted both, sum 3750');
globalThis.captured = [];
const t = service();
record(t, one);
await t.flushSessionUsage('s');
record(t, two);
await t.flushSessionUsage('s');
assert.deepEqual(
  captured.map((x) => total(x.usage)),
  [1250, 2500]
);
console.log(
  'flush each prompt: emitted [1250,2500], not session snapshots [1250,3750]; backend interpretation untested'
);
globalThis.captured = [];
const v = service();
record(v, { sessionId: 's', ...normalizePromptUsage({ inputTokens: 1000, outputTokens: 250 }) });
await v.flushSessionUsage('s');
assert.equal(captured.length, 0);
console.log(
  'service without modelUsage: no persistence; AgentClient normally supplies current model fallback'
);
console.log(
  'inclusive buckets conserve 1250; incomplete-first suppresses later complete 1250; duplicate and replay checks passed'
);
globalThis.captured = [];
globalThis.failMutation = true;
const failed = service();
record(failed, one);
await failed.flushSessionUsage('s');
globalThis.failMutation = false;
await failed.flushSessionUsage('s');
assert.equal(captured.length, 2);
assert.deepEqual(captured[0], captured[1]);
console.log('failed persistence then retry flush: identical payload retried successfully');
const multi = normalizePromptUsage({
  ...raw(3000, 750),
  cachedReadTokens: 600,
  cacheCreationTokens: 200,
  reasoningTokens: 100,
  costUsdTicks: 500000000,
  modelUsage: { a: raw().modelUsage.synthetic, b: raw(2000, 500).modelUsage.synthetic },
});
assert.deepEqual(Object.keys(multi.modelUsage), ['a', 'b']);
assert.equal(total(multi.modelUsage.b), 2500);
assert.equal(total(multi.usage), 3750);
console.log('multiple model rows survive normalization');
