import { expect, it } from 'vitest';
import { computeClientDigest, packClientBundle } from '@lody/shared/plugins/digest';
import { pluginManifestSchema } from '@lody/shared/plugins/manifest-schema';
import { VerifiedBundleCache } from '../src/plugins/bundle-cache';
import { TrustedDevSessionStore } from '../src/plugins/trust';
import { PluginQueryRegistry } from '../src/plugins/query-registry';
const manifest = pluginManifestSchema.parse({
  id: 'test-example',
  sdk: '^1.0.0',
  title: 'Example',
  version: '1.0.0',
  client: 'client.js',
});
it('retries a corrupt bundle, then shares immutable verified content across installations', async () => {
  const file = async () => new Uint8Array(270000).fill(7);
  const bytes = (await packClientBundle(manifest, file))!;
  const digest = (await computeClientDigest(manifest, file))!;
  const cache = new VerifiedBundleCache();
  const page = async (offset: number) => ({
    bytes: bytes.slice(offset, offset + 262144),
    totalBytes: bytes.length,
  });
  bytes[bytes.length - 1] = 8;
  await expect(cache.load(manifest.id, digest, page)).rejects.toThrow(/digest/i);
  bytes[bytes.length - 1] = 7;
  const read = await cache.load(manifest.id, digest, page);
  read('client.js').fill(0);
  expect(
    (
      await cache.load(manifest.id, digest, async () => {
        throw Error('unexpected transfer');
      })
    )('client.js')[1]
  ).toBe(7);
});
it('revokes a dev lease on escalation and never resurrects it on downgrade or nonce reuse', () => {
  const store = new TrustedDevSessionStore();
  const entry = {
    workspaceId: 'w',
    machineId: 'm',
    manifest,
    devMode: true,
    owner: true,
    devSessionNonce: 'a'.repeat(32),
  };
  store.grant(entry);
  expect(store.allows(entry)).toBe(true);
  expect(store.allows({ ...entry, manifest: { ...manifest, machine: 'machine.js' } })).toBe(false);
  expect(store.allows(entry)).toBe(false);
  store.grant(entry);
  expect(
    store.allows({ ...entry, manifest: { ...manifest, permissions: ['unstable.rawState'] } })
  ).toBe(false);
  expect(store.allows(entry)).toBe(false);
  store.grant(entry);
  expect(store.allows({ ...entry, devSessionNonce: 'b'.repeat(32) })).toBe(false);
  expect(store.allows(entry)).toBe(false);
});
it('aborts subscribed reads on installation replacement and fences late results', async () => {
  const owner = new AbortController();
  const registry = new PluginQueryRegistry(owner.signal);
  let readSignal: AbortSignal | undefined;
  const handle = registry.query('status', 'machine', 'm', {}, async (signal) => {
    readSignal = signal;
    return 42;
  });
  handle.subscribe(() => {});
  await Promise.resolve();
  owner.abort();
  expect(readSignal?.aborted).toBe(true);
  await Promise.resolve();
  expect(handle.getSnapshot().status).toBe('loading');
});

it('evaluates identical plugin bytes with independent top-level state and shared host imports', async () => {
  const { evaluateModule } = await import('../src/plugins/module-runtime');
  const signal = new AbortController().signal;
  let serial = 0;
  const released = new Set<string>();
  const url = (s: string) => 'data:text/javascript,' + encodeURIComponent(s) + '#' + ++serial;
  const dependency = url('export const shared={count:0}');
  const evaluate = () =>
    evaluateModule(
      `import {shared} from 'react'; let local=0; export default {kind:'client-plugin',register:()=>[++local,++shared.count]}`,
      signal,
      () => dependency,
      url,
      (s) => released.add(s)
    );
  const [a, b] = await Promise.all([evaluate(), evaluate()]);
  expect(a.register({} as never)).toEqual([1, 1]);
  expect(b.register({} as never)).toEqual([1, 2]);
  expect(a.register({} as never)).toEqual([2, 3]);
  expect(released.size).toBe(2);
});

