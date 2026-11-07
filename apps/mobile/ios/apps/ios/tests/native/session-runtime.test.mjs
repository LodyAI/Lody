import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { LoroDoc, LoroMap, LoroList, LoroText } from 'loro-crdt/base64';
import { openTestSession, loadRuntime, frame } from '../helpers.mjs';

test('continuing a Role session preserves its frozen identity through dispatch and queue', async () => {
  const calls = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      calls.push(request);
      return { result: { accepted: true } };
    },
  });
  const previous = {
    cliType: 'builtin',
    agentType: 'codex',
    modelId: 'frozen-model',
    modeId: 'plan',
    configOptionValues: { effort: 'high', fast: false },
    agentRoleId: 'role-coder',
    agentRoleRevision: 7,
    mcpServerIds: ['workspace-files'],
  };
  try {
    fixture.server.getList('history').push({
      id: 'previous',
      role: 'user',
      status: 'handled',
      finished: true,
      inputConfig: previous,
      items: [],
    });
    fixture.server.commit();
    await fixture.pushUpdate();
    const args = {
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      cliType: 'builtin',
      agentType: 'codex',
      text: 'Continue the review',
    };
    assert.equal((await fixture.runtime.sendTurn(args)).state, 'accepted');
    const input = calls[0].params.inputConfig;
    for (const key of Object.keys(previous))
      assert.deepEqual(input[key], previous[key]);
    assert.deepEqual(fixture.server.toJSON().history.at(-1).inputConfig, input);
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, queue: true })).state,
      'queued',
    );
    const queued = fixture.server.toJSON().mq[0].acpSessionConfig;
    for (const key of Object.keys(previous))
      assert.deepEqual(queued[key], previous[key]);
    for (const override of [
      { modelId: 'different-model' },
      { modelId: null },
      { modeId: 'code' },
      { reasoningEffort: 'low' },
      { configOptionValues: { fast: true } },
    ]) {
      assert.equal(
        (await fixture.runtime.sendTurn({ ...args, ...override, queue: true }))
          .state,
        'queued',
      );
      const changed = fixture.server.toJSON().mq.at(-1).acpSessionConfig;
      assert.equal(
        changed.agentRoleId,
        null,
        'Overrides explicitly detach the frozen Role',
      );
      assert.equal(changed.agentRoleRevision, undefined);
    }
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          ...args,
          queue: true,
          modelId: previous.modelId,
          configOptionValues: { fast: false, effort: 'high' },
        })
      ).state,
      'queued',
    );
    assert.equal(
      fixture.server.toJSON().mq.at(-1).acpSessionConfig.agentRoleId,
      previous.agentRoleId,
      'Restored composer values do not detach an unchanged Role',
    );
  } finally {
    fixture.close();
  }
});

test('independent configuration reaches durable history before RPC, inherits on later turns and rejects malformed overrides', async () => {
  const calls = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      calls.push(request);
      const persisted = fixture.server
        .toJSON()
        .history.find((entry) => entry.id === request.params.userTurnId);
      assert.deepEqual(
        persisted.inputConfig.configOptionValues,
        request.params.inputConfig.configOptionValues,
      );
      return { result: { accepted: true } };
    },
  });
  const args = {
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    cliType: 'builtin',
    agentType: 'grok',
    text: 'Synthetic configuration check',
  };
  try {
    for (const configOptionValues of [
      null,
      [],
      { fast: 1 },
      { permission_mode: {} },
      { secret_token: 'synthetic' },
    ]) {
      assert.equal(
        (await fixture.runtime.sendTurn({ ...args, configOptionValues })).state,
        'not_sent',
      );
    }
    assert.equal(
      fixture.appends.length,
      0,
      'invalid configuration cannot write or dispatch',
    );
    const configOptionValues = {
      permission_mode: 'always-approve',
      fast: false,
      collaboration_mode: 'plan',
      agent_preset: 'coder',
    };
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          ...args,
          configOptionValues,
          reasoningEffort: 'high',
          reasoningEffortConfigId: 'effort',
        })
      ).state,
      'accepted',
    );
    assert.deepEqual(calls[0].params.inputConfig.configOptionValues, {
      ...configOptionValues,
      effort: 'high',
    });
    assert.deepEqual(
      fixture.runtime.projectSession(fixture.server, 'live').composer
        .configOptionValues,
      configOptionValues,
      'Reopened composer restores permission and other agent choices, including explicit Fast off',
    );
    assert.equal((await fixture.runtime.sendTurn(args)).state, 'queued');
    assert.deepEqual(
      fixture.server.toJSON().mq[0].acpSessionConfig.configOptionValues,
      calls[0].params.inputConfig.configOptionValues,
    );
    assert.equal(
      (
        await fixture.runtime.sendTurn({
          ...args,
          configOptionValues: { permission_mode: 'ask' },
        })
      ).state,
      'queued',
    );
    assert.equal(
      fixture.server.toJSON().mq[1].acpSessionConfig.configOptionValues
        .permission_mode,
      'ask',
    );
    assert.equal(
      fixture.server.toJSON().mq[1].acpSessionConfig.configOptionValues.fast,
      false,
    );
  } finally {
    fixture.close();
  }
});

test('reply metadata preserves each recorded model and updates when it arrives after completion', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const history = doc.getList('history');
  history.push({
    id: 'old',
    role: 'assistant',
    finished: true,
    modelInfo: { modelId: 'old-model', name: 'Old Model' },
    items: [{ type: 'text', text: 'Earlier answer' }],
  });
  history.push({
    id: 'input',
    role: 'user',
    finished: true,
    inputConfig: { modelId: 'selected-model' },
    items: [],
  });
  const reply = history.pushContainer(new LoroMap());
  reply.set('id', 'reply');
  reply.set('role', 'assistant');
  reply.set('finished', true);
  reply.set('items', [{ type: 'text', text: 'Answer' }]);
  doc.commit();
  const before = projectSession(doc, 'live');
  assert.equal(before.entries[0].modelInfo.name, 'Old Model');
  assert.equal(
    before.entries[2].modelInfo,
    undefined,
    'Never infer history metadata from the current composer',
  );
  reply.set('modelInfo', {
    modelId: 'actual-model',
    name: ' Actual Model ',
    _meta: { lodyThoughtLevel: ' High ', unrelated: 'not for display' },
  });
  doc.commit();
  const after = projectSession(doc, 'live');
  assert.equal(after.entries[0].modelInfo.name, 'Old Model');
  assert.deepEqual(after.entries[2].modelInfo, {
    modelId: 'actual-model',
    name: 'Actual Model',
    thoughtLevel: 'High',
  });
  assert.ok(after.entries[2].rev > before.entries[2].rev);
  const usage = {
    inputTokens: 1234,
    outputTokens: 6640,
    reasoningOutputTokens: 2000,
    cacheReadInputTokens: 120000,
    cacheCreationInputTokens: 4096,
  };
  reply.set('tokenUsage', usage);
  reply.set('inputConfig', {
    modeId: 'plan',
    configOptionValues: {
      fast: false,
      effort: 'high',
      secret_token: 'hidden',
      invalid: {},
    },
  });
  doc.commit();
  const late = projectSession(doc, 'live').entries[2];
  assert.deepEqual(late.tokenUsage, usage);
  assert.deepEqual(late.inputConfig, {
    modeId: 'plan',
    configOptionValues: { fast: false, effort: 'high' },
  });
  assert.ok(
    late.rev > after.entries[2].rev,
    'Late usage invalidates the rendered entry',
  );
  assert.equal(projectSession(doc, 'live').entries[0].tokenUsage, undefined);
  for (const invalid of [
    { ...usage, inputTokens: -1 },
    { ...usage, outputTokens: '20' },
    { inputTokens: 20 },
  ]) {
    reply.set('tokenUsage', invalid);
    doc.commit();
    assert.equal(projectSession(doc, 'live').entries[2].tokenUsage, undefined);
  }
  reply.set('modelInfo', {
    modelId: 'id-only',
    name: 42,
    _meta: { lodyThoughtLevel: {} },
  });
  doc.commit();
  const sanitized = projectSession(doc, 'live').entries[2].modelInfo;
  assert.equal(sanitized.modelId, 'id-only');
  assert.equal(sanitized.name, undefined);
  assert.equal(sanitized.thoughtLevel, undefined);
});

