import {
  permissionModeFor,
  withPermissionMode,
} from '../../../../packages/cloud-runtime/src/protocol/capability.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { LoroDoc } from 'loro-crdt/base64';

test('create a project session, open its empty history and dispatch the first turn; reject invalid targets and never replay an uncertain create', async () => {
  const meta = new Flock('meta'),
    machine = new Flock('machine');
  meta.set(['e', 'machine-m1'], true);
  meta.set(['m', 'machine-m1'], { name: 'Test Mac' });
  machine.set(['localProject', 'p1'], {
    name: 'Project',
    rootPath: '/project',
  });
  machine.set(['agentConfig', 'c1'], {
    id: 'c1',
    name: 'Codex',
    machineId: 'm1',
    cliType: 'builtin',
    agentType: 'codex',
    env: { SECRET: 'never-project' },
  });
  machine.set(['agentConfig', 'wrong-machine'], {
    id: 'wrong-machine',
    name: 'Invalid',
    machineId: 'm2',
    cliType: 'builtin',
    agentType: 'codex',
  });
  machine.set(['acpCapability', 'codex'], {
    cliType: 'builtin',
    agentType: 'codex',
    fetchedAt: 1,
    models: [{ modelId: 'gpt-test', name: 'GPT Test' }],
    modelReasoningEfforts: { 'gpt-test': ['low', 'high'] },
    configOptions: [
      {
        id: 'effort',
        name: 'Effort',
        type: 'select',
        category: 'thought_level',
        options: [{ value: 'high', name: 'High' }],
      },
    ],
    acknowledgedSteer: true,
    provenance: 'runtime',
  });
  machine.set(['acpCapability', 'grok'], {
    cliType: 'builtin',
    agentType: 'grok',
    fetchedAt: 1,
    models: [],
    modes: [],
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'grok',
        options: [{ value: 'grok', name: 'Grok' }],
      },
      {
        id: 'interaction_mode',
        name: 'Interaction',
        category: 'mode',
        type: 'select',
        currentValue: 'agent',
        options: [{ value: 'agent', name: 'Agent' }],
      },
      {
        id: 'permission_mode',
        name: 'Permission',
        category: '_permission',
        type: 'select',
        currentValue: 'ask',
        options: [
          { value: 'ask', name: 'Ask' },
          { value: 'always-approve', name: 'Always Approve' },
        ],
      },
      {
        id: 'secret_token',
        name: 'Private',
        type: 'select',
        currentValue: 'never-project',
        options: [{ value: 'never-project', name: 'Never project' }],
      },
      {
        id: 'invalid',
        name: 'Invalid',
        type: 'select',
        options: [{ value: 3, name: 'Bad' }],
      },
    ],
    acknowledgedSteer: true,
  });
  const machines = new Map([['m1', machine]]);
  const remote = new Flock('remote');
  remote.importFile(meta.exportFile());
  const history = new LoroDoc();
  const order = [];
  let rpc,
    loseAck = false,
    failCreate = false,
    metaAppends = 0;
  const ok = (result = {}) => ({ ok: true, result });
  const unframe = (body) => {
    assert.equal(
      new DataView(body.buffer, body.byteOffset).getUint32(0, false),
      body.length - 4,
    );
    return body.subarray(4);
  };
  globalThis.__creationClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async create() {
      order.push('stream');
      return failCreate ? { ok: false, result: { code: 'forbidden' } } : ok();
    }
    async append({ part }) {
      if (this.url.includes(':rpc:req:')) {
        rpc = JSON.parse(part.body);
        const persisted = remote.get(['m', `session-${rpc.params.sessionId}`]);
        assert.equal(persisted.agentConfigId, 'c1');
        assert.equal(history.toJSON().history[0].id, rpc.params.userTurnId);
      } else history.import(unframe(part.body));
      return ok();
    }
    async bootstrap() {
      return ok({
        snapshotOffset: '-1',
        nextOffset: '-1',
        upToDate: true,
        updates: [],
      });
    }
    readOnce() {
      if (this.url.includes(':rpc:res:'))
        return Promise.resolve(
          ok({
            nextOffset: '1',
            payload: {
              body: new TextEncoder().encode(
                JSON.stringify([{ id: rpc.id, result: { accepted: true } }]),
              ),
            },
          }),
        );
      return new Promise(() => {});
    }
  };
  const bundle = await build({
    stdin: {
      contents: `export * from './packages/cloud-runtime/src/runtime/create-session'; export { openSession, sendTurn, closeSession } from './packages/cloud-runtime/src/runtime/session';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'streams',
        setup(b) {
          b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'mock',
            namespace: 'test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents:
              'export const StreamsClient = globalThis.__creationClient',
          }));
        },
      },
    ],
  });
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const options = runtime.creationOptions('m1:local:p1', meta, machines);
  assert.equal(options.agents.length, 1);
  assert.equal(options.capabilities[0].reasoningEffortConfigId, 'effort');
  const grok = options.capabilities.find((item) => item.agentType === 'grok');
  assert.equal(
    grok.models[0].id,
    'grok',
    'config-only models reach the picker',
  );
  assert.equal(
    grok.modes[0].id,
    'agent',
    'config-only interaction mode uses the current wire value',
  );
  assert.equal(
    grok.configOptions.find((item) => item.id === 'permission_mode').options[1]
      .id,
    'always-approve',
  );
  const interactionOnly = {
    ...grok,
    configOptions: grok.configOptions.filter(
      (item) => item.id !== 'permission_mode',
    ),
  };
  assert.equal(
    permissionModeFor(interactionOnly, {}),
    undefined,
    'projected interaction modes are not permission modes',
  );
  const generic = {
    ...interactionOnly,
    configOptions: interactionOnly.configOptions.map((item) =>
      item.id === 'interaction_mode' ? { ...item, id: 'approval' } : item,
    ),
  };
  assert.equal(
    withPermissionMode(generic, {}, 'agent').configOptionValues.approval,
    'agent',
    'config-only mode sends its config ID, not legacy modeId',
  );
  assert.equal(
    grok.configOptions.some((item) => item.id === 'invalid'),
    false,
  );
  assert.deepEqual(
    options.capabilities.map((item) => [item.agentType, item.steer]),
    [
      ['codex', true],
      ['grok', false],
    ],
    'Only runtime-proven acknowledged steer enables Steer',
  );
  assert.equal(JSON.stringify(options).includes('never-project'), false);
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        metaAppends++;
        order.push('metadata');
        remote.importJson(
          JSON.parse(new TextDecoder().decode(unframe(part.body))),
        );
        return loseAck ? { ok: false, result: { code: 'timeout' } } : ok();
      },
    },
  };
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://example.invalid',
  });
  const args = {
    workspaceId: 'w1',
    projectId: options.project.id,
    sessionId: options.sessionId,
    machineId: 'm1',
    agentConfigId: 'c1',
    userId: 'u1',
    title: ' First task ',
  };
  await assert.rejects(
    runtime.createSession(
      { ...args, machineId: 'm2' },
      options,
      replica,
      grant,
    ),
    /invalid_session/,
  );
  assert.equal(order.length, 0);
  const fullMeta = new Flock('full-meta');
  fullMeta.importFile(meta.exportFile());
  for (let index = 0; index < 200; index++)
    fullMeta.set(['e', `session-existing-${index}`], true);
  const atLimit = await runtime.createSession(
    {
      ...args,
      billingEntitlement: { effectivePlanTier: 'free', checkoutPending: false },
    },
    options,
    { ...replica, flock: fullMeta },
    grant,
  );
  assert.deepEqual(atLimit, {
    state: 'rejected',
    reason: 'free_session_limit_reached',
  });
  assert.equal(order.length, 0, 'quota rejection cannot create a stream');
  const result = await runtime.createSession(args, options, replica, grant);
  assert.equal(result.state, 'created');
  assert.deepEqual(order, ['stream', 'metadata']);
  const saved = remote.get(['m', `session-${result.session.id}`]);
  assert.equal(saved.title, 'First task');
  assert.equal(saved.titleSource, 'draft');
  assert.equal(saved.project.localProjectId, 'p1');
  assert.equal(remote.get(['e', `session-${result.session.id}`]), true);
  assert.equal(saved.latestUserMsgId, undefined);
  let live;
  const ready = new Promise((resolve) => {
    live = resolve;
  });
  await runtime.openSession(
    result.session.id,
    'w1',
    grant,
    (event) => {
      const value = JSON.parse(event.session);
      if (value.status === 'live') live(value);
    },
    async (id, turnId) => {
      assert.equal(history.toJSON().history[0].id, turnId);
      remote.set(['m', `session-${id}`, 'latestUserMsgId'], turnId);
    },
  );
  assert.equal((await ready).entries.length, 0);
  const sent = await runtime.sendTurn({
    sessionId: result.session.id,
    machineId: 'm1',
    userId: 'u1',
    text: 'Hello',
    cliType: result.session.cliType,
    agentType: result.session.agentType,
  });
  assert.equal(sent.state, 'accepted');
  assert.equal(history.toJSON().history[0].items[0].text, 'Hello');
  runtime.closeSession();
  await assert.rejects(
    runtime.createSession(args, options, replica, grant),
    /session_already_exists/,
  );
  assert.equal(metaAppends, 1);
  failCreate = true;
  const failedId = crypto.randomUUID();
  await assert.rejects(
    runtime.createSession(
      { ...args, sessionId: failedId },
      options,
      replica,
      grant,
    ),
    /forbidden/,
  );
  assert.equal(meta.get(['e', `session-${failedId}`]), undefined);
  assert.equal(metaAppends, 1);
  failCreate = false;
  loseAck = true;
  const unknownId = crypto.randomUUID();
  const uncertain = await runtime.createSession(
    { ...args, sessionId: unknownId },
    options,
    replica,
    grant,
  );
  assert.equal(uncertain.state, 'unknown');
  assert.equal(uncertain.session.id, unknownId);
  assert.equal(
    meta.get(['e', `session-${unknownId}`]),
    undefined,
    'An uncertain write must not publish a phantom local session',
  );
  assert.equal(remote.get(['e', `session-${unknownId}`]), true);
  assert.equal(metaAppends, 2);
  await assert.rejects(
    runtime.createSession(
      { ...args, sessionId: unknownId },
      options,
      replica,
      grant,
    ),
    /session_already_exists/,
  );
  assert.equal(metaAppends, 2);
  machine.set(['cmd', 'deleteLocalProject', 'p1'], { requestedAt: 1 });
  assert.throws(
    () => runtime.creationOptions('m1:local:p1', meta, machines),
    /project_unavailable/,
  );
  meta.set(['e', 'session-github'], true);
  meta.set(['m', 'session-github'], {
    machineId: 'm1',
    project: { kind: 'github', repoFullName: 'example/repo', branch: 'main' },
  });
  const github = runtime.creationOptions('github:example/repo', meta, machines);
  const githubArgs = {
    ...args,
    projectId: github.project.id,
    sessionId: github.sessionId,
  };
  await assert.rejects(
    runtime.createSession(githubArgs, github, replica, grant),
    /invalid_session/,
  );
  loseAck = false;
  const githubResult = await runtime.createSession(
    { ...githubArgs, branch: 'develop' },
    github,
    replica,
    grant,
  );
  assert.equal(githubResult.state, 'created');
  const githubMeta = remote.get(['m', `session-${github.sessionId}`]);
  assert.equal(githubMeta.project.branch, 'develop');
  assert.equal(githubMeta.isWorktree, true);
  const tabOptions = runtime.creationOptions(undefined, meta, machines);
  const tabResult = await runtime.createSession(
    {
      ...args,
      projectId: undefined,
      sessionId: tabOptions.sessionId,
      tabContext: {
        parentSessionId: github.sessionId,
        projectId: github.project.id,
        project: githubMeta.project,
        repoFullName: githubMeta.repoFullName,
        baseBranch: githubMeta.baseBranch,
      },
    },
    tabOptions,
    replica,
    grant,
  );
  assert.equal(tabResult.state, 'created');
  const tabMeta = remote.get(['m', `session-${tabOptions.sessionId}`]);
  assert.equal(tabMeta.parentSessionId, github.sessionId);
  assert.deepEqual(tabMeta.project, githubMeta.project);
  assert.equal(tabMeta.isWorktree, undefined);
  assert.equal(tabMeta.resume, undefined);
  assert.equal(tabResult.session.projectId, github.project.id);

  delete globalThis.__creationClient;
});

test('chat and fresh GitHub repositories can use workspace machines while local projects stay pinned', async () => {
  const meta = new Flock('meta'),
    machine = new Flock('machine');
  meta.set(['e', 'machine-m1'], true);
  meta.set(['m', 'machine-m1'], { name: 'Test Mac' });
  machine.set(['agentConfig', 'c1'], {
    id: 'c1',
    name: 'Codex',
    machineId: 'm1',
    cliType: 'builtin',
    agentType: 'codex',
  });
  machine.set(['acpCapability', 'codex'], {
    cliType: 'builtin',
    agentType: 'codex',
    fetchedAt: 1,
    models: [{ modelId: 'gpt-test', name: 'GPT Test' }],
  });
  const machines = new Map([['m1', machine]]);
  const remote = new Flock('remote');
  const ok = (result = {}) => ({ ok: true, result });
  const unframe = (body) => body.subarray(4);
  globalThis.__creationClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async create() {
      return ok();
    }
    async append({ part }) {
      remote.importJson(
        JSON.parse(new TextDecoder().decode(unframe(part.body))),
      );
      return ok();
    }
    async bootstrap() {
      return ok({
        snapshotOffset: '-1',
        nextOffset: '-1',
        upToDate: true,
        updates: [],
      });
    }
    readOnce() {
      return new Promise(() => {});
    }
  };
  const bundle = await build({
    stdin: {
      contents: `export * from './packages/cloud-runtime/src/runtime/create-session';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'streams',
        setup(b) {
          b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'mock',
            namespace: 'test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents:
              'export const StreamsClient = globalThis.__creationClient',
          }));
        },
      },
    ],
  });
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  assert.throws(
    () => runtime.creationOptions('m1:local:missing', meta, machines),
    /project_unavailable/,
  );
  const options = runtime.creationOptions(undefined, meta, machines);
  assert.equal(options.project, undefined);
  assert.equal(options.agents.length, 1);
  const replica = {
    flock: meta,
    client: {
      async append({ part }) {
        remote.importJson(
          JSON.parse(new TextDecoder().decode(unframe(part.body))),
        );
        return ok();
      },
    },
  };
  const result = await runtime.createSession(
    {
      workspaceId: 'w1',
      sessionId: options.sessionId,
      machineId: 'm1',
      agentConfigId: 'c1',
      userId: 'u1',
      title: '纯对话',
    },
    options,
    replica,
    async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://example.invalid',
    }),
  );
  assert.equal(result.state, 'created');
  assert.equal(result.session.projectId, 'm1:unassigned');
  const saved = remote.get(['m', `session-${result.session.id}`]);
  assert.equal(saved.titleSource, 'draft');
  assert.equal(saved.project, undefined);
  assert.equal(saved.repoFullName, undefined);
  assert.equal(saved.isWorktree, undefined);
  const teammate = new Flock('teammate');
  meta.set(['e', 'machine-m2'], true);
  meta.set(['m', 'machine-m2'], { name: 'Teammate Mac', userId: 'other-user' });
  teammate.set(['agentConfig', 'c2'], {
    id: 'c2',
    name: 'Teammate Agent',
    machineId: 'm2',
    cliType: 'builtin',
    agentType: 'codex',
  });
  machines.set('m2', teammate);
  machine.set(['localProject', 'p1'], { name: 'Local', rootPath: '/local' });
  assert.deepEqual(
    runtime
      .creationOptions('m1:local:p1', meta, machines)
      .agents.map((agent) => agent.machineId),
    ['m1'],
  );
  const github = runtime.creationOptions(
    'github:LodyAI/FreshProject',
    meta,
    machines,
  );
  assert.equal(github.project.name, 'LodyAI/FreshProject');
  assert.deepEqual(
    github.agents.map((agent) => agent.machineId),
    ['m1', 'm2'],
  );
  for (const repo of [
    'owner/..',
    'owner/repo/extra',
    'owner/repo?token=x',
    'owner/repo\n',
  ]) {
    assert.throws(
      () => runtime.creationOptions(`github:${repo}`, meta, machines),
      /project_unavailable/,
    );
  }
  const githubArgs = {
    workspaceId: 'w1',
    sessionId: github.sessionId,
    projectId: github.project.id,
    machineId: 'm2',
    agentConfigId: 'c2',
    userId: 'u1',
    title: 'First repository task',
    branch: 'main',
  };
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://example.invalid',
  });
  await assert.rejects(
    runtime.createSession(
      { ...githubArgs, branch: '' },
      github,
      replica,
      grant,
    ),
    /invalid_session/,
  );
  await assert.rejects(
    runtime.createSession(
      { ...githubArgs, machineId: 'unavailable' },
      github,
      replica,
      grant,
    ),
    /invalid_session/,
  );
  const created = await runtime.createSession(
    githubArgs,
    github,
    replica,
    grant,
  );
  assert.equal(created.state, 'created');
  const githubSaved = remote.get(['m', `session-${created.session.id}`]);
  assert.equal(githubSaved.titleSource, 'draft');
  assert.equal(githubSaved.machineId, 'm2');
  assert.equal(githubSaved.agentConfigId, 'c2');
  assert.deepEqual(githubSaved.project, {
    kind: 'github',
    repoFullName: 'LodyAI/FreshProject',
    branch: 'main',
  });
  assert.equal(githubSaved.baseBranch, 'main');
  assert.equal(githubSaved.isWorktree, true);
  delete globalThis.__creationClient;
});