it('safe-mode startup bypasses transfer and registration after the router replaces the query', async () => {
  const { vi } = await import('vitest');
  vi.resetModules();
  vi.stubGlobal('location', { search: '?safeMode=1' });
  try {
    const { ClientPluginHost } = await import('../src/plugins/client-host');
    const host = new ClientPluginHost();
    vi.stubGlobal('location', { search: '' });
    const key = { workspaceId: 'w', sourceKey: 'local' as const, pluginId: 'recovery-example' };
    await host.reconcile(key, {
      ...key,
      digest: '0'.repeat(64),
      client: 'client.js',
      page: async () => {
        throw Error('read bundle in safe mode');
      },
      registry: () => {
        throw Error('registered in safe mode');
      },
    });
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it('bounds hot-reload history without invalidating assets on a still-mounted installation', async () => {
  async function revision(n: number) {
    const file = async () => Uint8Array.of(n);
    const bytes = (await packClientBundle(manifest, file))!;
    const digest = (await computeClientDigest(manifest, file))!;
    return { size: bytes.length, digest, page: async () => ({ bytes, totalBytes: bytes.length }) };
  }
  const [one, two] = await Promise.all([revision(1), revision(2)]);
  const cache = new VerifiedBundleCache(one.size);
  const active = await cache.load(manifest.id, one.digest, one.page);
  await cache.load(manifest.id, two.digest, two.page);
  expect(active('client.js')).toEqual(Uint8Array.of(1));
  await expect(
    cache.load(manifest.id, one.digest, async () => {
      throw Error('machine offline');
    })
  ).rejects.toThrow('machine offline');
});

it('can disable one installation during a shared transfer; the last disable cancels the transfer', async () => {
  const cache = new VerifiedBundleCache();
  const a = new AbortController();
  const b = new AbortController();
  let transfer: AbortSignal | undefined;
  const page = (_offset: number, signal: AbortSignal) => {
    transfer = signal;
    return new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    );
  };
  const first = cache.load(manifest.id, '0'.repeat(64), page, a.signal);
  const second = cache.load(manifest.id, '0'.repeat(64), page, b.signal);
  a.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(transfer?.aborted).toBe(false);
  b.abort();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  expect(transfer?.aborted).toBe(true);
});

it('delivers declared audio and revokes only the disabled installation’s playback URLs', async () => {
  const { createPluginAssets } = await import('../src/plugins/assets');
  const one = new AbortController();
  const two = new AbortController();
  const declared = ['assets/cue.mp3'];
  const files = () => Uint8Array.of(1, 2, 3);
  const a = createPluginAssets(declared, files, one.signal);
  const b = createPluginAssets(declared, files, two.signal);
  try {
    const first = a.url('./assets/cue.mp3');
    const second = b.url('assets/cue.mp3');
    expect(first).toBe(a.url('assets/cue.mp3'));
    expect(() => a.url('client.js')).toThrow('Undeclared');
    one.abort();
    await expect(fetch(first)).rejects.toThrow();
    const response = await fetch(second);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(files());
  } finally {
    one.abort();
    two.abort();
  }
});

it('binds catalog bytes and control to the routed machine and never offers control on the encrypted route', async () => {
  const { readPluginCatalog } = await import('../src/plugins/workspace-catalog');
  type Request = import('../src/plugins/workspace-catalog').RequestPlugin;
  const machineId = 'machine-a' as import('@lody/shared').MachineId;
  const content = Uint8Array.of(1, 2, 3),
    digest = 'f'.repeat(64);
  let transport: 'local' | 'encrypted' = 'local';
  const request: Request = async (target, call, options) => {
    expect(target).toBe(machineId);
    if (call.method === 'plugin/catalog')
      return {
        transport,
        type: call.method,
        installations: [{ manifest, clientDigest: digest, enabled: true }],
      };
    if (call.method === 'plugin/bundle-chunk') {
      expect(options?.requireLocal).toBe(true);
      expect(call.params.clientDigest).toBe(digest);
      return {
        transport,
        type: call.method,
        base64: btoa(String.fromCharCode(...content)),
        totalBytes: 3,
      };
    }
    throw Error('Unexpected call');
  };
  const load = () =>
    readPluginCatalog('w', { machineId, owner: false }, request, () => {
      throw Error('unexpected registration');
    });
  const [local] = await load();
  expect(local?.sourceKey).toBe('local');
  expect((await local!.page(0, new AbortController().signal)).bytes).toEqual(content);
  transport = 'encrypted';
  const [remote] = await load();
  expect(remote?.sourceKey).toBe('machine:machine-a');
  expect(remote?.control).toBeUndefined();
  expect(remote?.dev.owner).toBe(false);
});

it('reads the current workspace catalog and fences a retained installation binding', async () => {
  const { WorkspacePluginReads } = await import('../src/plugins/workspace-client');
  const { lodyQueries } = await import('@lody/plugin-sdk');
  const store = new WorkspacePluginReads('w');
  const lease = new AbortController();
  const { read } = store.bindings(lease.signal);
  const workspace = { workspaceId: 'w' } as import('@lody/plugin-sdk').WorkspaceRef;
  store.publish({ projects: [], agentRoles: { synced: false, items: [] } });
  expect((await read(workspace, lodyQueries.agentRoles)).synced).toBe(false);
  store.publish({ projects: [], agentRoles: { synced: true, items: [] } });
  expect((await read(workspace, lodyQueries.agentRoles)).synced).toBe(true);
  lease.abort();
  await expect(read(workspace, lodyQueries.agentRoles)).rejects.toThrow();
});

it('delivers submitted, waiting and completed cues to sound-effects without replaying mounted history', async () => {
  const { default: sound } =
    await import('../../../scripts/fixtures/plugin-sdk/examples/sound-effects/client');
  const { messageSubmitted, PluginTurnTransitions } = await import('../src/plugins/session-events');
  const { clientPluginEvents } = await import('../src/plugins/client-events');
  const owner = new AbortController(),
    played: string[] = [];
  const Original = globalThis.Audio;
  const session = {
    id: 'session',
    machineId: 'machine',
  } as import('../src/plugins/session-events').SessionIdentity;
  const audioCue = Promise.withResolvers<void>();
  globalThis.Audio = class extends EventTarget {
    constructor(readonly src: string) {
      super();
    }
    async play() {
      played.push(this.src);
      if (played.length === 3) audioCue.resolve();
    }
    pause() {}
  } as unknown as typeof Audio;
  try {
    const events = clientPluginEvents.subscribe('w', owner.signal, audioCue.reject);
    sound.register({
      signal: owner.signal,
      events,
      assets: { url: (p: string) => p },
      config: { get: () => ({ pack: 'a', volume: 1, playOnSend: true }) },
    } as never);
    const transitions = new PluginTurnTransitions();
    const turn = {
      id: 't',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00Z',
      fileDiff: [],
    } as const;
    const historical = { ...turn, id: 'h', finished: true, fileDiff: [] };
    transitions.observe('w', session, [historical]);
    messageSubmitted('other', session);
    messageSubmitted('w', session);
    const waiting = {
      ...turn,
      fileDiff: [],
      items: [
        {
          type: 'tool_call' as const,
          toolCallId: 'tool',
          status: 'pending' as const,
          permissionRequest: { requestId: 'r', options: [] },
        },
      ],
    };
    transitions.observe('w', session, [historical, waiting]);
    transitions.observe('w', session, [historical, waiting]);
    transitions.observe('w', session, [historical, { ...waiting, finished: true }]);
    await audioCue.promise;
    expect(played).toEqual([
      './assets/a-send.mp3',
      './assets/a-question.mp3',
      './assets/a-complete.mp3',
    ]);
  } finally {
    owner.abort();
    globalThis.Audio = Original;
  }
});

it('keeps the precise child opener in focus-sidebar queries and scopes before paging', async () => {
  const { WorkspacePluginReads } = await import('../src/plugins/workspace-client');
  const { summarizeSession } = await import('../src/plugins/workspace-sessions');
  const { lodyQueries } = await import('@lody/plugin-sdk');
  const meta = (id: string, machineId: string, parentSessionId?: string) =>
    summarizeSession(
      'ws',
      {
        id,
        machineId,
        parentSessionId,
        userId: 'me',
        title: id,
        createdAt: '2026-01-01T00:00:00Z',
        status: { type: 'running' },
        cliType: 'builtin',
        agentType: 'sorbet',
      } as import('@lody/shared').SessionMeta,
      'me',
      true
    );
  const root = meta('root', 'a'),
    tab = meta('tab', 'a', 'root'),
    child = { ...meta('child', 'a'), openedBySessionId: 'tab', openedByRootSessionId: 'root' },
    other = meta('elsewhere', 'b');
  const store = new WorkspacePluginReads('ws');
  store.publish({
    projects: [],
    agentRoles: { items: [], synced: true },
    sessions: [other, child, root, tab],
  });
  const { read } = store.bindings(new AbortController().signal, 'focus');
  const machine = { workspaceId: 'ws', machineId: 'a' } as import('@lody/plugin-sdk').MachineRef;
  const made = summarizeSession(
    'ws',
    {
      id: 'made',
      machineId: 'a',
      createdAt: '2026-01-02T00:00:00Z',
      createdByPluginId: 'focus',
      businessKey: 'task',
    } as import('@lody/shared').SessionMeta,
    'me',
    true
  );
  const pluginStore = new WorkspacePluginReads('ws');
  pluginStore.publish({
    projects: [],
    agentRoles: { items: [], synced: true },
    sessions: [made, root],
  });
  const provenance = { businessKey: 'task', createdByPlugin: true };
  expect(
    (
      await pluginStore
        .bindings(new AbortController().signal, 'focus')
        .read(machine, lodyQueries.sessions, provenance)
    ).items.map((s) => s.session.sessionId)
  ).toEqual(['made']);
  expect(
    (
      await pluginStore
        .bindings(new AbortController().signal, 'other')
        .read(machine, lodyQueries.sessions, provenance)
    ).items
  ).toEqual([]);
  const filter = {
    rootSessionId: 'root',
    createdByMe: true,
    status: 'busy',
    archived: false,
    limit: 2,
  } as const;
  const first = await read(machine, lodyQueries.sessions, filter);
  expect(first.items.map((s) => s.session.sessionId)).toEqual(['child', 'root']);
  expect(first.items[0]?.openedBySessionId).toBe('tab');
  expect(
    (await read(machine, lodyQueries.sessions, { ...filter, cursor: first.nextCursor })).items.map(
      (s) => s.session.sessionId
    )
  ).toEqual(['tab']);
});

it('appends plugin text and files to the same draft the session composer hydrates', async () => {
  const {
    appendUnmountedSessionDraft,
    hydrateSessionDraft,
    getSessionFileDrafts,
    sessionDraftsCache,
  } = await import('../src/lib/session-composer-drafts');
  const sessionId = 'plugin-offscreen-draft' as import('@lody/shared').SessionId;
  sessionDraftsCache.set(sessionId, 'Unsent: ');
  appendUnmountedSessionDraft('workspace', sessionId, { kind: 'text', text: 'context' });
  appendUnmountedSessionDraft('workspace', sessionId, {
    kind: 'attachment',
    snapshot: { title: 'issue', markdown: 'issue details' },
  });
  hydrateSessionDraft('workspace', sessionId);
  expect(sessionDraftsCache.get(sessionId)).toBe('Unsent: context');
  const files = getSessionFileDrafts(sessionId);
  expect(files[0]?.file.name).toBe('issue.md');
  expect(await files[0]?.file.text()).toBe('issue details');
});

it('hands navigation identity to the next admitted registry but fences failed replacement, revoked trust and disable', async () => {
  const { ClientPluginHost } = await import('../src/plugins/client-host');
  const { shellIdentity } = await import('../src/plugins/shell-generation');
  const host = new ClientPluginHost();
  const key = { workspaceId: 'w', sourceKey: 'local' as const, pluginId: manifest.id };
  let latest!: AbortSignal;
  async function replace(revision: number, admissionKey: string, fail = false) {
    const file = async () => Uint8Array.of(revision);
    const bytes = (await packClientBundle(manifest, file))!;
    const digest = (await computeClientDigest(manifest, file))!;
    await host.reconcile(key, {
      ...key,
      digest,
      admissionKey,
      page: async () => ({ bytes, totalBytes: bytes.length }),
      registry: (_files, signal) => {
        latest = shellIdentity(signal, 'view:tree');
        if (fail) throw Error('registration failed');
        return {} as never;
      },
    });
    return latest;
  }
  const old = await replace(1, 'lease A');
  expect(await replace(2, 'lease A')).toBe(old);
  const renewed = await replace(2, 'lease B');
  expect(old.aborted).toBe(true);
  expect(renewed).not.toBe(old);
  await expect(replace(3, 'lease B', true)).rejects.toThrow('registration failed');
  expect(renewed.aborted).toBe(true);
  const recovered = await replace(4, 'lease B');
  const disabling = host.reconcile(key, null);
  expect(recovered.aborted).toBe(true);
  await disabling;
  expect(await replace(4, 'lease B')).not.toBe(recovered);
  await host.reconcile(key, null);
});

it('resolves a bounded raw Loro transcript from the authorized workspace and releases it', async () => {
  const { workspaceSnapshotSource } = await import('../src/plugins/workspace-snapshot-source');
  const { snapshotBindings } = await import('../src/plugins/raw-snapshots');
  const { createLoroSessionData } = await import('@lody/shared/session-data');
  const { buildFixtureHistory, buildSessionDoc, FIXTURE_SESSION_ID } =
    await import('./conversation-view-fixtures');
  const data = createLoroSessionData({
    sessionId: FIXTURE_SESSION_ID,
    doc: buildSessionDoc(buildFixtureHistory(8)),
  });
  let leased = 0;
  const runtime = {
    workspaceId: 'w',
    async acquireSessionStore() {
      leased++;
      return { sessionData: data, history: { subscribe: () => () => {} } };
    },
    releaseSessionStoreRef() {
      leased--;
    },
  };
  const session = {
    id: FIXTURE_SESSION_ID,
    machineId: 'm',
    createdByPluginId: 'mine',
    businessKey: 'owned',
  };
  const src = workspaceSnapshotSource(
    runtime as never,
    'actor',
    [session as never],
    [],
    new Map(),
    [],
    []
  );
  const port = snapshotBindings(
    'w',
    'mine',
    new AbortController().signal,
    () => src,
    () => () => {}
  );
  const ref = {
    workspaceId: 'w',
    machineId: 'm',
    sessionId: FIXTURE_SESSION_ID,
  } as import('@lody/plugin-sdk').SessionRef;
  try {
    const snapshot = await port.unstable.readSnapshot({
      kind: 'session-transcript',
      session: ref,
      turnIds: ['a-2'],
    });
    expect(snapshot.doc.turns).toMatchObject([{ id: 'a-2', userTurnId: 'u-2' }]);
    expect(Object.isFrozen(snapshot.doc.turns)).toBe(true);
    expect(
      (await port.unstable.readSnapshot({ kind: 'session-meta', session: ref })).doc.businessKey
    ).toBe('owned');
    await expect(
      port.unstable.readSnapshot({
        kind: 'session-transcript',
        session: { ...ref, machineId: 'foreign' },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(leased).toBe(0);
  } finally {
    data.dispose();
  }
});

it('keeps the Session reader leased until a plugin subagent lookup finishes', async () => {
  const { readPluginHistory } = await import('../src/plugins/workspace-history');
  const started = Promise.withResolvers<void>();
  const count = Promise.withResolvers<number>();
  let leased = false;
  const runtime = {
    async acquireSessionStore() {
      leased = true;
      return {
        sessionData: {
          history: {
            count() {
              started.resolve();
              return count.promise;
            },
            async readDirectory() {
              if (!leased) throw Error('Reader closed');
              return [];
            },
          },
        },
      };
    },
    releaseSessionStoreRef() {
      leased = false;
    },
  };
  const lookup = readPluginHistory(
    runtime as never,
    { session: { sessionId: 'parent' } } as never,
    'subagentRun',
    { runId: 'absent' },
    new AbortController().signal
  );
  await started.promise;
  count.resolve(1);
  await expect(lookup).resolves.toBeNull();
  expect(leased).toBe(false);
});
it('serializes competing preference CAS across plugin instances and fences a retired installation',async()=>{
 await import('fake-indexeddb/auto');const {clientStorage}=await import('../src/plugins/client-storage');const life=new AbortController();const a=clientStorage('workspace-a','plugin',life.signal),b=clientStorage('workspace-a','plugin',life.signal);expect((await Promise.all([a.update('key',undefined,1),b.update('key',undefined,2)])).sort()).toEqual([false,true]);expect(await a.get('key')).toBe(await b.get('key'));expect(await clientStorage('workspace-b','plugin',life.signal).get('key')).toBeUndefined();life.abort();await expect(a.delete('key')).rejects.toThrow();});