test('system notice identity survives projection updates without changing the completed reply', async () => {
  const { projectSession } = await loadRuntime();
  const doc = new LoroDoc();
  doc.getList('history').push({
    id: 'done',
    role: 'assistant',
    finished: true,
    items: [{ type: 'text', text: 'done' }],
  });
  const notice = doc.getList('history').pushContainer(new LoroMap());
  notice.set('id', 'notice');
  notice.set('role', 'system');
  const item = notice
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  item.set('type', 'system_notice');
  item.set('name', 'agent_warning');
  doc.commit();
  const before = projectSession(doc, 'live');
  assert.equal(before.entries[0].finished, true);
  assert.equal(before.entries[1].items[0].name, 'agent_warning');
  item.set('name', 'chat_failed');
  doc.commit();
  const after = projectSession(doc, 'live');
  assert.equal(after.entries[1].items[0].name, 'chat_failed');
  assert.ok(after.entries[1].rev > before.entries[1].rev);
  assert.equal(after.entries[0].finished, true);
});

test('send persists user before dispatch; duplicate incremental imports preserve one ordered streaming reply', async () => {
  const server = new LoroDoc();
  let sessionRead,
    rpc,
    appends = 0,
    acknowledged = true,
    loseAppendAck = false;
  const frame = (bytes) => {
    const result = new Uint8Array(bytes.length + 4);
    new DataView(result.buffer).setUint32(0, bytes.length, false);
    result.set(bytes, 4);
    return result;
  };
  const ok = (result) => ({ ok: true, result });
  const live = (payload, offset = '2') =>
    ok({ nextOffset: offset, upToDate: true, closed: false, payload });
  globalThis.__sessionClient = class {
    constructor({ url }) {
      this.url = decodeURIComponent(url);
    }
    async bootstrap() {
      return ok({
        snapshotOffset: '1',
        nextOffset: '1',
        upToDate: true,
        snapshot: { body: server.export({ mode: 'snapshot' }) },
        updates: [],
      });
    }
    readOnce() {
      if (this.url.includes(':rpc:res:'))
        return Promise.resolve(
          live({
            body: new TextEncoder().encode(
              JSON.stringify([
                { id: rpc.id, result: { accepted: acknowledged } },
              ]),
            ),
          }),
        );
      return new Promise((resolve) => {
        sessionRead = resolve;
      });
    }
    async create() {
      return ok({});
    }
    async append({ part }) {
      if (this.url.includes(':rpc:req:')) {
        rpc = JSON.parse(part.body);
        assert.equal(server.toJSON().history[0].id, rpc.params.userTurnId);
      } else {
        appends++;
        assert.equal(
          new DataView(part.body.buffer, part.body.byteOffset).getUint32(
            0,
            false,
          ),
          part.body.length - 4,
        );
        server.import(part.body.subarray(4));
      }
      if (loseAppendAck && !this.url.includes(':rpc:req:'))
        return { ok: false, result: { code: 'timeout' } };
      return ok({ nextOffset: '2' });
    }
  };
  const bundle = await build({
    entryPoints: ['packages/cloud-runtime/src/runtime/session.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [
      {
        name: 'stream',
        setup(b) {
          b.onResolve({ filter: /^@loro-dev\/streams-client$/ }, () => ({
            path: 'mock',
            namespace: 'test',
          }));
          b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const StreamsClient=globalThis.__sessionClient',
          }));
        },
      },
    ],
  });
  const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
  );
  const events = [];
  const background = [];
  let resolveLive;
  const nextLive = () =>
    new Promise((resolve) => {
      resolveLive = resolve;
    });
  const initial = nextLive();
  await runtime.openSession(
    's1',
    'w1',
    async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://example.invalid',
    }),
    (e) => {
      if (e.backgroundWork) background.push(e.backgroundWork);
      if (!e.session) return;
      const value = JSON.parse(e.session);
      events.push(value);
      if (value.status === 'live') resolveLive?.(value);
    },
    async (sessionId, turnId) => {
      assert.equal(sessionId, 's1');
      assert.equal(server.toJSON().history[0].id, turnId);
    },
  );
  await initial;
  const attachments = [
    {
      type: 'image',
      imageId: 'img1',
      mimeType: 'image/png',
      sizeBytes: 12,
      fileName: '照片.png',
    },
    {
      type: 'file',
      fileId: 'file1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      sha256: 'abc',
      textPreview: true,
      transport: 'r2',
      uploadedAt: 1,
    },
  ];
  const invalid = await runtime.sendTurn({
    sessionId: 's1',
    text: '',
    attachmentBlocks: [{ type: 'image', uri: 'file:///private/test' }],
  });
  assert.equal(invalid.state, 'not_sent');
  assert.equal(appends, 0);
  const turn = {
    id: '2B066292-A94B-4383-B3C5-A0A7522F31CD',
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    text: 'POC hello',
    backgroundTaskId: 'background-test',
    attachmentBlocks: attachments,
    cliType: 'builtin',
    agentType: 'codex',
    modelId: 'gpt-test',
    reasoningEffort: 'high',
    reasoningEffortConfigId: 'effort',
  };
  assert.equal(
    (await runtime.sendTurn({ ...turn, id: 'not-a-uuid' })).state,
    'not_sent',
  );
  assert.equal(appends, 0);
  const sending = runtime.sendTurn(turn);
  assert.equal(
    (await runtime.sendTurn(turn)).reason,
    'turn_already_exists',
    'an in-flight duplicate must not be treated as safe to retry',
  );
  const result = await sending;
  assert.equal(result.state, 'accepted');
  assert.equal(result.id, turn.id);
  assert.equal(rpc.params.userTurnId, turn.id);
  const firstRPC = rpc;
  const repeatedTurn = await runtime.sendTurn(turn);
  assert.equal(repeatedTurn.state, 'unknown');
  assert.equal(repeatedTurn.reason, 'turn_already_exists');
  assert.equal(rpc, firstRPC, 'duplicate identity must not dispatch again');
  assert.equal(background.at(-1).state, 'sent'); // Machine ACK is not completion.
  assert.equal(background.at(-1).id, 'background-test');
  assert.equal(appends, 1);
  const user = server.toJSON().history[0];
  assert.equal(user.items[0].text, 'POC hello');
  assert.deepEqual(user.items.slice(1), attachments);
  assert.deepEqual(
    rpc.params.inputConfig.inputBlocks,
    user.inputConfig.inputBlocks,
  );
  assert.deepEqual(user.inputConfig.inputBlocks.slice(1), attachments);
  assert.equal(rpc.params.inputConfig.modelId, 'gpt-test');
  assert.deepEqual(rpc.params.inputConfig.configOptionValues, {
    effort: 'high',
  });
  const projection = runtime.projectSession(server, 'live');
  assert.deepEqual(projection.composer, {
    modelId: 'gpt-test',
    effort: 'high',
  });
  const projectedImage = projection.entries[0].items[1];
  assert.equal(projectedImage.type, 'image');
  assert.equal(projectedImage.image.id, 'img1');
  assert.equal(projectedImage.image.fileName, '照片.png');
  assert.equal(projectedImage.text, undefined);
  const projectedFile = projection.entries[0].items[2];
  assert.equal(projectedFile.type, 'file');
  assert.equal(projectedFile.file.id, attachments[1].fileId);
  assert.equal(projectedFile.file.fileName, attachments[1].fileName);
  assert.equal(
    projectedFile.text,
    undefined,
    'Filenames must not be appended to the message text',
  );

  assert.deepEqual(user.inputConfig.mcpServerIds, []);
  const version = server.version();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'reply');
  entry.set('userTurnId', 'another-turn');
  const item = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  item.set('type', 'text');
  item.setContainer('text', new LoroText()).insert(0, 'stream');
  entry.set('role', 'assistant');
  entry.set('finished', true);
  server.commit();
  const update = server.export({ mode: 'update', from: version });
  const firstReply = nextLive();
  sessionRead(live({ body: frame(update) }));
  assert.equal((await firstReply).entries[1].items[0].text, 'stream');
  assert.equal(background.at(-1).state, 'sent'); // Another turn's completion cannot end this task.
  const correlatedVersion = server.version();
  entry.set('userTurnId', result.id);
  entry.set('finished', false);
  server.commit();
  const correlated = nextLive();
  sessionRead(
    live(
      {
        body: frame(server.export({ mode: 'update', from: correlatedVersion })),
      },
      '2a',
    ),
  );
  await correlated;
  assert.equal(background.at(-1).state, 'receiving');
  const v2 = server.version();
  entry.get('items').get(0).get('text').insert(6, ' complete');
  entry.set('finished', true);
  server.commit();
  const fullUpdate = server.export({ mode: 'update', from: v2 });
  const finalReply = nextLive();
  sessionRead(live({ body: frame(fullUpdate) }, '3'));
  const final = await finalReply;
  assert.equal(background.at(-1).state, 'completed');
  assert.equal(final.entries.length, 2);
  assert.equal(final.entries[1].items[0].text, 'stream complete');
  assert.equal(final.entries[1].finished, true);
  const duplicate = nextLive();
  sessionRead(live({ body: frame(fullUpdate) }, '4'));
  assert.equal((await duplicate).entries.length, 2);
  const misordered = new LoroDoc();
  const assistant = misordered.getList('history').pushContainer(new LoroMap());
  assistant.set('id', 'a');
  assistant.set('role', 'assistant');
  assistant.set('userTurnId', 'u');
  const parent = misordered.getList('history').pushContainer(new LoroMap());
  parent.set('id', 'u');
  parent.set('role', 'user');
  assert.deepEqual(
    runtime.projectSession(misordered, 'live').entries.map((e) => e.id),
    ['u', 'a'],
  );
  const oldRead = sessionRead;
  runtime.stopSessions();
  oldRead(live({ body: frame(update) }, '5'));
  assert.equal(
    (await runtime.sendTurn({ sessionId: 's1', text: 'no' })).state,
    'not_sent',
  );
  assert.equal(appends, 1);
  const reopen = nextLive();
  await runtime.openSession(
    's1',
    'w1',
    async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://example.invalid',
    }),
    (e) => {
      const value = JSON.parse(e.session);
      if (value.status === 'live') resolveLive?.(value);
    },
    async () => {},
  );
  await reopen;
  loseAppendAck = true;
  const uncertain = await runtime.sendTurn({
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    text: '',
    attachmentBlocks: attachments,
    cliType: 'builtin',
    agentType: 'codex',
  });
  assert.equal(uncertain.state, 'unknown');
  assert.deepEqual(server.toJSON().history.at(-1).items, attachments);
  assert.equal(
    server.toJSON().history.filter((e) => e.id === uncertain.id).length,
    1,
  );
  assert.equal(appends, 2);
  assert.equal(
    (await runtime.sendTurn({ ...turn, id: uncertain.id })).reason,
    'turn_already_exists',
  );
  assert.equal(appends, 2, 'ambiguous append must not be replayed');
  runtime.stopSessions();
  delete globalThis.__sessionClient;
});

