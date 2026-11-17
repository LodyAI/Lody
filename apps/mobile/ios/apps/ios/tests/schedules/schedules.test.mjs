import test from 'node:test';
import assert from 'node:assert/strict';
import { LoroDoc, LoroMap } from 'loro-crdt/base64';
import { grant, loadSchedules } from './harness.mjs';

const runtime = await loadSchedules();
const {
  scheduleStreams,
  scheduleRepository,
  scheduleDefinitionFingerprint,
  draftInput,
  ruleOf,
  triggerOf,
} = runtime;

const WS = 'w1';
const OWNER = 'user-1';

function fresh() {
  globalThis.__scheduleStreams = new Map();
  const streams = scheduleStreams(WS, grant, new AbortController().signal);
  return { streams, repository: scheduleRepository(streams) };
}

const draft = (overrides = {}) => ({
  title: 'Nightly review',
  prompt: 'Review open PRs',
  machineId: 'm1',
  agentConfigId: 'codex',
  modelId: 'gpt',
  destination: 'new_session',
  project: { kind: 'local', localProjectId: 'p1', useWorktree: true },
  rule: { kind: 'daily', hour: 9, minute: 30, timeZone: 'Asia/Shanghai' },
  ...overrides,
});

async function create(repository, id = 's1', input = draft(), now = 1000) {
  return repository.save({
    scheduleId: id,
    draft: draftInput(input, undefined, 'UTC', now),
    actorId: OWNER,
    now,
    activationId: 'act-1',
    activityId: `${id}-created`,
    create: true,
  });
}

test('a created schedule publishes its document first and a registry row that matches it', async () => {
  const { streams, repository } = fresh();
  await create(repository);
  const { rows } = await streams.list();
  assert.equal(rows.length, 1);
  const [row] = rows;
  const { document } = await streams.read('s1');
  assert.equal(document.prompt, 'Review open PRs');
  assert.deepEqual(document.definition.trigger, {
    kind: 'cron',
    expression: '30 9 * * *',
    timeZone: 'Asia/Shanghai',
  });
  assert.deepEqual(document.definition.misfirePolicy, { kind: 'run_once' });
  assert.equal(document.definition.overlapPolicy, 'queue_one');
  assert.deepEqual(document.definition.project, {
    kind: 'local',
    localProjectId: 'p1',
    useWorktree: true,
  });
  assert.equal(
    row.definitionFingerprint,
    await scheduleDefinitionFingerprint(document),
  );
  assert.equal(row.projectKey, 'p1');
  assert.equal(row.enabled, true);
  // The document stream is written before the registry row.
  const order = [...globalThis.__scheduleStreams.keys()];
  assert.ok(order.indexOf(`${WS}:schedule:s1`) < order.indexOf(`${WS}:sr`));
});

test('saving an untouched rule keeps the stored trigger verbatim', async () => {
  const { streams, repository } = fresh();
  await repository.save({
    scheduleId: 's1',
    draft: {
      ...draftInput(draft(), undefined, 'UTC', 1000),
      trigger: { kind: 'cron', expression: '0 9 * * MON-FRI', timeZone: 'UTC' },
    },
    actorId: OWNER,
    now: 1000,
    activationId: 'act-1',
    activityId: 'created',
    create: true,
  });
  const before = (await streams.read('s1')).document;
  const rule = ruleOf(before.definition.trigger);
  assert.equal(rule.kind, 'weekdays');
  const input = draftInput(
    draft({ title: 'Renamed', rule }),
    before,
    'UTC',
    2000,
  );
  assert.deepEqual(input.trigger, before.definition.trigger);
  // A changed time is re-authored as cron in the machine's rule zone.
  const moved = draftInput(
    draft({ rule: { ...rule, hour: 10 } }),
    before,
    'UTC',
    2000,
  );
  assert.equal(moved.trigger.expression, '0 10 * * 1-5');
});

test('an unsupported stored rule can only be kept, never rewritten', () => {
  const stored = { kind: 'cron', expression: '*/7 3 * * *', timeZone: 'UTC' };
  const rule = ruleOf(stored);
  assert.equal(rule.kind, 'unsupported');
  assert.deepEqual(triggerOf(rule, 'UTC', 0, stored), stored);
  assert.throws(
    () => triggerOf(rule, 'UTC', 0, undefined),
    /schedule_trigger_invalid/,
  );
  assert.deepEqual(triggerOf({ kind: 'manual' }, 'UTC', 0, stored), {
    kind: 'manual',
  });
  assert.throws(
    () =>
      triggerOf({ kind: 'weekly', weekdays: [], hour: 9, minute: 0 }, 'UTC', 0),
    /schedule_trigger_invalid/,
  );
});

