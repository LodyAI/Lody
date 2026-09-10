import { expect, it, vi } from 'vitest';
import { createShortcutInvocation, type PromptShortcut } from '@lody/shared/prompt-shortcuts';
import {
  captureShortcutDraft,
  parseShortcutDraft,
  shortcutDraftMentions,
  ShortcutDraftRepository,
  type ShortcutDraftRecord,
} from '../src/lib/shortcut-composer-draft';
const identity = { userId: 'user', workspaceId: 'ws', composerId: 'session' };
const body: PromptShortcut = {
  v: 1,
  id: 'review',
  workspaceId: 'ws',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: '!{topic}',
  mentions: [],
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
function fixture() {
  const invocation = createShortcutInvocation('invocation', body);
  return captureShortcutDraft('Before /review @file', [
    { start: 7, end: 14, value: invocation.id, kind: 'prompt_shortcut', data: invocation },
    { start: 15, end: 20, value: 'file', kind: 'file' },
  ])!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('round-trips one text/range/snapshot checkpoint without putting incomplete chips in normal ranges', () => {
  const record = fixture();
  expect(record.mentions).toEqual([{ start: 15, end: 20, value: 'file', kind: 'file' }]);
  const restored = parseShortcutDraft(JSON.parse(JSON.stringify(record)), identity)!;
  expect(restored).toEqual(record);
  expect(shortcutDraftMentions(restored)[0]?.data).toEqual(record.invocations[0]?.data);
  expect(parseShortcutDraft({ ...record, text: 'Other /changed' }, identity)).toBeNull();
  expect(parseShortcutDraft(record, { ...identity, workspaceId: 'another' })).toBeNull();
  expect(captureShortcutDraft('', shortcutDraftMentions(record))).toBeNull();
});
it('isolates account, workspace and composer and wins against a late durable read', async () => {
  const reading = deferred<unknown>();
  const store = { read: vi.fn(() => reading.promise), write: vi.fn(async () => {}) };
  const repo = new ShortcutDraftRepository(store);
  const stale = repo.read(identity);
  await repo.write(identity, null);
  reading.resolve(fixture());
  expect(await stale).toBeNull();
  expect(await repo.read(identity)).toBeNull();
  await repo.read({ ...identity, userId: 'other' });
  await repo.read({ ...identity, workspaceId: 'other' });
  await repo.read({ ...identity, composerId: 'other' });
  expect(store.read).toHaveBeenCalledTimes(4);
});
it('serializes durable writes and exposes the clear synchronously before a promoted composer reads', async () => {
  const firstWrite = deferred<void>();
  const started = deferred<void>();
  const writes: Array<ShortcutDraftRecord | null> = [];
  const repo = new ShortcutDraftRepository({
    read: async () => null,
    write: async (_identity, record) => {
      writes.push(record);
      if (writes.length === 1) {
        started.resolve();
        await firstWrite.promise;
      }
    },
  });
  const first = repo.write(identity, fixture());
  const clear = repo.write(identity, null);
  expect(await repo.read(identity)).toBeNull();
  await started.promise;
  expect(writes).toHaveLength(1);
  firstWrite.resolve();
  await Promise.all([first, clear]);
  expect(writes).toEqual([fixture(), null]);
});

it('retires only the captured checkpoint version, including identical-text replacements', async () => {
  let durable: ShortcutDraftRecord | null = null;
  const repo = new ShortcutDraftRepository({
    read: async () => durable,
    write: async (_identity, record) => {
      durable = record;
    },
  });
  const submitted = fixture();
  await repo.write(identity, submitted);
  const version = repo.captureVersion(identity, fixture())!;
  expect(version).toBe(submitted);
  const replacement = fixture();
  await repo.write(identity, replacement);
  expect(repo.clearIfUnchanged(identity, version)).toBeNull();
  expect(await repo.read(identity)).toBe(replacement);
  expect(durable).toBe(replacement);
  const currentVersion = repo.captureVersion(identity, replacement)!;
  const clearing = repo.clearIfUnchanged(identity, currentVersion);
  expect(clearing).not.toBeNull();
  expect(await repo.read(identity)).toBeNull();
  await clearing;
  expect(durable).toBeNull();
});