async function loadProject() {
  const bundle = await build({
    entryPoints: [
      new URL(
        '../../../../packages/cloud-runtime/src/runtime/project.ts',
        import.meta.url,
      ).pathname,
    ],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    external: ['loro-crdt/base64'],
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(bundle.outputFiles[0].text).toString('base64')
  );
}

test('projection carries stable item ids, tool summaries, and diff counts', async () => {
  const mod = await loadProject();

  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e1');
  entry.set('role', 'assistant');
  entry.set('finished', false);
  const items = entry.setContainer('items', new LoroList());

  const prose = items.pushContainer(new LoroMap());
  prose.set('type', 'text');
  prose.setContainer('text', new LoroText()).insert(0, '看了一眼 auth.ts');

  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_1');
  call.set('kind', 'edit');
  call.set('title', 'Edit src/auth.ts');
  call.set('status', 'completed');
  call.set('content', [
    {
      type: 'diff',
      path: 'src/auth.ts',
      oldText: 'a\nb\nc\n',
      newText: 'a\nB\nc\nd\n',
    },
  ]);
  doc.commit();

  const first = mod.projectSession(doc, 'live');
  assert.equal(first.v, 1);
  assert.equal(first.entries.length, 1);

  const [textItem, toolItem] = first.entries[0].items;
  assert.equal(textItem.type, 'text');
  assert.equal(textItem.text, '看了一眼 auth.ts');
  assert.match(textItem.itemId, /^\d+:\d+$/);

  assert.equal(toolItem.itemId, 'tc_1');
  assert.equal(toolItem.kind, 'edit');
  assert.equal(toolItem.path, 'src/auth.ts');
  assert.equal(toolItem.added, 2);
  assert.equal(toolItem.removed, 1);
  assert.equal(toolItem.hasDetail, true);
  assert.equal(toolItem.permission, undefined);

  const idBefore = textItem.itemId;
  prose.get('text').insert(11, '，超时来自 fetch');
  doc.commit();
  const second = mod.projectSession(doc, 'live');
  assert.equal(second.entries[0].items[0].itemId, idBefore);
  assert.ok(second.entries[0].items[0].rev > textItem.rev);
  assert.equal(second.entries[0].items[1].rev, toolItem.rev);
  assert.ok(second.revision > first.revision);
});

test('projection keeps subagent task identity and live fields', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e-task');
  entry.set('role', 'assistant');
  const task = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  task.set('type', 'subagent_task');
  task.set('taskId', 't1');
  task.set('status', 'in_progress');
  task.set('actor', 'Explore');
  task.set('description', 'Find overlay chrome');
  task.set('lastToolName', 'Read');
  task.set('summary', 'Still looking');
  task.set('error', 'none');
  task.set('isBackgrounded', true);
  task.set('skipTranscript', false);
  doc.commit();
  const item = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(item.type, 'subagent_task');
  assert.equal(item.taskId, 't1');
  assert.equal(item.status, 'in_progress');
  assert.equal(item.actor, 'Explore');
  assert.equal(item.description, 'Find overlay chrome');
  assert.equal(item.lastToolName, 'Read');
  assert.equal(item.summary, 'Still looking');
  assert.equal(item.error, 'none');
  assert.equal(item.isBackgrounded, true);
  assert.equal(item.skipTranscript, false);
});