test('legacy capability keys preserve all builtin agent types', async () => {
  const { readFile } = await import('node:fs/promises'),
    { transform } = await import('esbuild'),
    vm = await import('node:vm');
  const source = await readFile(
    new URL(
      '../../../../packages/cloud-runtime/src/runtime/create-session.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const code = (
    await transform(
      source
        .slice(
          source.indexOf('export function creationOptions('),
          source.indexOf('const attempted ='),
        )
        .replace('export function', 'function'),
      { loader: 'ts' },
    )
  ).code;
  const context = {
    crypto,
    projectRows: () => ({ projects: [] }),
    isThoughtLevel: () => false,
    validConfigValue: () => false,
  };
  vm.runInNewContext(code + ';globalThis.options=creationOptions', context);
  const rows = ['grok', 'codex'].map((id) => ({
    key: ['acpCapability', 'builtin', id],
    value: {
      cliType: 'builtin',
      agentType: id,
      models: [{ modelId: id, name: id }],
      fetchedAt: 1,
    },
  }));
  const result = context.options(
    undefined,
    { scan: () => [] },
    new Map([['m', { scan: () => rows }]]),
  );
  assert.equal(result.capabilities.length, 2);
  assert.equal(result.capabilities[0].agentConfigId, undefined);
  assert.equal(result.capabilities[0].agentType, 'grok');
  assert.equal(result.capabilities[1].models[0].id, 'codex');
});
