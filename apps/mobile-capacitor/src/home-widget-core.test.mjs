import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createHomeWidgetSync,
  resolveHomeWidgetScope,
  toHomeWidgetConversations,
} from './home-widget-core.ts';
import {
  buildTokenWidgetSummary,
  resolveTokenWidgetPublication,
} from './token-usage-widget-core.ts';
import { createWidgetFixture } from './home-widget-test-fixture.mjs';
import { buildProviderQuotaWidgetSummary } from './provider-quota-widget-core.ts';

const summary = {
  userId: 'user-a',
  workspaceId: 'workspace-a',
  workspaceName: 'Example',
  items: [
    {
      id: 'session-a',
      title: 'Fix sync',
      status: 'running',
      agentLogoKind: 'codex',
      agentLogoText: 'CX',
      agentName: 'Codex',
      updatedAt: 1000,
    },
  ],
};

void test('only matching authenticated, ready workspace metadata can be published', () => {
  const runtime = {
    workspaceId: 'workspace-a',
    workspaceSlug: 'example',
    accountId: 'user-a',
    contentMode: 'plaintext',
  };
  const metadata = { ...runtime, runtime, ready: true };
  const input = { userId: 'user-a', hasAuthToken: true, slug: 'example', runtime, metadata };
  assert.deepEqual(resolveHomeWidgetScope(input), {
    userId: 'user-a',
    workspaceId: 'workspace-a',
    workspaceName: 'example',
  });
  for (const change of [
    { userId: null },
    { hasAuthToken: false },
    { slug: null },
    { runtime: null },
    { slug: 'other-workspace' },
    { metadata: null },
    { metadata: { ...metadata, ready: false } },
    { metadata: { ...metadata, workspaceId: 'workspace-b' } },
    { metadata: { ...metadata, runtime: { ...runtime } } },
  ])
    assert.equal(resolveHomeWidgetScope({ ...input, ...change }), null);
});