test('subtask run projection and tool details survive live updates and cache restoration', async () => {
  const fixture = await openTestSession();
  try {
    const run = {
      sessionId: 'child',
      snapshot: { state: 'running' },
      items: [
        { type: 'thought', text: 'Trace the composer' },
        {
          type: 'tool_call',
          toolCallId: 'read',
          kind: 'read',
          title: 'Read composer',
          status: 'completed',
          content: [{ type: 'output', output: 'first' }],
        },
        {
          type: 'plan',
          entries: [{ content: 'Move task chip', status: 'in_progress' }],
        },
        { type: 'text', text: 'Found the chip row' },
        { type: 'subagent_task', taskId: 'ignored' },
      ],
    };
    const entry = fixture.server
      .getList('history')
      .pushContainer(new LoroMap());
    entry.set('id', 'reply');
    entry.set('role', 'assistant');
    const task = entry
      .setContainer('items', new LoroList())
      .pushContainer(new LoroMap());
    task.set('type', 'subagent_task');
    task.set('taskId', 'task');
    task.set('status', 'in_progress');
    task.set('run', run);
    fixture.server.commit();
    await fixture.pushUpdate();
    const before = fixture.runtime.projectSession(fixture.server, 'live')
      .entries[0].items[0];
    assert.deepEqual(
      before.run.items.map((item) => item.type),
      ['thought', 'tool_call', 'plan', 'text'],
    );
    assert.equal(before.run.items[0].text, 'Trace the composer');
    const tool = before.run.items[1];
    assert.equal(tool.hasDetail, true);
    const detail = await fixture.runtime.itemDetail({
      sessionId: 's1',
      entryId: 'reply',
      itemId: tool.itemId,
    });
    assert.equal(detail.blocks[0].output, 'first');
    run.items[1].content[0].output = 'updated';
    run.snapshot.state = 'completed';
    task.set('run', run);
    fixture.server.commit();
    await fixture.pushUpdate();
    const after = fixture.runtime.projectSession(fixture.server, 'live')
      .entries[0].items[0];
    assert.equal(after.run.items[1].itemId, tool.itemId);
    assert.ok(after.run.items[1].rev > tool.rev);
    assert.ok(after.rev > before.rev);
    assert.equal(
      (
        await fixture.runtime.itemDetail({
          sessionId: 's1',
          entryId: 'reply',
          itemId: tool.itemId,
        })
      ).blocks[0].output,
      'updated',
    );
    const restored = new LoroDoc();
    restored.import(fixture.server.export({ mode: 'snapshot' }));
    assert.equal(
      fixture.runtime.projectSession(restored, 'live').entries[0].items[0].run
        .state,
      'completed',
    );
    await assert.rejects(
      fixture.runtime.itemDetail({
        sessionId: 's1',
        entryId: 'reply',
        itemId: JSON.stringify(['missing', 'read']),
      }),
      /item_not_found/,
    );
  } finally {
    fixture.close();
  }
});

test('MCP image groups survive projection, cache updates and history bootstrap', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'upload');
  entry.set('role', 'assistant');
  const group = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  group.set('type', 'image_group');
  const photo = {
    imageId: 'photo',
    fileName: 'photo.png',
    storageSessionId: 'source',
    width: 600,
    height: 400,
  };
  group.set('images', [photo]);
  doc.commit();
  const first = projectSession(doc, 'live').entries[0].items[0];
  assert.deepEqual(first.images, [
    {
      id: 'photo',
      fileName: 'photo.png',
      storageSessionId: 'source',
      width: 600,
      height: 400,
    },
  ]);
  group.set('images', [
    photo,
    { ...photo, imageId: 'second' },
    null,
    { imageId: '' },
  ]);
  doc.commit();
  const second = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(second.itemId, first.itemId);
  assert.ok(second.rev > first.rev);
  assert.deepEqual(
    second.images.map((image) => image.id),
    ['photo', 'second'],
  );
  const restored = new LoroDoc();
  restored.import(doc.export({ mode: 'snapshot' }));
  assert.deepEqual(
    projectSession(restored, 'live').entries[0].items[0].images,
    second.images,
  );
});

test('MCP files retain their download target and update when local upload completes', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'files');
  entry.set('role', 'assistant');
  const file = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  for (const [key, value] of Object.entries({
    type: 'file',
    fileId: 'clip',
    fileName: 'clip.mp4',
    storageSessionId: 'source',
    transport: 'local',
    sizeBytes: 1024,
  }))
    file.set(key, value);
  doc.commit();
  const first = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(first.file.transport, 'local');
  file.set('transport', 'r2');
  doc.commit();
  const uploaded = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(uploaded.itemId, first.itemId);
  assert.ok(uploaded.rev > first.rev);
  assert.deepEqual(uploaded.file, {
    id: 'clip',
    fileName: 'clip.mp4',
    storageSessionId: 'source',
    transport: 'r2',
    sizeBytes: 1024,
  });
  const restored = new LoroDoc();
  restored.import(doc.export({ mode: 'snapshot' }));
  assert.deepEqual(
    projectSession(restored, 'live').entries[0].items[0].file,
    uploaded.file,
  );
});

test('unchanged entries keep their summary objects; prose is coalesced, status is not', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const first = doc.getList('history').pushContainer(new LoroMap());
  first.set('id', 'e1');
  first.set('role', 'user');
  const second = doc.getList('history').pushContainer(new LoroMap());
  second.set('id', 'e2');
  second.set('role', 'assistant');
  const items = second.setContainer('items', new LoroList());
  const prose = items.pushContainer(new LoroMap());
  prose.set('type', 'text');
  prose.setContainer('text', new LoroText()).insert(0, 'hi');
  doc.commit();

  const a = projectSession(doc, 'live');
  prose.get('text').insert(2, ' there');
  doc.commit();
  const b = projectSession(doc, 'live');

  assert.equal(a.entries[0].rev, b.entries[0].rev);
  assert.ok(b.entries[1].rev > a.entries[1].rev);
});

test('itemDetail 按需取回 blocks，超限分页，缺失明确报错', async () => {
  const { runtime, server, pushUpdate, close } = await openTestSession();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e9');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.set('type', 'tool_call');
  call.set('toolCallId', 'tc_9');
  call.set('kind', 'execute');
  call.set('status', 'completed');
  call.set('content', [
    { type: 'terminal_command', command: 'pnpm', args: ['test'], cwd: '/w' },
    { type: 'terminal_output', output: 'ok\n', stream: 'combined' },
  ]);
  server.commit();
  await pushUpdate();

  const detail = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
  });
  assert.equal(detail.itemId, 'tc_9');
  assert.equal(detail.blocks.length, 2);
  assert.equal(detail.blocks[0].command, 'pnpm');
  assert.equal(detail.truncated, false);
  assert.equal(detail.nextCursor, undefined);
  assert.ok(detail.rev > 0);

  call.set('content', [
    { type: 'terminal_output', output: 'x'.repeat(400 * 1024) },
    { type: 'terminal_output', output: 'y'.repeat(400 * 1024) },
  ]);
  server.commit();
  await pushUpdate();

  const page1 = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
  });
  assert.equal(page1.truncated, true);
  assert.equal(page1.blocks.length, 1);
  assert.ok(page1.nextCursor);

  const page2 = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e9',
    itemId: 'tc_9',
    cursor: page1.nextCursor,
  });
  assert.equal(page2.blocks.length, 1);
  assert.equal(page2.truncated, false);

  await assert.rejects(
    runtime.itemDetail({ sessionId: 's1', entryId: 'e9', itemId: 'nope' }),
    /item_not_found/,
  );

  await assert.rejects(
    runtime.itemDetail({ sessionId: 'other', entryId: 'e9', itemId: 'tc_9' }),
    /session_not_ready/,
  );
  close();
});

