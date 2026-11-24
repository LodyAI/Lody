import { Effect, Layer, ManagedRuntime } from 'effect';
import { Registry, type PluginRuntime } from '../plugin-runtime';
import { expect, it } from 'vitest';
import { bindPluginToolMcp } from './plugin-tool-mcp';

it('only lists registered tools to the launched MCP client while its captured turn is active', async () => {
  let active = true;
  const registry = {
    sessionTools: () => [
      {
        name: 'plugin__test__echo',
        description: 'Echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
    invokeSessionTool: () => Effect.die('unexpected call'),
  } satisfies Pick<typeof Registry.Service, 'sessionTools' | 'invokeSessionTool'>;
  const runtime = ManagedRuntime.make(Layer.succeed(Registry, registry as typeof Registry.Service));
  const binding = await bindPluginToolMcp(
    runtime as unknown as PluginRuntime,
    {
      sessionId: 'session',
      userId: 'user',
      isCurrent: () => active,
      executeHostCall: async () => {
        throw Error('unexpected command');
      },
    },
    async () => {
      throw Error('unexpected custody');
    }
  );
  const list = async (authorization: string) =>
    fetch(binding.entry.url, {
      method: 'POST',
      headers: {
        authorization,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
  try {
    expect((await list('Bearer session')).status).toBe(403);
    const token = binding.entry.headers[0]!.value;
    const response = await list(token);
    expect(response.status).toBe(200);
    expect((await response.json()).result.tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'plugin__test__echo' })])
    );
    active = false;
    expect((await list(token)).status).toBe(403);
  } finally {
    await binding.release();
    await runtime.dispose();
  }
});

it('dispatches a shared turn through MCP and the machine worker without lending its captured authority to a later turn', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises'),
    { join } = await import('node:path'),
    { tmpdir } = await import('node:os'),
    { fileURLToPath } = await import('node:url'),
    { build } = await import('esbuild');
  const { makePluginRuntime } = await import('../plugin-runtime'),
    { encryptedPluginDispatch } = await import('../machine-host-port'),
    { composeMachineHostDispatch } = await import('./daemon-command-executor');
  const { MessageHandler } = await import('../../lib/message-handler');
  const root = await mkdtemp(join(tmpdir(), 'lody-tool-dispatch-')),
    worker = join(root, 'worker.mjs'),
    directory = join(root, 'generations', crypto.randomUUID()),
    entry = join(directory, 'tool.mjs');
  const workspaceId = 'workspace',
    machineId = 'machine',
    sessionId = 'session',
    projectId = 'project',
    userId = 'e2ee-member:fixture';
  const daemon = makePluginRuntime(
    root,
    workspaceId,
    machineId,
    () => {},
    undefined,
    encryptedPluginDispatch(composeMachineHostDispatch()),
    worker
  );
  let sourceTurnId = 'first',
    revoked = false,
    endDuringSign = false,
    spent = 0;
  const queued: { derivedFrom: unknown; userId: string }[] = [];
  const doc = {
    getMetaState: async () => ({
      machineId,
      project: { kind: 'local', localProjectId: projectId },
      cliType: 'builtin',
      agentType: 'codex',
    }),
    pushMessageQueue: async (row: (typeof queued)[number]) => {
      queued.push(row);
    },
    handle: { doc: { frontiers: () => [] } },
  };
  const handler = Object.assign(Object.create(MessageHandler.prototype), {
    workspaceId,
    machineId,
    resolveSessionExecutionScope: async () => [projectId],
    encryptedExecution: {
      authorizePluginToolRoot: (r: { userTurnId: string }) =>
        Effect.succeed(
          r.userTurnId === sourceTurnId
            ? { device: 'device', userId, isCurrent: () => !revoked }
            : undefined
        ),
    },
    executionService: {
      getEncryptedControlPrincipal: () => ({
        kind: 'member',
        requesterDevice: 'device',
        localProjectIds: [projectId],
      }),
      reserveEncryptedDerivation: () => ++spent <= 20,
    },
    workspaceDocument: {
      getOrCreateSessionDoc: async () => doc,
      repo: {
        getDocMeta: async () => ({ meta: await doc.getMetaState() }),
        upsertDocMeta: async () => {},
      },
      signMachineInput: async () => {
        if (endDuringSign) sourceTurnId = 'second';
        return 'fixture-signature';
      },
    },
  });
  const bindings: Awaited<ReturnType<typeof bindPluginToolMcp>>[] = [];
  const mount = async (id: string) => {
    const turn = {
      turnId: `assistant-${id}`,
      sourceTurnId: id,
      userId,
      sessionId,
      projectId,
      isCurrent: () => sourceTurnId === id,
    };
    const binding = await bindPluginToolMcp(
      daemon,
      {
        ...turn,
        executeHostCall: (call, signal) =>
          handler.executeLivePluginTool(sessionId, turn, call, signal),
      },
      async (toolCallId, signal) => ({
        documents: { pluginResultRepository: root },
        sessionId,
        turnId: id,
        toolCallId,
        signal,
        authorize: async () => {},
        history: {
          getMetaState: async () => ({ id: sessionId }),
          readTurn: async () => ({ state: 'ready', turn: { role: 'assistant' } }),
          applyAgentBatch: async () => {},
          flushLocalWrites: async () => {},
        } as unknown as import('../../session/session-backend').SessionBackend,
      })
    );
    bindings.push(binding);
    return async () => {
      const r = await fetch(binding.entry.url, {
        method: 'POST',
        headers: {
          authorization: binding.entry.headers[0]!.value,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'plugin__fixture__send', arguments: {} },
        }),
      });
      return r.status === 403 ? 'inactive' : (await r.json()).result.isError ? 'denied' : 'ok';
    };
  };
  try {
    await mkdir(directory, { recursive: true });
    await Promise.all([
      build({
        entryPoints: [fileURLToPath(new URL('../plugin-worker-entry.ts', import.meta.url))],
        outfile: worker,
        bundle: true,
        platform: 'node',
        format: 'esm',
      }),
      build({
        stdin: {
          contents:
            "import {z} from 'zod';export default {kind:'machine-plugin',register(m){m.tool({id:'send',input:z.object({}),output:z.unknown()},ctx=>ctx.lody.sessions.send(ctx.session,{prompt:'hello'}))}}",
          resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        },
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'esm',
      }),
    ]);
    await writeFile(
      join(root, 'catalog.json'),
      JSON.stringify([
        {
          source: directory,
          enabled: true,
          dev: false,
          current: {
            provenance: { kind: 'local', origin: 'dir' },
            directory,
            machineEntry: entry,
            machineDigest: 'aa'.repeat(32),
            manifest: {
              id: 'fixture',
              title: 'Fixture',
              version: '1.0.0',
              sdk: '^1.0.0',
              machine: 'tool.mjs',
              permissions: ['sessions.write'],
            },
          },
        },
      ])
    );
    await daemon.runPromise(Effect.flatMap(Registry, (r) => r.start));
    const first = await mount('first');
    expect(await first()).toBe('ok');
    expect(queued[0]).toMatchObject({ derivedFrom: { sessionId, userTurnId: 'first' }, userId });
    revoked = true;
    expect(await first()).toBe('denied');
    revoked = false;
    endDuringSign = true;
    expect(await first()).toBe('denied');
    expect(await first()).toBe('inactive');
    expect(queued).toHaveLength(1);
    endDuringSign = false;
    const second = await mount('second');
    spent = 19;
    expect(await second()).toBe('ok');
    expect(await second()).toBe('denied');
    expect(queued).toHaveLength(2);
    expect(queued[1]?.derivedFrom).toEqual({ sessionId, userTurnId: 'second' });
  } finally {
    for (const b of bindings) await b.release();
    await daemon.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
