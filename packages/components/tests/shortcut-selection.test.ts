import { expect, it, vi } from 'vitest';
import { projectShortcutIndex, type PromptShortcut } from '@lody/shared/prompt-shortcuts';
import {
  prepareShortcutSelection,
  type ShortcutSelectionRuntime,
} from '../src/components/mentions/shortcut-selection';
const body: PromptShortcut = {
  v: 1,
  id: 'shortcut',
  workspaceId: 'ws',
  ownerUserId: 'user',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Review !{topic}',
  mentions: [],
  scope: {},
  revision: 'r1',
  createdAt: 1,
  updatedAt: 1,
};
function fixture() {
  const entry = projectShortcutIndex(body, 'body');
  const entries = [entry];
  let resolve!: (body: PromptShortcut) => void;
  const read = vi.fn(
    () =>
      new Promise<PromptShortcut>((done) => {
        resolve = done;
      })
  );
  const runtime: ShortcutSelectionRuntime = {
    workspaceId: 'ws',
    userId: 'user',
    read,
    getSnapshot: () => ({ entries, pendingIds: [], errors: {}, loading: false }),
  };
  const controller = new AbortController();
  const input = {
    runtime,
    entry,
    context: { workspaceId: 'ws', userId: 'user', scope: {} },
    request: { signal: controller.signal, generation: 1, text: '/review', start: 0, end: 7 },
    isCurrent: () => true,
    createId: () => 'invocation',
  };
  return { input, entries, read, controller, resolve: (value: PromptShortcut) => resolve(value) };
}
it('freezes one coherent body only after the authorized read', async () => {
  const f = fixture();
  const pending = prepareShortcutSelection(f.input);
  f.resolve(body);
  expect(await pending).toEqual({
    value: 'invocation',
    text: '/review',
    kind: 'prompt_shortcut',
    data: { id: 'invocation', snapshot: body },
  });
});
it('rejects an index update or a mismatching body instead of mixing revisions', async () => {
  const f = fixture();
  const pending = prepareShortcutSelection(f.input);
  f.entries[0] = { ...f.input.entry, revision: 'r2' };
  f.resolve(body);
  await expect(pending).rejects.toMatchObject({ code: 'revision_pending' });
  const g = fixture();
  const other = prepareShortcutSelection(g.input);
  g.resolve({ ...body, revision: 'r2' });
  await expect(other).rejects.toMatchObject({ code: 'revision_pending' });
});
it('drops a late read after cancellation without committing a snapshot', async () => {
  const f = fixture();
  const pending = prepareShortcutSelection(f.input);
  f.controller.abort();
  f.resolve(body);
  expect(await pending).toBeNull();
});