test('tool calls whose toolCallId is a LoroText still resolve for detail and permission answers', async () => {
  const { runtime, server, pushUpdate, close } = await openTestSession();
  const entry = server.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'e10');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const call = items.pushContainer(new LoroMap());
  call.setContainer('type', new LoroText()).insert(0, 'tool_call');
  call.setContainer('toolCallId', new LoroText()).insert(0, 'exec-text');
  call.set('kind', 'execute');
  call.set('status', 'pending');
  call.set('content', [
    { type: 'terminal_command', command: 'pnpm', args: [], cwd: '/w' },
  ]);
  call.set('permissionRequest', {
    requestId: 'req-1',
    options: [{ optionId: 'allow_once', name: 'Yes', kind: 'allow_once' }],
  });
  server.commit();
  await pushUpdate();

  const detail = await runtime.itemDetail({
    sessionId: 's1',
    entryId: 'e10',
    itemId: 'exec-text',
  });
  assert.equal(detail.blocks.length, 1);
  assert.equal(detail.options.length, 1);

  const answer = await runtime.respondPermission({
    sessionId: 's1',
    entryId: 'e10',
    itemId: 'exec-text',
    requestId: 'req-1',
    optionId: 'allow_once',
  });
  assert.equal(answer.state, 'accepted');
  close();
});

test(
  'background Sessions keep syncing, visits promote LRU, eviction aborts reads and preserves the final cache',
  { timeout: 15000 },
  async (t) => {
    const servers = new Map();
    const clients = [];
    const events = [];
    const waiters = [];
    const ok = (result) => ({ ok: true, result });
    const until = (predicate) =>
      new Promise((resolve) => waiters.push({ predicate, resolve }));
    const emit = (event) => {
      if (!event.session) return;
      const value = { ...event, data: JSON.parse(event.session) };
      events.push(value);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(value)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(value);
        }
      }
    };
    globalThis.__sessionClient = class {
      constructor({ url }) {
        this.id = decodeURIComponent(url).split(':s:')[1];
        clients.push(this);
      }
      async bootstrap({ signal }) {
        this.signal = signal;
        const server = servers.get(this.id) ?? new LoroDoc();
        if (!server.getList('history').length) {
          const entry = server.getList('history').pushContainer(new LoroMap());
          entry.set('id', 'same-entry');
          entry.set('role', 'assistant');
          entry.set('finished', this.id.startsWith('idle-'));
          const item = entry
            .setContainer('items', new LoroList())
            .pushContainer(new LoroMap());
          item.set('type', 'tool_call');
          item.set('toolCallId', 'same-tool');
        }
        servers.set(this.id, server);
        this.version = server.version();
        return ok({
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: server.export({ mode: 'snapshot' }) },
          updates: [],
        });
      }
      readOnce(request) {
        this.request = request;
        return new Promise((resolve, reject) => {
          this.resolve = resolve;
          request.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
      push(text) {
        const server = servers.get(this.id);
        let entry = server.getList('history').get(0);
        if (!entry) {
          entry = server.getList('history').pushContainer(new LoroMap());
          // Deliberately collide across Sessions to exercise projection isolation.
          entry.set('id', 'same-entry');
          entry.set('role', 'assistant');
          const item = entry
            .setContainer('items', new LoroList())
            .pushContainer(new LoroMap());
          item.set('type', 'tool_call');
          item.set('toolCallId', 'same-tool');
        }
        entry.set('finished', false);
        entry.get('items').get(0).set('title', text);
        server.commit();
        const body = frame(
          server.export({ mode: 'update', from: this.version }),
        );
        this.version = server.version();
        this.resolve(
          ok({
            nextOffset: String(Number(this.request.offset) + 1),
            upToDate: true,
            closed: false,
            payload: { body },
          }),
        );
      }
    };
    const runtime = await loadRuntime();
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    const open = async (id, workspace = 'w1') => {
      const ready = until(
        (e) =>
          e.sessionId === id &&
          e.type === 'session' &&
          e.data.status === 'live',
      );
      await runtime.openSession(
        id,
        workspace,
        async () => ({
          token: 'synthetic',
          gatewayBaseUrl: 'https://x.invalid',
        }),
        emit,
        async () => {},
      );
      return ready;
    };
    const client = (id) => clients.findLast((c) => c.id === id);
    await open('a');
    await open('b');
    await open('c');
    runtime.closeSession();
    for (const id of ['idle-one', 'idle-two', 'idle-three']) await open(id);
    assert.ok(
      ['a', 'b', 'c'].every((id) => !client(id).signal.aborted),
      'idle visits must not evict working sessions',
    );
    assert.ok(
      client('idle-one').signal.aborted && client('idle-two').signal.aborted,
      'idle sessions must not remain in the background LRU',
    );
    runtime.closeSession();
    assert.equal(client('idle-three').signal.aborted, true);
    await open('d');
    assert.equal(clients.filter((c) => !c.signal.aborted).length, 4);
    const background = until(
      (e) =>
        e.sessionId === 'a' &&
        e.type === 'sessionCache' &&
        e.data.entries.length,
    );
    client('a').push('changed while away');
    const cached = await background;
    assert.equal(cached.synced, true);
    assert.equal(cached.data.entries[0].items[0].title, 'changed while away');
    assert.equal(
      events.filter((e) => e.sessionId === 'a' && e.type === 'session').length,
      2,
    );

    await open('e');
    assert.equal(
      client('a').signal.aborted,
      true,
      'updates must not promote a',
    );
    const bCount = clients.filter((c) => c.id === 'b').length;
    await open('b');
    assert.equal(
      clients.filter((c) => c.id === 'b').length,
      bCount,
      'retained replica needs no bootstrap',
    );
    await open('f');
    assert.equal(client('c').signal.aborted, true, 'visiting b protects it');
    assert.equal(client('b').signal.aborted, false);

    const bUpdate = until(
      (e) =>
        e.sessionId === 'b' &&
        e.type === 'sessionCache' &&
        e.data.entries.length,
    );
    client('b').push('b version one');
    const before = await bUpdate;
    const fUpdate = until((e) => e.sessionId === 'f' && e.data.entries.length);
    client('f').push('different session');
    await fUpdate;
    const reopened = await open('b');
    assert.equal(reopened.data.entries[0].items[0].title, 'b version one');
    assert.equal(
      reopened.data.entries[0].items[0].rev,
      before.data.entries[0].items[0].rev,
    );
    assert.equal(
      (
        await runtime.itemDetail({
          sessionId: 'b',
          entryId: 'same-entry',
          itemId: 'same-tool',
        })
      ).rev,
      before.data.entries[0].items[0].rev,
    );

    runtime.closeSession();
    assert.equal(
      clients.filter((c) => !c.signal.aborted).length,
      3,
      'no foreground means only three subscriptions',
    );
    assert.equal(
      (await runtime.sendTurn({ sessionId: 'b', text: 'hidden' })).state,
      'not_sent',
    );
    const afterClose = until(
      (e) =>
        e.sessionId === 'b' &&
        e.type === 'sessionCache' &&
        e.data.entries[0]?.items[0]?.title === 'after close',
    );
    client('b').push('after close');
    await afterClose;
    const count = clients.length;
    assert.equal(
      (await open('b')).data.entries[0].items[0].title,
      'after close',
    );
    assert.equal(clients.length, count);

    // Queue an update on the oldest Session and evict before its cache timer fires.
    client('e').push('last before eviction');
    await new Promise((resolve) => setImmediate(resolve));
    await open('g');
    await open('h');
    assert.equal(client('e').signal.aborted, true);
    assert.ok(
      events.some(
        (e) =>
          e.sessionId === 'e' &&
          e.type === 'sessionCache' &&
          e.data.entries[0]?.items[0]?.title === 'last before eviction',
      ),
    );
    const oldClients = [...clients];
    await open('b', 'other-workspace');
    assert.ok(oldClients.every((c) => c.signal.aborted));
    await open('idle-start', 'other-workspace');
    const started = until(
      (e) =>
        e.sessionId === 'idle-start' && e.data.entries[0]?.finished === false,
    );
    client('idle-start').push('actually working now');
    await started;
    runtime.closeSession();
    assert.equal(
      client('idle-start').signal.aborted,
      false,
      'an idle foreground session enters the LRU once it starts working',
    );
    runtime.stopSessions();
    assert.ok(clients.every((c) => c.signal.aborted));
  },
);

