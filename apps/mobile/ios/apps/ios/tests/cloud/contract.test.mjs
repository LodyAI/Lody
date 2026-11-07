import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { mock } from 'node:test';
import { Envelope } from '../../../../packages/cloud-runtime/src/contract/envelope.ts';
import {
  hostCalls,
  runtimeCalls,
  runtimeEvents,
} from '../../../../packages/cloud-runtime/src/contract/methods.ts';
import {
  ContractError,
  createChannel,
} from '../../../../packages/cloud-runtime/src/runtime/channel.ts';

const fixtures = async (name) =>
  JSON.parse(
    await readFile(
      new URL(
        `../../../../packages/cloud-runtime/contract/fixtures/${name}.json`,
        import.meta.url,
      ),
    ),
  );

function payloadSchema(direction, message) {
  const calls = { request: 'params', result: 'result' };
  if (message.kind === 'event') return runtimeEvents[message.method];
  if (message.kind === 'error') return undefined;
  const table =
    (direction === 'to-runtime') === (message.kind === 'request')
      ? runtimeCalls
      : hostCalls;
  return table[message.method]?.[calls[message.kind]];
}

function harness(ids = []) {
  const posts = [];
  const channel = createChannel((text) => posts.push(JSON.parse(text)), {
    id: () => ids.shift() ?? crypto.randomUUID(),
  });
  return { posts, channel };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('golden envelopes satisfy the contract schemas in both directions', async () => {
  for (const direction of ['to-runtime', 'to-host'])
    for (const message of await fixtures(direction)) {
      assert.ok(Envelope.safeParse(message).success, JSON.stringify(message));
      const schema = payloadSchema(direction, message);
      if (message.kind !== 'error') {
        assert.ok(schema, `${direction} ${message.kind} ${message.method}`);
        assert.ok(schema.safeParse(message.payload).success, message.method);
      }
    }
});

test('runtime channel answers host requests with the golden envelopes', async () => {
  const toRuntime = await fixtures('to-runtime');
  const toHost = await fixtures('to-host');
  const { posts, channel } = harness(['req-grant']);
  let ready = true;
  channel.handle('ensureSession', () => {
    if (!ready) throw new Error('session_not_ready');
    return {};
  });

  channel.receive(JSON.stringify(toRuntime[0]));
  await settle();
  assert.equal(channel.gen, 3);
  assert.deepEqual(posts.shift(), toHost[0]);

  channel.receive(JSON.stringify(toRuntime[1]));
  await settle();
  assert.deepEqual(posts.shift(), toHost[1]);

  ready = false;
  channel.receive(JSON.stringify(toRuntime[1]));
  await settle();
  assert.deepEqual(posts.shift(), toHost[2]);

  const grant = channel.request('grant', {});
  assert.deepEqual(posts.shift(), toHost[3]);
  channel.receive(JSON.stringify(toRuntime[2]));
  assert.deepEqual(await grant, toRuntime[2].payload);

  for (const event of toHost.filter((m) => m.kind === 'event')) {
    channel.emit(event.method, event.payload);
    assert.deepEqual(posts.shift(), event);
  }
});

test('host errors reject reverse requests with the host code', async () => {
  const toRuntime = await fixtures('to-runtime');
  const { channel } = harness(['req-grant']);
  channel.receive(JSON.stringify(toRuntime[0]));
  await settle();
  const grant = channel.request('grant', {});
  channel.receive(JSON.stringify(toRuntime[3]));
  await assert.rejects(grant, (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, 'grant_failed');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('runtime channel rejects malformed, unknown and stale requests', async () => {
  const toRuntime = await fixtures('to-runtime');
  const { posts, channel } = harness();
  channel.receive(JSON.stringify(toRuntime[0]));
  await settle();
  posts.length = 0;
  let calls = 0;
  channel.handle('ensureSession', () => {
    calls += 1;
    return {};
  });

  channel.receive(
    JSON.stringify({ ...toRuntime[1], id: 'bad', payload: { sessionId: '' } }),
  );
  channel.receive(
    JSON.stringify({ ...toRuntime[1], id: 'new', method: 'futureMethod' }),
  );
  channel.receive(JSON.stringify({ ...toRuntime[1], id: 'old', gen: 2 }));
  channel.receive(JSON.stringify({ kind: 'request', id: 'broken', v: 1 }));
  channel.receive('not json');
  await settle();

  assert.equal(calls, 0);
  assert.deepEqual(
    posts.map((post) => [post.id, post.error.code]),
    [
      ['bad', 'invalid_params'],
      ['new', 'unsupported_method'],
      ['broken', 'invalid_envelope'],
    ],
  );
});

test('handler results that break the contract are reported, not sent', async () => {
  const toRuntime = await fixtures('to-runtime');
  const { posts, channel } = harness();
  channel.handle('hello', () => ({ protocol: 1 }));
  channel.receive(JSON.stringify(toRuntime[0]));
  await settle();
  assert.equal(posts[0].kind, 'error');
  assert.equal(posts[0].error.code, 'invalid_result');
});

test('a protocol mismatch answers with the new generation so the host sees it', async () => {
  const toRuntime = await fixtures('to-runtime');
  const { posts, channel } = harness();
  channel.receive(
    JSON.stringify({ ...toRuntime[0], payload: { protocol: 2, gen: 3 } }),
  );
  await settle();
  assert.deepEqual(
    [posts[0].gen, posts[0].kind, posts[0].error.code],
    [3, 'error', 'protocol_mismatch'],
  );
});

test('reverse requests time out and ignore late replies', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const toRuntime = await fixtures('to-runtime');
  const { channel } = harness(['req-grant']);
  const grant = channel.request('grant', {});
  mock.timers.tick(hostCalls.grant.timeoutMs);
  await assert.rejects(grant, (error) => error.code === 'timeout');
  channel.receive(JSON.stringify({ ...toRuntime[2], gen: 0 }));
});

test('a hello from another protocol version fails fast with the caller generation', async () => {
  const toRuntime = await fixtures('to-runtime');
  const { posts, channel } = harness();
  channel.receive(JSON.stringify({ ...toRuntime[0], v: 2, gen: 7 }));
  channel.receive(
    JSON.stringify({ ...toRuntime[0], id: 'bad-hello', payload: { gen: 8 } }),
  );
  await settle();
  assert.deepEqual(
    posts.map((post) => [post.id, post.gen, post.v, post.error.code]),
    [
      ['req-hello', 7, 1, 'protocol_mismatch'],
      ['bad-hello', 3, 1, 'invalid_params'],
    ],
  );
  assert.equal(channel.gen, 0);
});

test('a failed host call inside a handler is reported as upstream, not as its own code', async () => {
  const toRuntime = await fixtures('to-runtime');
  const { posts, channel } = harness(['req-grant']);
  channel.receive(JSON.stringify(toRuntime[0]));
  await settle();
  posts.length = 0;
  channel.handle('ensureSession', async () => {
    await channel.request('grant', {});
    return {};
  });
  channel.receive(JSON.stringify(toRuntime[1]));
  await settle();
  channel.receive(JSON.stringify(toRuntime[3]));
  await settle();
  assert.deepEqual(posts.at(-1).error, {
    code: 'host_call_failed',
    retryable: true,
    detail: 'grant: grant_failed',
  });
});

test('the generator refuses shapes it cannot represent faithfully', async () => {
  const { emitSwift } =
    await import('../../../../packages/cloud-runtime/scripts/contract-swift.mjs');
  const contract = (types) => ({
    protocol: 1,
    runtimeCalls: {},
    hostCalls: {},
    events: {},
    types,
  });
  assert.throws(
    () =>
      emitSwift(
        contract({
          Patch: {
            type: 'object',
            properties: {
              title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
          },
        }),
      ),
    /optional and nullable/,
  );
  assert.throws(
    () =>
      emitSwift(
        contract({
          Either: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        }),
      ),
    /discriminator/,
  );
});

test('keys a handler returns but the contract does not declare are reported', async () => {
  const toRuntime = await fixtures('to-runtime');
  const reports = [];
  const posts = [];
  const channel = createChannel((text) => posts.push(JSON.parse(text)), {
    onDroppedKeys: (method, paths) => reports.push([method, paths]),
  });
  channel.receive(JSON.stringify(toRuntime[0]));
  await settle();
  channel.handle('ensureSession', () => ({ stale: true, nested: undefined }));
  channel.receive(JSON.stringify(toRuntime[1]));
  await settle();
  assert.deepEqual(reports, [['ensureSession', ['.stale']]]);
  assert.deepEqual(posts.at(-1).payload, {});
});