test('an edit keeps what mobile cannot edit and changes what it can', async () => {
  const { streams, repository } = fresh();
  const created = await create(repository);
  // Agent options and memory come from web; mobile never drops them for the same Agent.
  created.definition.agent = {
    ...created.definition.agent,
    configOptionValues: { reasoning: 'high', fast: true },
    memory: { providerId: 'mem', memoryId: 'notes' },
  };
  created.definition.destination = { kind: 'own_session', epoch: 3 };
  created.definition.project = undefined;
  await streams.write(created, false);
  const previous = (await streams.read('s1')).document;
  const same = draftInput(
    draft({ destination: 'own_session' }),
    previous,
    'UTC',
    5000,
  );
  assert.deepEqual(same.agent.configOptionValues, {
    reasoning: 'high',
    fast: true,
  });
  assert.deepEqual(same.destination, { kind: 'own_session', epoch: 3 });
  assert.equal(same.project, undefined, 'an owned chat carries no project');
  const other = draftInput(
    draft({ agentConfigId: 'claude' }),
    previous,
    'UTC',
    5000,
  );
  assert.equal(other.agent.configOptionValues, undefined);
  assert.equal(other.agent.memory, undefined);

  await repository.save({
    scheduleId: 's1',
    draft: same,
    actorId: OWNER,
    now: 5000,
    activationId: 'act-2',
    activityId: 'edit-1',
    create: false,
  });
  const edited = (await streams.read('s1')).document;
  assert.equal(edited.definition.createdAt, 1000);
  assert.equal(edited.definition.updatedAt, 5000);
  assert.deepEqual(
    edited.timeline.map((entry) => entry.kind),
    ['created', 'edited'],
  );
  const [row] = (await streams.list()).rows;
  assert.equal(
    row.definitionFingerprint,
    await scheduleDefinitionFingerprint(edited),
  );
});

test('a retried request replays only the same intent', async () => {
  const { streams, repository } = fresh();
  await create(repository);
  const previous = (await streams.read('s1')).document;
  const args = {
    scheduleId: 's1',
    draft: draftInput(draft({ title: 'Second' }), previous, 'UTC', 2000),
    actorId: OWNER,
    now: 2000,
    activationId: 'act-2',
    activityId: 'edit-1',
    create: false,
  };
  await repository.save(args);
  await repository.save({ ...args, now: 3000, activationId: 'act-3' });
  assert.equal((await streams.read('s1')).document.timeline.length, 2);
  await assert.rejects(
    repository.save({
      ...args,
      draft: draftInput(draft({ title: 'Third' }), previous, 'UTC', 2000),
    }),
    /schedule_conflict/,
  );
  await assert.rejects(create(repository), /schedule_conflict/);
});

test('pause, resume, run and delete are owner-only and delete always wins', async () => {
  const { streams, repository } = fresh();
  await create(repository);
  await assert.rejects(
    repository.setEnabled({
      scheduleId: 's1',
      enabled: false,
      actorId: 'someone-else',
      now: 2000,
      activationId: 'a',
      requestId: 'r1',
    }),
    /schedule_not_owner/,
  );
  await repository.setEnabled({
    scheduleId: 's1',
    enabled: false,
    actorId: OWNER,
    now: 2000,
    activationId: 'a',
    requestId: 'pause-1',
  });
  let [row] = (await streams.list()).rows;
  assert.equal(row.enabled, false);
  await repository.setEnabled({
    scheduleId: 's1',
    enabled: true,
    actorId: OWNER,
    now: 3000,
    activationId: 'act-resume',
    requestId: 'resume-1',
  });
  [row] = (await streams.list()).rows;
  assert.equal(row.enabled, true);
  assert.equal(row.activationId, 'act-resume');
  assert.equal(row.activeFrom, 3000);

  await repository.requestRun({
    scheduleId: 's1',
    actorId: OWNER,
    manualRunId: 'run-1',
    now: 4000,
  });
  await repository.requestRun({
    scheduleId: 's1',
    actorId: OWNER,
    manualRunId: 'run-1',
    now: 4500,
  });
  const { flock } = await streams.registry(false);
  assert.deepEqual(flock.get(['manual', 's1', 'run-1']), {
    scheduleId: 's1',
    actorId: OWNER,
    manualRunId: 'run-1',
    activationId: 'act-resume',
    requestedAt: 4000,
  });

  await assert.rejects(
    repository.remove('s1', 'someone-else', 5000),
    /schedule_not_owner/,
  );
  await repository.remove('s1', OWNER, 5000);
  assert.deepEqual((await streams.list()).rows, []);
  await assert.rejects(
    repository.setEnabled({
      scheduleId: 's1',
      enabled: false,
      actorId: OWNER,
      now: 6000,
      activationId: 'a',
      requestId: 'pause-2',
    }),
    /schedule_not_found/,
  );
});

test('a scheduled message is shown but never rewritten from mobile', async () => {
  const { streams, repository } = fresh();
  await create(repository, 'msg');
  // Turn the stored document into a web-authored scheduled message.
  const key = `${WS}:schedule:msg`;
  const doc = new LoroDoc();
  for (const part of globalThis.__scheduleStreams.get(key)) {
    const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
    let offset = 0;
    while (offset < part.byteLength) {
      const size = view.getUint32(offset, false);
      doc.import(part.subarray(offset + 4, offset + 4 + size));
      offset += 4 + size;
    }
  }
  const before = doc.version();
  doc
    .getMap('message')
    .setContainer('payload', new LoroMap())
    .set('inputBlocks', []);
  doc.commit();
  const update = doc.export({ mode: 'update', from: before });
  const framed = new Uint8Array(update.length + 4);
  new DataView(framed.buffer).setUint32(0, update.length, false);
  framed.set(update, 4);
  globalThis.__scheduleStreams.get(key).push(framed);

  const read = await streams.read('msg');
  assert.equal(read.message, true);
  assert.equal(read.text, 'Review open PRs');
  await assert.rejects(
    repository.setEnabled({
      scheduleId: 'msg',
      enabled: false,
      actorId: OWNER,
      now: 2000,
      activationId: 'a',
      requestId: 'r',
    }),
    /schedule_message_read_only/,
  );
  await repository.remove('msg', OWNER, 3000);
  assert.deepEqual((await streams.list()).rows, []);
});