test('closeSession does not abort an in-flight send or block a later send on the retained replica', async () => {
  let releaseExpand;
  const fixture = await openTestSession({
    onRpc: () => ({ result: { accepted: true } }),
  });
  const args = {
    sessionId: 's1',
    machineId: 'm1',
    userId: 'u1',
    cliType: 'builtin',
    agentType: 'grok',
    text: 'keep sending',
  };
  try {
    const sending = fixture.runtime.sendTurn(args, async (text) => {
      await new Promise((resolve) => {
        releaseExpand = resolve;
      });
      return text;
    });
    fixture.runtime.closeSession();
    releaseExpand();
    assert.equal((await sending).state, 'accepted');
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, text: 'second' })).state,
      'queued',
    );
  } finally {
    fixture.close();
  }
});

test(
  'ensureSession reserves a replica so visit-order LRU cannot evict it until release',
  { timeout: 15000 },
  async (t) => {
    const servers = new Map();
    const clients = [];
    const events = [];
    const waiters = [];
    const ok = (result) => ({ ok: true, result });
    const until = (predicate) =>
      new Promise((resolve) => waiters.push({ predicate, resolve }));
    const emit = (event) => {
      if (!event.session) return;
      const value = { ...event, data: JSON.parse(event.session) };
      events.push(value);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(value)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(value);
        }
      }
    };
    const grant = async () => ({
      token: 'synthetic',
      gatewayBaseUrl: 'https://x.invalid',
    });
    globalThis.__sessionClient = class {
      constructor({ url }) {
        this.id = decodeURIComponent(url).split(':s:')[1];
        clients.push(this);
      }
      async bootstrap({ signal }) {
        this.signal = signal;
        const server = servers.get(this.id) ?? new LoroDoc();
        if (!server.getList('history').length)
          server.getList('history').push({
            id: 'working',
            role: 'assistant',
            finished: false,
            items: [],
          });
        servers.set(this.id, server);
        this.version = server.version();
        return ok({
          snapshotOffset: '1',
          nextOffset: '1',
          upToDate: true,
          snapshot: { body: server.export({ mode: 'snapshot' }) },
          updates: [],
        });
      }
      readOnce(request) {
        this.request = request;
        return new Promise((resolve, reject) => {
          this.resolve = resolve;
          request.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true },
          );
        });
      }
    };
    const runtime = await loadRuntime();
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    const live = (id) =>
      until((e) => e.sessionId === id && e.data.status === 'live');
    const open = async (id) => {
      const ready = live(id);
      await runtime.openSession(id, 'w1', grant, emit, async () => {});
      return ready;
    };
    const ensure = async (id) => {
      const ready = live(id);
      await runtime.ensureSession(id, 'w1', grant, emit, async () => {});
      return ready;
    };
    const client = (id) => clients.findLast((c) => c.id === id);

    await ensure('held');
    assert.equal(
      events.filter((e) => e.sessionId === 'held' && e.type === 'session')
        .length,
      0,
      'ensure must not steal the foreground pointer',
    );
    const heldCount = clients.filter((c) => c.id === 'held').length;
    await ensure('held');
    assert.equal(
      clients.filter((c) => c.id === 'held').length,
      heldCount,
      'ensure of a live replica must not bootstrap again',
    );

    await open('b');
    await open('c');
    await open('d');
    await open('e');
    assert.equal(client('held').signal.aborted, false);
    assert.equal(
      clients.filter((c) => !c.signal.aborted).length,
      5,
      'one reserved replica sits outside the three background LRU slots',
    );

    runtime.releaseReserve('held');
    await open('f');
    await open('g');
    await open('h');
    await open('i');
    assert.equal(
      client('held').signal.aborted,
      true,
      'a graduated replica returns to visit-order eviction',
    );
  },
);