void test('ready metadata cannot publish under a different or missing runtime account', () => {
  for (const accountId of ['user-b', null, undefined]) {
    const runtime = {
      workspaceId: 'workspace-a',
      workspaceSlug: 'example',
      accountId,
      contentMode: 'plaintext',
    };
    assert.equal(
      resolveHomeWidgetScope({
        userId: 'user-a',
        hasAuthToken: true,
        slug: 'example',
        runtime,
        metadata: { ...runtime, runtime, ready: true },
      }),
      null
    );
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(write = async () => {}) {
  // The adapter persists to an in-memory boundary; assertions inspect the
  // resulting state rather than native call counts.
  let current = summary;
  let storage;
  let scheduled;
  const retries = new Set();
  let now = 0;
  const errors = [];
  const sync = createHomeWidgetSync({
    read: () => current,
    sync: async (value) => {
      await write(value);
      storage = value;
    },
    schedule: (callback) => {
      scheduled = callback;
      return () => {
        scheduled = undefined;
      };
    },
    scheduleRetry: (callback, delayMs) => {
      const retry = { callback, at: now + delayMs };
      retries.add(retry);
      return () => retries.delete(retry);
    },
    now: () => now,
    onError: (error) => errors.push(error),
  });
  return {
    sync,
    errors,
    set: (value) => {
      current = value;
    },
    advance: (ms) => {
      now += ms;
    },
    stored: () => storage,
    async retry() {
      const retry = [...retries].sort((a, b) => a.at - b.at)[0];
      if (!retry) return false;
      retries.delete(retry);
      now = retry.at;
      retry.callback();
      await sync.whenIdle();
      return true;
    },
    flush: async () => {
      const callback = scheduled;
      scheduled = undefined;
      callback?.();
      await sync.whenIdle();
    },
  };
}

void test('publishes the newest snapshot at the original deadline during a burst', async () => {
  const f = fixture();
  f.sync.refresh();
  f.set({ ...summary, items: [{ ...summary.items[0], title: 'Fix sync reconnect' }] });
  f.sync.refresh();
  f.set({ ...summary, items: [{ ...summary.items[0], title: 'Fix sync recovery' }] });
  f.sync.refresh();
  await f.flush();
  assert.deepEqual(f.stored(), {
    ...summary,
    items: [{ ...summary.items[0], title: 'Fix sync recovery' }],
  });
});

void test('logout clears pending data immediately and an old write cannot restore it', async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture(async (value) => {
    if (value) {
      started.resolve();
      await finish.promise;
    }
  });
  f.sync.refresh({ immediate: true });
  await started.promise;
  f.set({ ...summary, items: [{ ...summary.items[0], title: 'Review sync recovery' }] });
  f.sync.refresh();
  f.set(null);
  f.sync.refresh({ immediate: true });
  finish.resolve();
  await f.sync.whenIdle();
  assert.equal(f.stored(), null);
  await f.flush();
  assert.equal(f.stored(), null);
});

void test('workspace replacement wins over an in-flight snapshot', async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture(async (value) => {
    if (value?.workspaceId === summary.workspaceId) {
      started.resolve();
      await finish.promise;
    }
  });
  f.sync.refresh({ immediate: true });
  await started.promise;
  const replacement = { ...summary, userId: 'user-b', workspaceId: 'workspace-b', items: [] };
  f.set(replacement);
  f.sync.refresh({ immediate: true });
  finish.resolve();
  await f.sync.whenIdle();
  assert.deepEqual(f.stored(), replacement);
});

void test('a failed native write remains retryable with unchanged input', async () => {
  let rejectWrite = true;
  const f = fixture(async () => {
    if (rejectWrite) throw new Error('unavailable');
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.equal(f.stored(), undefined);
  assert.equal(f.errors[0].message, 'unavailable');
  rejectWrite = false;
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.deepEqual(f.stored(), summary);
});

void test('a rejected native write recovers without another input or foreground event', async () => {
  let unavailable = true;
  const f = fixture(async () => {
    if (unavailable) throw new Error('unavailable');
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.equal(f.stored(), undefined);
  unavailable = false;
  assert.equal(await f.retry(), true);
  assert.deepEqual(f.stored(), summary);
  assert.equal(await f.retry(), false);
});

void test('automatic retries are bounded and an explicit resume can rearm recovery', async () => {
  let unavailable = true;
  const f = fixture(async () => {
    if (unavailable) throw new Error('unavailable');
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  for (let attempt = 0; attempt < 3; attempt++) assert.equal(await f.retry(), true);
  assert.equal(await f.retry(), false);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.equal(await f.retry(), false, 'unchanged input must not reset the automatic budget');
  unavailable = false;
  f.sync.refresh({ immediate: true, force: true });
  await f.sync.whenIdle();
  assert.deepEqual(f.stored(), summary);
});

void test('a delayed retry reads the current owner instead of the failed snapshot', async () => {
  let unavailable = true;
  const f = fixture(async () => {
    if (unavailable) throw new Error('unavailable');
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  f.set(null);
  unavailable = false;
  await f.retry();
  assert.equal(f.stored(), null);
});

void test('a lost native acknowledgement cannot suppress a required clear', async () => {
  let native;
  let loseAcknowledgement = false;
  const f = fixture(async (value) => {
    native = value;
    if (loseAcknowledgement) throw new Error('acknowledgement lost');
  });
  f.set(null);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  loseAcknowledgement = true;
  f.set(summary);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.deepEqual(native, summary);
  loseAcknowledgement = false;
  f.set(null);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.equal(native, null);
  assert.equal(await f.retry(), false);
});

void test('required clear waits for bounded recovery before disposal', async () => {
  let failClear = true;
  const f = fixture(async (value) => {
    if (value === null && failClear) {
      failClear = false;
      throw new Error('unavailable');
    }
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  f.set(null);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  let settled = false;
  const finished = f.sync.whenSettled().then(() => {
    settled = true;
  });
  assert.equal(settled, false);
  await f.retry();
  await finished;
  await f.sync.stop();
  assert.equal(f.stored(), null);
});

void test('disposal cancels a deferred retry without starting another native write', async () => {
  let unavailable = true;
  const f = fixture(async () => {
    if (unavailable) throw new Error('unavailable');
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  await f.sync.stop();
  unavailable = false;
  assert.equal(await f.retry(), false);
  assert.equal(f.stored(), undefined);
});

void test('unchanged data renews freshness on a heartbeat or app resume', async () => {
  let rejectWrite = false;
  const f = fixture(async () => {
    if (rejectWrite) throw new Error('unavailable');
  });
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  rejectWrite = true;
  f.advance(30_000);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.equal(f.errors.length, 0);
  f.advance(5 * 60_000);
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  assert.equal(f.errors[0].message, 'unavailable');
  rejectWrite = false;
  f.sync.refresh({ immediate: true, force: true });
  await f.sync.whenIdle();
  assert.deepEqual(f.stored(), summary);
});

void test('disposal cancels queued work and does not destroy the saved snapshot', async () => {
  const f = fixture();
  f.sync.refresh({ immediate: true });
  await f.sync.whenIdle();
  f.set(null);
  f.sync.refresh();
  await f.sync.stop();
  f.sync.refresh({ immediate: true });
  await f.flush();
  assert.deepEqual(f.stored(), summary);
});

void test('disposal awaits a raw native write which cannot be aborted', async () => {
  const started = deferred();
  const finish = deferred();
  const f = fixture(async () => {
    started.resolve();
    await finish.promise;
  });
  f.sync.refresh({ immediate: true });
  await started.promise;
  let disposed = false;
  const stop = f.sync.stop().then(() => {
    disposed = true;
  });
  assert.equal(disposed, false);
  finish.resolve();
  await stop;
  assert.equal(disposed, true);
  assert.deepEqual(f.stored(), summary);
});

void test('publishes bounded conversation metadata without permission commands or credentials', () => {
  const source = [
    {
      id: 'waiting',
      status: 'permission',
      title: '  Confirm the plan  ',
      agentLogoKind: 'claude',
      agentLogoText: 'CC',
      updatedAt: 3000,
      statusLabel: 'Request Permission',
      updatedAtLabel: 'now',
      permissionRequestId: 'private-request',
      permissionCommand: 'synthetic private command',
      authToken: 'synthetic credential',
    },
    {
      id: 'running',
      status: 'running',
      title: 'x'.repeat(120),
      agentLogoKind: 'codex',
      agentLogoText: 'CX',
      updatedAt: 2000,
      statusLabel: 'Running',
      updatedAtLabel: 'now',
    },
    {
      id: 'unread',
      status: 'unread',
      title: 'Review layout',
      agentLogoKind: 'agent',
      agentLogoText: 'ACP',
      updatedAt: 1000,
      statusLabel: 'Completed',
      updatedAtLabel: 'now',
    },
    {
      id: 'other',
      status: 'unread',
      title: 'Not on the widget',
      agentLogoKind: 'agent',
      agentLogoText: 'ACP',
      updatedAt: 0,
      statusLabel: '',
      updatedAtLabel: '',
    },
  ];
  assert.deepEqual(toHomeWidgetConversations(source, new Map([['unread', 'My agent']])), [
    {
      id: 'waiting',
      status: 'waiting',
      title: 'Confirm the plan',
      agentLogoKind: 'claude',
      agentLogoText: 'CC',
      agentName: 'Claude',
      updatedAt: 3000,
    },
    {
      id: 'running',
      status: 'running',
      title: 'x'.repeat(96),
      agentLogoKind: 'codex',
      agentLogoText: 'CX',
      agentName: 'Codex',
      updatedAt: 2000,
    },
    {
      id: 'unread',
      status: 'unread',
      title: 'Review layout',
      agentLogoKind: 'agent',
      agentLogoText: 'ACP',
      agentName: 'My agent',
      updatedAt: 1000,
    },
  ]);
  assert.equal(
    toHomeWidgetConversations([{ ...source[0], status: 'question' }], new Map())[0].status,
    'waiting'
  );
});

const tokenScope = { userId: 'user-a', workspaceId: 'workspace-a', workspaceName: 'Example' };
const tokenDayStart = Date.UTC(2026, 9, 14);
const tokenTimeline = {
  workspaceId: 'workspace-a',
  range: 'day',
  startMs: tokenDayStart,
  endMs: tokenDayStart + 90 * 60_000,
  bucketSizeMs: 3_600_000,
  totals: { tokens: 3_000_000, costUSD: 123 },
  users: { 'user-a': { email: 'synthetic@example.invalid' } },
  buckets: [
    {
      bucketStartMs: tokenDayStart,
      tokens: 2_000_000,
      byModel: [
        { modelId: 'model-b', tokens: 1_000_000 },
        { modelId: 'model-a', tokens: 1_000_000 },
      ],
    },
    {
      bucketStartMs: tokenDayStart + 3_600_000,
      tokens: 1_000_000,
      byModel: [
        { modelId: 'model-a', tokens: 750_000 },
        { modelId: 'model-c', tokens: 250_000 },
      ],
    },
    ...Array.from({ length: 22 }, (_, i) => ({
      bucketStartMs: tokenDayStart + (i + 2) * 3_600_000,
      tokens: 0,
      byModel: [],
    })),
  ],
};
const tokenFormat = (value, locale) =>
  new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const tokenBuild = (timeline = tokenTimeline, locale = 'en') =>
  buildTokenWidgetSummary({ scope: tokenScope, timeline, locale, format: tokenFormat });

void test('Token widget retains the returned UTC day and drops private usage fields', () => {
  const data = tokenBuild();
  assert.equal(data.period, 'utcDay');
  assert.equal(data.startMs, tokenTimeline.startMs);
  assert.equal(data.endMs, tokenTimeline.endMs);
  assert.deepEqual(data.total, { tokens: 3_000_000, label: '3M' });
  assert.deepEqual(data.models, [
    { name: 'model-a', value: { tokens: 1_750_000, label: '1.8M' } },
    { name: 'model-b', value: { tokens: 1_000_000, label: '1M' } },
  ]);
  assert.equal(data.breakdown, null);
  assert.equal(data.buckets.length, 24);
  assert.deepEqual(data.buckets[23], { startMs: tokenDayStart + 23 * 3_600_000, tokens: 0 });
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes('costUSD'), false);
  assert.equal(serialized.includes('synthetic@example.invalid'), false);
  assert.equal(tokenBuild(tokenTimeline, 'zh-CN').total.label, '300万');
});

void test('Token widget supports rolling windows, actual zero and optional token splits', () => {
  const rolling = { ...tokenTimeline, startMs: tokenTimeline.endMs - 24 * 3_600_000, buckets: [] };
  assert.equal(tokenBuild(rolling).period, 'window');
  const empty = {
    ...tokenTimeline,
    endMs: tokenDayStart,
    totals: { tokens: 0 },
    buckets: tokenTimeline.buckets.map((bucket) => ({ ...bucket, tokens: 0, byModel: [] })),
  };
  assert.deepEqual(tokenBuild(empty).total, { tokens: 0, label: '0' });
  assert.deepEqual(tokenBuild(empty).models, []);
  const split = tokenBuild({
    ...tokenTimeline,
    totals: {
      tokens: 3_000_000,
      breakdown: { inputTokens: 1_000_000, outputTokens: 200_000, cacheReadInputTokens: 1_800_000 },
    },
  });
  assert.deepEqual(split.breakdown, {
    input: { tokens: 1_000_000, label: '1M' },
    output: { tokens: 200_000, label: '200K' },
    cacheRead: { tokens: 1_800_000, label: '1.8M' },
  });
  for (const change of [
    { workspaceId: 'other-workspace' },
    { range: 'week' },
    { bucketSizeMs: 86_400_000 },
    { totals: { tokens: -1 } },
    { totals: { tokens: Infinity } },
    { buckets: [...tokenTimeline.buckets, tokenTimeline.buckets[0]] },
    { buckets: [{ ...tokenTimeline.buckets[23], tokens: 1 }] },
    { startMs: tokenTimeline.endMs + 1 },
  ])
    assert.equal(tokenBuild({ ...tokenTimeline, ...change }), null);
});

void test('Token publication cannot cross user, workspace, auth session or runtime generation', () => {
  const runtime = {};
  const data = tokenBuild();
  const publication = { summary: data, runtime, authSessionId: 'auth-a' };
  assert.deepEqual(resolveTokenWidgetPublication(tokenScope, runtime, 'auth-a', publication), data);
  for (const [scope, owner, auth] of [
    [null, runtime, 'auth-a'],
    [tokenScope, null, 'auth-a'],
    [tokenScope, {}, 'auth-a'],
    [tokenScope, runtime, null],
    [tokenScope, runtime, 'auth-b'],
    [{ ...tokenScope, userId: 'user-b' }, runtime, 'auth-a'],
    [{ ...tokenScope, workspaceId: 'workspace-b' }, runtime, 'auth-a'],
  ])
    assert.equal(resolveTokenWidgetPublication(scope, owner, auth, publication), null);
});

async function publishedWidgetFixture(t, options) {
  const f = await createWidgetFixture(options);
  t.after(() => f.close());
  await f.start();
  await f.publishUsage(1000);
  await f.flush();
  assert.equal(
    f.cache.get('conversation').items[0].title,
    options?.title ?? 'Synthetic private task'
  );
  assert.equal(f.cache.get('token').total.tokens, 1000);
  return f;
}

function assertWidgetCachesCleared(f) {
  assert.equal(f.cache.get('conversation'), null, 'conversation cache must remain cleared');
  assert.equal(f.cache.get('token'), null, 'Token cache must remain cleared');
}

void test('real logout intent clears both widgets before sign-out or root auth cleanup completes', async (t) => {
  const f = await publishedWidgetFixture(t);
  const originalRuntime = f.store.get(f.runtime.runtimeAtom);
  let settled = false;
  let signingOut;
  await f.change(() => {
    signingOut = f.signOut().then((outcome) => {
      settled = true;
      return outcome;
    });
  });
  assert.equal(settled, false);
  assert.equal(f.credentials.has('lody_auth_token'), false);
  assert.equal(f.store.get(f.runtime.authTokenAtom), 'synthetic-token-a');
  assert.equal(f.store.get(f.userAtom).id, 'user-a');
  assert.equal(f.store.get(f.runtime.runtimeAtom), originalRuntime);
  assertWidgetCachesCleared(f);

  // Simulate sign-out-hook cleanup followed by an already-pending get-session
  // response restoring the old identity and a later authenticated session.
  await f.setAuth({ isAuthenticated: false, authSessionId: null, confirmedUnauthenticated: true });
  await f.change(() => {
    f.store.set(f.userAtom, null);
    f.store.set(f.runtime.authTokenAtom, null);
  });
  await f.restoreOwner({ token: 'synthetic-restored-token', task: 'Late restored private task' });
  await f.setAuth({
    isAuthenticated: true,
    authSessionId: 'auth-restored',
    confirmedUnauthenticated: false,
  });
  await f.publishUsage(9000, { sessionId: 'auth-a' });
  await f.publishUsage(8000);
  await f.appState(false);
  await f.appState(true);
  await f.flush(5 * 60_000);
  assert.equal(f.store.get(f.scopeAtom), null);
  assertWidgetCachesCleared(f);
  await f.finishSignOut();
  assert.equal((await signingOut).ok, true);
  await f.appState(true);
  await f.flush();
  assertWidgetCachesCleared(f);
});

void test('an account change cannot relabel either cache while the old runtime is still ready', async (t) => {
  const f = await publishedWidgetFixture(t);
  const oldRuntime = f.store.get(f.runtime.runtimeAtom);
  await f.change(() => f.store.set(f.userAtom, { id: 'user-b' }));
  await f.flush();
  assert.equal(f.store.get(f.runtime.runtimeAtom), oldRuntime);
  assert.equal(f.store.get(f.scopeAtom), null);
  assertWidgetCachesCleared(f);
  await f.publishUsage(9000);
  await f.appState(true);
  await f.flush();
  assertWidgetCachesCleared(f);

  await f.setAuth({ authSessionId: 'auth-b' });
  await f.restoreOwner({
    id: 'user-b',
    token: 'synthetic-token-b',
    task: 'New owner private task',
  });
  await f.publishUsage(2000);
  await f.flush();
  assert.equal(f.cache.get('conversation').userId, 'user-b');
  assert.equal(f.cache.get('conversation').items[0].title, 'New owner private task');
  assert.equal(f.cache.get('token').userId, 'user-b');
  assert.equal(f.cache.get('token').total.tokens, 2000);
});

async function assertLogoutAfterPendingNativeWrite(t, dispose) {
  const f = await publishedWidgetFixture(t);
  const conversationWrite = f.blockNextWrite('conversation');
  const tokenWrite = f.blockNextWrite('token');
  await f.setTask('Old publication already crossing the native bridge');
  await f.publishUsage(6000);
  await f.advance();
  await Promise.all([conversationWrite.started, tokenWrite.started]);
  await f.change(() => {
    f.signOut();
  });
  assert.equal(f.cache.get('conversation').items[0].title, 'Synthetic private task');
  assert.equal(f.cache.get('token').total.tokens, 1000);

  let disposed = false;
  const disposing = dispose
    ? f.stopPublishers().then(() => {
        disposed = true;
      })
    : undefined;
  if (dispose) assert.equal(disposed, false, 'disposal must retain the non-abortable writes');
  conversationWrite.finish();
  tokenWrite.finish();
  if (disposing) await disposing;
  await f.flush();
  assertWidgetCachesCleared(f);
  if (dispose) assert.equal(disposed, true);
  await f.finishSignOut();
  await f.appState(true);
  await f.flush();
  assertWidgetCachesCleared(f);
}

void test('logout serializes a final clear after pending raw writes to both native caches', async (t) => {
  await assertLogoutAfterPendingNativeWrite(t, false);
});

void test('disposal during logout finishes both final clears after non-abortable native writes', async (t) => {
  await assertLogoutAfterPendingNativeWrite(t, true);
});

void test('Token disposal retains confirmed auth-loss clearing before root scope cleanup', async (t) => {
  const f = await publishedWidgetFixture(t);
  const tokenWrite = f.blockNextWrite('token');
  await f.publishUsage(6000);
  await f.advance();
  await tokenWrite.started;
  await f.setAuth({
    isAuthenticated: false,
    authSessionId: null,
    confirmedUnauthenticated: true,
  });
  assert.equal(f.store.get(f.scopeAtom).userId, 'user-a');
  let disposed = false;
  const disposing = f.stopPublishers().then(() => {
    disposed = true;
  });
  assert.equal(disposed, false);
  tokenWrite.finish();
  await disposing;
  await f.flush();
  assert.equal(f.cache.get('token'), null);
  await f.appState(true);
  await f.flush();
  assert.equal(f.cache.get('token'), null);
});

void test('initialization after an earlier logout remains suppressed, and a new page owner can publish', async (t) => {
  const cache = new Map([
    ['conversation', summary],
    ['token', tokenBuild()],
  ]);
  const oldPage = await createWidgetFixture({ cache });
  t.after(() => oldPage.close());
  oldPage.signOut();
  assert.equal(oldPage.store.get(oldPage.runtime.authTokenAtom), 'synthetic-token-a');
  await oldPage.start();
  await oldPage.publishUsage(9000);
  await oldPage.appState(true);
  await oldPage.flush();
  assert.equal(oldPage.store.get(oldPage.scopeAtom), null);
  assertWidgetCachesCleared(oldPage);
  await oldPage.finishSignOut();
  await oldPage.close();

  const newPage = await publishedWidgetFixture(t, {
    cache,
    userId: 'user-b',
    workspaceId: 'workspace-b',
    workspaceSlug: 'other',
    title: 'Fresh page private task',
    authSessionId: 'auth-b',
  });
  assert.equal(newPage.cache.get('conversation').userId, 'user-b');
  assert.equal(newPage.cache.get('conversation').workspaceId, 'workspace-b');
  assert.equal(newPage.cache.get('token').userId, 'user-b');
  assert.equal(newPage.cache.get('token').workspaceId, 'workspace-b');
});

void test('quota projection keeps actual percentages, named windows and distinct owned providers', () => {
  const source = (id, agentType, machineOwnerId = 'user-a') => ({
    id,
    agentType,
    machineOwnerId,
    online: true,
    name: agentType,
    machineName: 'Synthetic Mac',
    windows: [
      { label: '5h · Standard', remainingPercent: 0, resetsAt: 1_900_000_000 },
      { label: '5h · Fable', remainingPercent: 75, resetsAt: null },
      { label: '7d', remainingPercent: 100, resetsAt: null },
    ],
    credential: 'synthetic-secret',
  });
  const input = {
    scope: { userId: 'user-a', workspaceId: 'workspace-a', workspaceName: 'Example' },
    locale: 'zh_CN',
    sources: [
      source('codex-1', 'codex'),
      source('codex-2', 'codex'),
      source('kimi', 'kimi'),
      source('claude', 'claude'),
      source('foreign', 'claude', 'user-b'),
    ],
  };
  const projected = buildProviderQuotaWidgetSummary(input);
  assert.deepEqual(
    projected.providers.map((provider) => provider.id),
    ['codex-1', 'claude', 'kimi']
  );
  assert.deepEqual(
    projected.providers[0].windows.map((window) => [window.label, window.remainingPercent]),
    [
      ['5h · Standard', 0],
      ['5h · Fable', 75],
    ]
  );
  assert.equal(projected.providers[0].additionalWindows, 1);
  assert.equal(JSON.stringify(projected).includes('synthetic-secret'), false);
  assert.equal(buildProviderQuotaWidgetSummary({ ...input, scope: null }), null);
  assert.deepEqual(buildProviderQuotaWidgetSummary({ ...input, sources: [] }).providers, []);
  const missing = source('missing', 'claude');
  missing.windows = [{ label: '5h', remainingPercent: NaN, resetsAt: null }];
  assert.deepEqual(buildProviderQuotaWidgetSummary({ ...input, sources: [missing] }).providers, []);
});

function quotaFixtureSource(usedPercent = 24) {
  const config = {
    id: 'config-codex',
    machineId: 'machine-a',
    name: 'Codex',
    cliType: 'builtin',
    agentType: 'codex',
  };
  return {
    configs: [config],
    online: ['machine-a'],
    machines: [
      {
        id: 'machine-a',
        ownerUserId: 'user-a',
        name: 'Synthetic Mac',
        acpCapabilities: { 'config-codex': { rateLimits: { version: 1, query: true } } },
        raceLimits: {
          'provider::config-codex::codex::codex': {
            limitId: 'codex',
            scope: { providerId: 'codex' },
            windows: [
              { usedPercent, windowDurationSeconds: 18_000, resetsAtEpochSeconds: 1_900_000_000 },
            ],
          },
        },
      },
    ],
  };
}

void test('metadata loading retains owned snapshots while Token queries keep working', async (t) => {
  const f = await publishedWidgetFixture(t);
  await f.setQuotaSources(quotaFixtureSource());
  await f.startQuota();
  await f.flush();
  const conversation = structuredClone(f.cache.get('conversation'));
  const quota = structuredClone(f.cache.get('quota'));
  await f.setMetadataReady(false);
  await f.setTask('Updated after metadata refresh');
  await f.setQuotaSources(quotaFixtureSource(80));
  await f.publishUsage(2000);
  await f.flush();
  assert.equal(f.store.get(f.scopeAtom), null);
  assert.deepEqual(f.cache.get('conversation'), conversation);
  assert.deepEqual(f.cache.get('quota'), quota);
  assert.equal(f.cache.get('token').total.tokens, 2000);
  await f.setMetadataReady(true);
  await f.flush();
  assert.equal(f.cache.get('conversation').items[0].title, 'Updated after metadata refresh');
  assert.equal(f.cache.get('quota').providers[0].windows[0].remainingPercent, 20);
});

void test('pending startup cannot retain another account or workspace cache', async (t) => {
  const foreign = { ...summary, userId: 'user-b', workspaceId: 'workspace-b' };
  const cache = new Map([
    ['conversation', foreign],
    ['quota', foreign],
  ]);
  const f = await createWidgetFixture({ cache });
  t.after(() => f.close());
  await f.setMetadataReady(false);
  await f.start();
  await f.startQuota();
  await f.flush();
  assert.equal(cache.get('conversation'), null);
  assert.equal(cache.get('quota'), null);
  await f.setMetadataReady(true);
  await f.flush();
  assert.equal(cache.get('conversation').userId, 'user-a');
});

void test('all three adapters retry a transient native rejection without new data', async (t) => {
  const f = await createWidgetFixture();
  t.after(() => f.close());
  await f.setQuotaSources(quotaFixtureSource());
  const conversationFailed = f.failNextWrite('conversation');
  await f.start();
  await conversationFailed;
  const tokenFailed = f.failNextWrite('token');
  await f.publishUsage(1200);
  const quotaFailed = f.failNextWrite('quota');
  await f.startQuota();
  await f.flush();
  await Promise.all([tokenFailed, quotaFailed]);
  assert.equal(f.cache.get('conversation'), undefined);
  assert.equal(f.cache.get('token'), null);
  assert.equal(f.cache.get('quota'), undefined);
  await f.flush(1000);
  assert.equal(f.cache.get('conversation').items[0].title, 'Synthetic private task');
  assert.equal(f.cache.get('token').total.tokens, 1200);
  assert.equal(f.cache.get('quota').providers[0].windows[0].remainingPercent, 76);
});

void test('quota widget reads provider-scoped rows and refreshes through the current runtime on foreground', async (t) => {
  const f = await publishedWidgetFixture(t);
  let source = quotaFixtureSource();
  await f.setQuotaSources(source);
  const requests = [];
  f.setQuotaRefresh(async (machineId, configId) => {
    requests.push([machineId, configId]);
    source = quotaFixtureSource(60);
    await f.setQuotaSources(source);
    return true;
  });
  await f.startQuota();
  await f.flush();
  assert.equal(f.cache.get('quota').providers[0].windows[0].remainingPercent, 40);
  assert.deepEqual(requests, [['machine-a', 'config-codex']]);
  await f.appState(false);
  await f.setQuotaSources(quotaFixtureSource(80));
  await f.flush();
  assert.equal(requests.length, 1);
  await f.appState(true);
  await f.flush();
  assert.equal(f.cache.get('quota').providers[0].windows[0].remainingPercent, 40);
  assert.equal(requests.length, 2);

  await f.setQuotaSources({ ...quotaFixtureSource(80), online: [] });
  await f.flush();
  assert.equal(f.cache.get('quota').providers[0].online, false);
  assert.equal(requests.length, 2);
  await f.setQuotaSources(quotaFixtureSource(80));
  await f.flush();
  assert.equal(f.cache.get('quota').providers[0].windows[0].remainingPercent, 40);
  assert.equal(requests.length, 3);

  const unsupported = quotaFixtureSource();
  unsupported.configs[0].codexAuth = { mode: 'api-key' };
  await f.setQuotaSources(unsupported);
  await f.flush();
  assert.deepEqual(f.cache.get('quota').providers, []);
});

void test('quota logout clear survives a pending native write, disposal and late provider data', async (t) => {
  const f = await publishedWidgetFixture(t);
  await f.setQuotaSources(quotaFixtureSource());
  await f.startQuota();
  await f.flush();
  assert.equal(f.cache.get('quota').providers[0].windows[0].remainingPercent, 76);
  const raw = f.blockNextWrite('quota');
  await f.setQuotaSources(quotaFixtureSource(95));
  await f.advance();
  await raw.started;
  await f.change(() => {
    f.signOut();
  });
  const disposing = f.stopPublishers();
  raw.finish();
  await disposing;
  await f.setQuotaSources(quotaFixtureSource(0));
  await f.appState(true);
  await f.flush();
  assert.equal(f.cache.get('quota'), null);
  await f.finishSignOut();
});

void test('encrypted workspace identity clears conversation and provider quota snapshots', async (t) => {
  const f = await publishedWidgetFixture(t);
  await f.setQuotaSources(quotaFixtureSource());
  await f.startQuota();
  await f.flush();
  assert.ok(f.cache.get('conversation').items.length > 0);
  assert.ok(f.cache.get('quota').providers.length > 0);
  await f.change(() => {
    const runtime = { ...f.store.get(f.runtime.runtimeAtom), contentMode: 'e2ee' };
    f.store.set(f.runtime.runtimeAtom, runtime);
  });
  await f.flush();
  assert.equal(f.store.get(f.scopeAtom), null);
  assert.equal(f.cache.get('conversation'), null);
  assert.equal(f.cache.get('quota'), null);
  await f.setTask('Decrypted title must stay private');
  await f.setQuotaSources(quotaFixtureSource(80));
  await f.flush();
  assert.equal(f.cache.get('conversation'), null);
  assert.equal(f.cache.get('quota'), null);
});
