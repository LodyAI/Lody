import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Flock } from '@loro-dev/flock-wasm/base64';
import { LoroDoc } from 'loro-crdt/base64';
const bundle = await build({
  stdin: {
    contents: `export * from './packages/cloud-runtime/src/runtime/prompt-shortcuts.ts'; export * from './packages/cloud-runtime/src/protocol/prompt-shortcuts/compiler.ts'; export * from './packages/cloud-runtime/src/protocol/prompt-shortcuts/document.ts';`,
    resolveDir: new URL('../../../../', import.meta.url).pathname,
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
            'export class StreamsClient {constructor(args){return new globalThis.__shortcutClient(args)}}',
        }));
      },
    },
  ],
});
const {
  promptShortcuts,
  shortcutAccess,
  expandShortcuts,
  parsePromptShortcut,
  PromptShortcutDocument,
} = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const value = {
  v: 1,
  id: 'review',
  workspaceId: 'w',
  ownerUserId: 'owner',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Review $literal /review',
  scope: {},
  mentions: [],
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
const entry = (() => {
  const { prompt, mentions, ...rest } = value;
  return { ...rest, bodyDocId: 'body', dependencySummary: [] };
})();

test('validates byte limits, UTF-16 mention ranges and immutable coherent revisions', () => {
  assert.throws(() =>
    parsePromptShortcut({ ...value, prompt: '中'.repeat(90000) }),
  );
  assert.throws(
    () =>
      parsePromptShortcut({
        ...value,
        prompt: '😀',
        mentions: [
          {
            start: 1,
            end: 2,
            label: 'x',
            target: { kind: 'agent_role', agentRoleId: 'role' },
          },
        ],
      }),
    /Ranges/,
  );
  const doc = new PromptShortcutDocument(new LoroDoc());
  doc.save(value, []);
  assert.equal(doc.read().prompt, value.prompt);
  assert.throws(
    () => doc.save({ ...value, prompt: 'Changed' }, []),
    /revision id/,
  );
  doc.save({ ...value, revision: 'r2', prompt: 'Next' }, ['r1']);
  assert.throws(
    () => doc.save({ ...value, revision: 'r3' }, ['r1']),
    /changed/,
  );
  assert.equal(doc.read().prompt, 'Next');
});
test('slash expansion reads fresh bodies once and never interprets inserted text', async () => {
  const result = await expandShortcuts(
    'Before /shortcut:review after',
    async () => [entry],
    async () => value,
    async (text) => text.replace('$literal', 'BAD'),
  );
  assert.equal(result, 'Before Review $literal /review after');
  await assert.rejects(
    expandShortcuts(
      '/shortcut:review',
      async () => [entry, { ...entry, id: 'other' }],
      async () => value,
    ),
    /unavailable/,
  );
  await assert.rejects(
    expandShortcuts(
      '/shortcut:review',
      async () => [entry],
      async () => {
        throw new Error('revoked');
      },
    ),
    /shortcut_unavailable/,
  );
  await assert.rejects(
    expandShortcuts(
      '/shortcut:review',
      async () => [],
      async () => {
        throw new Error('must not read');
      },
    ),
    /unavailable/,
  );
  assert.equal(
    await expandShortcuts(
      '/help',
      async () => {
        throw new Error('unreachable');
      },
      async () => value,
    ),
    '/help',
  );
  await assert.rejects(
    expandShortcuts(
      '/shortcut:review',
      async () => [{ ...entry, scope: { machineId: 'm' } }],
      async () => value,
    ),
    /unavailable/,
  );
});
test('publication readback, owner fences, revoked access and explicit repair after lost index acknowledgement', async () => {
  const streams = new Map();
  let directory = [],
    writes = 0,
    failIndex = false;
  globalThis.__shortcutClient = class {
    constructor({ url }) {
      this.id = decodeURIComponent(url.split('/').at(-1));
    }
    async create() {
      if (!streams.has(this.id)) streams.set(this.id, { updates: [] });
      return { ok: true, result: {} };
    }
    async bootstrap() {
      const data = streams.get(this.id);
      if (!data) return { ok: false, result: { code: 'not_found' } };
      return {
        ok: true,
        result: {
          snapshotOffset: '-1',
          updates: data.updates.map((body) => ({ body })),
          nextOffset: '1',
          upToDate: true,
        },
      };
    }
    async append({ part }) {
      writes++;
      streams.get(this.id).updates.push(part.body);
      if (failIndex && this.id.startsWith('shortcut-index')) {
        failIndex = false;
        return { ok: false, result: { code: 'network' } };
      }
      return { ok: true, result: {} };
    }
  };
  const calls = [];
  const cloud = async (op, args) => {
    calls.push({ op, args });
    if (op === 'listAccessibleDocuments') return directory;
    if (op === 'getStreamToken') {
      const t = args.target;
      return {
        token: 'fixture-only',
        expiresIn: 60,
        gatewayBaseUrl: 'https://example.com',
        streamId:
          t.kind === 'body'
            ? `shortcut-body:${t.bodyDocId}`
            : `shortcut-index:w:${t.ownerUserId}:${t.visibility}`,
      };
    }
    if (op === 'stageDocument')
      return { bodyDocId: args.bodyDocId, status: 'staged' };
    if (op === 'activateDocument') {
      assert.equal(args.previousRevision, directory[0]?.revision ?? null);
      directory = [
        {
          shortcutId: 'review',
          bodyDocId: args.bodyDocId,
          ownerUserId: 'owner',
          visibility: 'private',
          revision: args.revision,
        },
      ];
      return null;
    }
    throw new Error(op);
  };
  const req = {
    workspaceId: 'w',
    action: 'save',
    entry: null,
    value,
    bodyDocId: 'body',
  };
  failIndex = true;
  await assert.rejects(
    promptShortcuts(req, 'owner', cloud, AbortSignal.timeout(5000)),
    /unknown/,
  );
  const previous = writes;
  const saved = await promptShortcuts(
    req,
    'owner',
    cloud,
    AbortSignal.timeout(5000),
  );
  assert.equal(writes, previous + 1, 'explicit retry repairs only the index');
  assert.equal(
    calls.filter((call) => call.op === 'activateDocument').length,
    1,
  );
  const access = shortcutAccess('w', 'owner', cloud, AbortSignal.timeout(5000));
  assert.equal((await access.list()).length, 1);
  assert.equal((await access.read(saved)).prompt, value.prompt);
  await assert.rejects(
    promptShortcuts(
      { ...req, value: { ...value, ownerUserId: 'another' } },
      'owner',
      cloud,
      AbortSignal.timeout(5000),
    ),
    /invalid/,
  );
  const edited = await promptShortcuts(
    {
      ...req,
      entry: saved,
      bodyDocId: 'body-next',
      value: {
        ...value,
        revision: 'r2',
        prompt: 'Updated review',
        updatedAt: 2,
      },
    },
    'owner',
    cloud,
    AbortSignal.timeout(5000),
  );
  assert.equal((await access.read(edited)).prompt, 'Updated review');
  await assert.rejects(access.read(saved), /changed/);
  directory = [];
  await assert.rejects(access.read(saved), /changed/);
  const mismatch = shortcutAccess(
    'w',
    'owner',
    async () => ({
      token: 'fixture',
      expiresIn: 60,
      gatewayBaseUrl: 'https://example.com',
      streamId: 'wrong',
    }),
    AbortSignal.timeout(5000),
  );
  await assert.rejects(
    mismatch.grant(
      'shortcut-body:body',
      { kind: 'body', bodyDocId: 'body' },
      false,
    )(),
  );
});