test(
  'eviction during authorization cannot start a late bootstrap',
  { timeout: 5000 },
  async (t) => {
    const bootstraps = [];
    globalThis.__sessionClient = class {
      constructor({ url }) {
        this.url = url;
      }
      async bootstrap() {
        bootstraps.push(this.url);
        return { ok: false, result: { code: 'synthetic_offline' } };
      }
    };
    const runtime = await loadRuntime();
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    let authorize;
    const grant = new Promise((resolve) => {
      authorize = resolve;
    });
    const events = [];
    for (const id of ['late-a', 'late-b', 'late-c', 'late-d', 'late-e'])
      await runtime.openSession(
        id,
        'w1',
        () => grant,
        (e) => events.push(e),
        async () => {},
      );
    authorize({ token: 'synthetic', gatewayBaseUrl: 'https://x.invalid' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bootstraps.length, 1);
    assert.ok(
      bootstraps.every((url) => !decodeURIComponent(url).endsWith(':late-a')),
    );
    assert.ok(
      events
        .filter((e) => e.sessionId === 'late-a')
        .filter((e) => e.session)
        .every((e) => JSON.parse(e.session).status === 'syncing'),
    );
    const before = bootstraps.length;
    await runtime.openSession(
      'late-e',
      'w1',
      () => grant,
      () => {},
      async () => {},
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      bootstraps.length,
      before,
      'opening a reconnecting Session reuses its automatic retry',
    );
  },
);

test(
  'session bootstrap and stream reads recover without another watch or writes',
  { timeout: 8000 },
  async (t) => {
    let bootstraps = 0;
    const reads = [];
    const events = [];
    const history = new LoroDoc();
    let recovered;
    const recovery = new Promise((resolve) => {
      recovered = resolve;
    });
    globalThis.__sessionClient = class {
      async bootstrap() {
        if (++bootstraps === 1) throw new Error('network unavailable');
        return {
          ok: true,
          result: {
            snapshotOffset: '7',
            snapshot: { body: history.export({ mode: 'snapshot' }) },
            updates: [],
            nextOffset: '7',
            cursor: 'cursor-7',
            upToDate: true,
          },
        };
      }
      async readOnce(request) {
        reads.push({ offset: request.offset, cursor: request.cursor });
        if (reads.length === 1)
          return { ok: false, result: { code: 'network_error' } };
        if (reads.length === 2)
          return {
            ok: true,
            result: {
              nextOffset: '8',
              cursor: 'cursor-8',
              upToDate: true,
              closed: false,
            },
          };
        recovered();
        return new Promise((resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        });
      }
      append() {
        assert.fail('read recovery must never append');
      }
    };
    const runtime = await loadRuntime();
    runtime.appendUserTurn(
      history,
      'saved-turn',
      'Existing message',
      'u1',
      {},
      '2026-09-11T00:00:00Z',
    );
    t.after(() => {
      runtime.stopSessions();
      delete globalThis.__sessionClient;
    });
    await runtime.openSession(
      'recovery',
      'w1',
      async () => ({
        token: 'synthetic',
        gatewayBaseUrl: 'https://x.invalid',
      }),
      (event) => events.push(JSON.parse(event.session)),
      async () => {
        assert.fail('read recovery must never dispatch');
      },
    );
    await recovery;
    assert.equal(bootstraps, 2);
    assert.deepEqual(reads, [
      { offset: '7', cursor: 'cursor-7' },
      { offset: '7', cursor: 'cursor-7' },
      { offset: '8', cursor: 'cursor-8' },
    ]);
    assert.equal(events.at(-1).status, 'live');
    const firstLive = events.find((event) => event.status === 'live');
    assert.equal(firstLive.entries.length, 1);
    assert.deepEqual(events.at(-1).entries, firstLive.entries);
    assert.ok(events.every((event) => event.status !== 'offline'));
  },
);

test('busy turns use the OSS FIFO queue, durable before watermark; lost ACK is never replayed', async () => {
  let fail = false;
  const watermarks = [];
  const fixture = await openTestSession({
    failAppend: () => fail,
    markDispatch: async (sessionId, turnId, queued) => {
      assert.equal(queued, true);
      assert.ok(
        fixture.server.toJSON().mq.some((item) => item.userTurnId === turnId),
      );
      watermarks.push(turnId);
    },
  });
  try {
    const args = {
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'next',
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'picked',
    };
    // Catalog busy can arrive before the first assistant history entry.
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, queue: true })).state,
      'queued',
    );
    assert.equal((fixture.server.toJSON().history ?? []).length, 0);
    fixture.server.getMovableList('mq').delete(0, 1);
    watermarks.length = 0;
    fixture.server
      .getList('history')
      .push({ id: 'running', role: 'assistant', finished: false, items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const first = await fixture.runtime.sendTurn(args);
    const image = {
      type: 'image',
      imageId: 'queued-image',
      mimeType: 'image/png',
      sizeBytes: 12,
    };
    const second = await fixture.runtime.sendTurn({
      ...args,
      text: 'then',
      attachmentBlocks: [image],
    });
    assert.equal(first.state, 'queued');
    assert.equal(second.state, 'queued');
    assert.deepEqual(
      fixture.server.toJSON().mq.map((item) => item.userTurnId),
      [first.id, second.id],
    );
    assert.deepEqual(watermarks, [first.id, second.id]);
    assert.deepEqual(
      fixture.server.toJSON().mq[1].acpSessionConfig.inputBlocks,
      [{ type: 'text', text: 'then' }, image],
    );
    assert.equal(
      fixture.server.toJSON().history.length,
      1,
      'queue must not create a dispatchable user history entry',
    );
    assert.equal(
      fixture.server.toJSON().mq[0].acpSessionConfig.modelId,
      'picked',
    );
    assert.ok(
      fixture.appends.every((url) => !url.includes(':rpc:')),
      'queue must not call dispatch-turn',
    );
    const projected = fixture.runtime.projectSession(fixture.server, 'live');
    assert.deepEqual(
      projected.entries.slice(1).map((entry) => entry.status),
      ['queued', 'queued'],
    );
    assert.equal(projected.entries[1].items[0].text, 'next');
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, id: first.id })).state,
      'unknown',
    );
    fail = true;
    const lost = await fixture.runtime.sendTurn(args);
    assert.equal(lost.state, 'unknown');
    const count = fixture.appends.length;
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, id: lost.id })).state,
      'unknown',
    );
    assert.equal(fixture.appends.length, count);
    assert.equal(watermarks.length, 2);
  } finally {
    fixture.close();
  }
});

test('guide writes a steer history turn instead of the FIFO queue and retains its Role', async () => {
  const requests = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      requests.push(request);
      const raw = fixture.server.toJSON();
      const entry = raw.history.find(
        (item) => item.id === request.params.userTurnId,
      );
      assert.equal(
        entry.status,
        'pending_apply',
        'guide intent must be durable before RPC',
      );
      assert.equal((raw.mq ?? []).length, 0);
      return { result: { applied: true } };
    },
  });
  try {
    fixture.server.getList('history').push({
      id: 'role-input',
      role: 'user',
      finished: true,
      status: 'handled',
      items: [],
      inputConfig: {
        cliType: 'builtin',
        agentType: 'codex',
        agentRoleId: 'role-coder',
        agentRoleRevision: 3,
      },
    });
    fixture.server.getList('history').push({
      id: 'running',
      role: 'assistant',
      finished: false,
      items: [],
    });
    fixture.server.commit();
    await fixture.pushUpdate();
    const result = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'steer now',
      cliType: 'builtin',
      agentType: 'codex',
      guide: true,
    });
    assert.equal(result.state, 'uploaded');
    await new Promise((resolve) => setImmediate(resolve));
    const raw = fixture.server.toJSON();
    assert.equal((raw.mq ?? []).length, 0);
    const entry = raw.history.find((item) => item.id === result.id);
    assert.equal(entry.role, 'user');
    assert.equal(entry.status, 'processing');
    assert.equal(entry.inputConfig?._lodyDeliveryKind, 'steer');
    const projected = fixture.runtime
      .projectSession(fixture.server, 'live')
      .entries.find((item) => item.id === result.id);
    assert.equal(projected.status, 'processing');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'session/steer');
    assert.equal(requests[0].params.expectedTurnId, 'running');
    assert.equal(requests[0].params.userTurnId, result.id);
    assert.equal(requests[0].params.inputConfig.agentRoleId, 'role-coder');
    assert.equal(requests[0].params.inputConfig.agentRoleRevision, 3);
    assert.equal(entry.inputConfig.agentRoleId, 'role-coder');
  } finally {
    fixture.close();
  }
});

test('foreground sends retain their replica through page changes and only released reserves enter the LRU', async () => {
  const fixture = await openTestSession({
    onRpc: () => ({ result: { accepted: true } }),
  });
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://x.invalid',
  });
  try {
    let resume;
    const send = fixture.runtime.sendTurn(
      {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        text: 'expanded',
        cliType: 'builtin',
        agentType: 'codex',
      },
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    fixture.runtime.closeSession();
    for (let i = 0; i < 6; i++)
      await fixture.runtime.openSession(
        `visit-${i}`,
        'w1',
        grant,
        () => {},
        async () => {},
      );
    assert.ok(fixture.runtime.retainedSessionIds().includes('s1'));
    resume('expanded');
    assert.equal((await send).state, 'accepted');
    fixture.runtime.releaseReserve('s1');
    assert.ok(
      fixture.runtime.retainedSessionIds().includes('s1'),
      'a submitted turn stays subscribed before its first assistant event',
    );
    for (let i = 6; i < 10; i++) {
      await fixture.runtime.openSession(
        `visit-${i}`,
        'w1',
        grant,
        () => {},
        async () => {},
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(!fixture.runtime.retainedSessionIds().includes('s1'));
  } finally {
    fixture.close();
  }
});

test('completed background work retires its idle replica without reporting a failure', async () => {
  const fixture = await openTestSession({
    onRpc: () => ({ result: { accepted: true } }),
  });
  try {
    const sent = await fixture.runtime.sendTurn({
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'finish offscreen',
      cliType: 'builtin',
      agentType: 'codex',
      backgroundTaskId: 'completion',
    });
    assert.equal(sent.state, 'accepted');
    fixture.runtime.releaseReserve('s1');
    fixture.runtime.closeSession();
    fixture.server.getList('history').push({
      id: 'reply',
      role: 'assistant',
      userTurnId: sent.id,
      finished: true,
      items: [],
    });
    await fixture.pushUpdate();
    assert.deepEqual(fixture.background.at(-1), {
      id: 'completion',
      state: 'completed',
    });
    assert.deepEqual(fixture.runtime.retainedSessionIds(), []);
  } finally {
    fixture.close();
  }
});

test('restoring ordinary background visits does not reserve them', async () => {
  const fixture = await openTestSession();
  const grant = async () => ({
    token: 'synthetic',
    gatewayBaseUrl: 'https://x.invalid',
  });
  try {
    fixture.runtime.stopSessions();
    for (const id of ['old-a', 'old-b', 'old-c'])
      await fixture.runtime.openSession(
        id,
        'w1',
        grant,
        () => {},
        async () => {},
        false,
      );
    for (let i = 0; i < 6; i++)
      await fixture.runtime.openSession(
        `new-${i}`,
        'w1',
        grant,
        () => {},
        async () => {},
      );
    assert.ok(
      fixture.runtime.retainedSessionIds().every((id) => id.startsWith('new-')),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fixture.runtime.retainedSessionIds().length, 1);
    assert.equal(fixture.runtime.reservedSessionIds().length, 0);
  } finally {
    fixture.close();
  }
});

test('guide rechecks the target after preparation and dispatches normally if it ended', async () => {
  const requests = [];
  const fixture = await openTestSession({
    onRpc: (request) => {
      requests.push(request);
      return { result: { accepted: true } };
    },
  });
  try {
    fixture.server
      .getList('history')
      .push({ id: 'running', role: 'assistant', finished: false, items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const result = await fixture.runtime.sendTurn(
      {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        text: 'follow-up',
        cliType: 'builtin',
        agentType: 'codex',
        guide: true,
      },
      async (text) => {
        fixture.server.getList('history').delete(0, 1);
        fixture.server.getList('history').push({
          id: 'running',
          role: 'assistant',
          finished: true,
          items: [],
        });
        fixture.server.commit();
        await fixture.pushUpdate();
        fixture.runtime.closeSession();
        return text;
      },
    );
    assert.equal(result.state, 'accepted');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'session/dispatch-turn');
    assert.equal(
      fixture.server.toJSON().history.find((entry) => entry.id === result.id)
        .status,
      'pending',
    );
  } finally {
    fixture.close();
  }
});

test('guide continues offscreen and an uncertain or rejected steer never masquerades as an accepted send or replays', async () => {
  for (const outcome of ['applied', 'no-active-turn', 'lost-ack']) {
    let requests = 0;
    const fixture = await openTestSession({
      onRpc: () => {
        requests++;
        if (outcome === 'lost-ack') throw new Error('reply_stream_lost');
        return {
          result: { applied: outcome === 'applied', disposition: outcome },
        };
      },
    });
    try {
      fixture.server
        .getList('history')
        .push({ id: 'running', role: 'assistant', finished: false, items: [] });
      fixture.server.commit();
      await fixture.pushUpdate();
      const args = {
        sessionId: 's1',
        machineId: 'm1',
        userId: 'u1',
        text: 'guide',
        cliType: 'builtin',
        agentType: 'codex',
        guide: true,
      };
      fixture.runtime.closeSession();
      const result = await fixture.runtime.sendTurn(args);
      assert.equal(result.state, 'uploaded');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 1);
      const appends = fixture.appends.length;
      assert.equal(
        (await fixture.runtime.sendTurn({ ...args, id: result.id })).state,
        'unknown',
      );
      assert.equal(fixture.appends.length, appends);
    } finally {
      fixture.close();
    }
  }
});

test('chat failures retain raw diagnostics and update when only metadata changes', async () => {
  const { projectSession } = await loadRuntime();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'failure');
  entry.set('role', 'system');
  const item = entry
    .setContainer('items', new LoroList())
    .pushContainer(new LoroMap());
  item.set('type', 'system_notice');
  item.set('name', 'chat_failed');
  item.set('meta', { reason: 'acp_unknown_error', message: 'raw\nerror' });
  doc.commit();
  const before = projectSession(doc, 'live');
  assert.equal(before.entries[0].items[0].meta.message, 'raw\nerror');
  item.set('meta', {
    reason: 'future_reason',
    code: 'future_code',
    message: 'updated',
  });
  doc.commit();
  const after = projectSession(doc, 'live');
  assert.deepEqual(after.entries[0].items[0].meta, {
    reason: 'future_reason',
    code: 'future_code',
    message: 'updated',
  });
  assert.ok(after.entries[0].rev > before.entries[0].rev);
  assert.ok(after.entries[0].items[0].rev > before.entries[0].items[0].rev);
  item.set('meta', { message: 42 });
  doc.commit();
  assert.equal(
    projectSession(doc, 'live').entries[0].items[0].meta.message,
    undefined,
  );
});

test('multiple durable guides await independent receipts without locking the session or replaying', async () => {
  const receipts = new Map();
  const fixture = await openTestSession({
    onRpc: (request) =>
      new Promise((resolve) =>
        receipts.set(request.params.userTurnId, resolve),
      ),
  });
  try {
    fixture.server
      .getList('history')
      .push({ id: 'running', role: 'assistant', finished: false, items: [] });
    fixture.server.commit();
    await fixture.pushUpdate();
    const args = {
      sessionId: 's1',
      machineId: 'm1',
      userId: 'u1',
      text: 'guide',
      cliType: 'builtin',
      agentType: 'codex',
      guide: true,
    };
    const first = await fixture.runtime.sendTurn(args);
    const second = await fixture.runtime.sendTurn(args);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(first.state, 'uploaded');
    assert.equal(second.state, 'uploaded');
    assert.notEqual(first.id, second.id);
    assert.equal(receipts.size, 2);
    assert.equal(
      fixture.server
        .toJSON()
        .history.filter((entry) => entry.status === 'pending_apply').length,
      2,
    );
    receipts.get(second.id)({ result: { applied: true } });
    receipts.get(first.id)({ error: { message: 'lost_ack' } });
    await new Promise((resolve) => setImmediate(resolve));
    const history = fixture.server.toJSON().history;
    assert.equal(
      history.find((entry) => entry.id === second.id).status,
      'processing',
    );
    assert.equal(
      history.find((entry) => entry.id === first.id).status,
      'pending_apply',
    );
    assert.equal(
      (await fixture.runtime.sendTurn({ ...args, id: first.id })).state,
      'unknown',
    );
    const third = await fixture.runtime.sendTurn(args);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(third.state, 'uploaded');
    assert.equal(receipts.size, 3);
    receipts.get(third.id)({ result: { applied: true } });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    fixture.close();
  }
});

test('proposed documents preserve identity across streaming, completion and clearing', async () => {
  const { projectSession } = await loadProject();
  const doc = new LoroDoc();
  const entry = doc.getList('history').pushContainer(new LoroMap());
  entry.set('id', 'plan');
  entry.set('role', 'assistant');
  const items = entry.setContainer('items', new LoroList());
  const plan = items.pushContainer(new LoroMap());
  for (const [key, value] of Object.entries({
    type: 'proposed_plan',
    markdown: '# Plan',
    turnId: 'turn',
    status: 'delta',
    isLatest: true,
  }))
    plan.set(key, value);
  doc.commit();
  const first = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(first.markdown, '# Plan');
  plan.set('markdown', '# Plan\n\nComplete body');
  plan.set('status', 'completed');
  doc.commit();
  const complete = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(complete.itemId, first.itemId);
  assert.notEqual(complete.rev, first.rev);
  assert.equal(complete.markdown, '# Plan\n\nComplete body');
  assert.equal(complete.status, 'completed');
  plan.set('isLatest', false);
  doc.commit();
  const historical = projectSession(doc, 'live').entries[0].items[0];
  assert.equal(historical.isLatest, false);
  assert.notEqual(historical.rev, complete.rev);
  plan.set('status', 'cleared');
  doc.commit();
  assert.equal(
    projectSession(doc, 'live').entries[0].items[0].status,
    'cleared',
  );
});
