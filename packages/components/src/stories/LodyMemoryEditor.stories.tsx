import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useState } from 'react';
import { createStore, Provider } from 'jotai';
import type { StorageAdapter } from 'loro-repo';
import { MEMORY_ENTRY_PATH, type MemoryMutationContext } from '@lody/memory';
import { createPersonalMemoryRepository } from '@lody/memory/repo';
import type { SessionMeta } from '@lody/shared';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { sessionMetaCacheAtom } from '@/atoms/doc-meta';
import { LodyMemoryEditor } from '@/components/settings/lody-memory-dialogs';

// Session-only storage: the story exercises the real repository, not persistence.
const storage: StorageAdapter = {
  save: async () => {},
  loadDoc: async () => undefined,
  loadMeta: async () => undefined,
};
const at = (minutes: number) => Date.UTC(2026, 9, 28, 9, 0) + minutes * 60_000;
const user = (id: string, minutes: number): MemoryMutationContext => ({
  changeId: id,
  recordedAt: at(minutes),
  source: { actor: 'user' },
});
const agent = (id: string, minutes: number): MemoryMutationContext => ({
  changeId: id,
  recordedAt: at(minutes),
  source: { actor: 'agent', turn: { sessionId: 'session-review', turnId: 'turn-1' } },
});

async function seed() {
  const repo = await createPersonalMemoryRepository({ ownerId: 'alice', storage });
  await repo.create('work', { name: 'Work', description: 'Team conventions' }, user('c0', 0));
  const handle = await repo.open('work', user('open', 0));
  const { memory } = handle;
  const entry = (rest: string) => `---\nname: Work\ndescription: Team conventions\n---\n\n${rest}`;
  memory.update({ path: MEMORY_ENTRY_PATH, body: entry('- Prefer small PRs.') }, user('u1', 3));
  memory.update(
    { path: MEMORY_ENTRY_PATH, body: entry('- Prefer small PRs.\n- See [[review]].') },
    user('u2', 4)
  );
  memory.create(
    { path: 'review.md', description: 'Review habits', body: '# Review\n\n- Run tests first.' },
    agent('a1', 30)
  );
  memory.update(
    {
      path: 'review.md',
      body: '# Review\n\n- Run tests first.\n- Ask for screenshots on UI changes.\n- Keep comments to P0/P1.',
    },
    agent('a2', 42)
  );
  memory.update(
    {
      path: 'review.md',
      body: '# Review\n\n- Run `pnpm check` first.\n- Ask for screenshots on UI changes.\n- Keep comments to P0/P1.',
    },
    user('u3', 60)
  );
  await handle.release();
  const context = () => user(crypto.randomUUID(), 90);
  const store = createStore();
  store.set(currentWorkspaceSlugAtom, 'demo');
  store.set(sessionMetaCacheAtom, {
    'session-review': { id: 'session-review', title: 'Review PR #2063' } as SessionMeta,
  });
  store.set(runtimeAtom, {
    workspaceSlug: 'demo',
    personalMemory: {
      openCatalog: () => repo.openCatalog(),
      open: (memoryId: string) => repo.open(memoryId, context()),
      create: (profile: { name: string; description?: string }) =>
        repo.create(crypto.randomUUID(), profile, context()),
      remove: (memoryId: string) => repo.remove(memoryId),
    },
  } as unknown as WorkspaceRuntime);
  return store;
}

function Seeded() {
  const [store, setStore] = useState<ReturnType<typeof createStore>>();
  useEffect(() => {
    void seed().then(setStore);
  }, []);
  return store ? (
    <Provider store={store}>
      <LodyMemoryEditor memoryId="work" onClose={() => {}} />
    </Provider>
  ) : null;
}

const meta = {
  title: 'Settings/LodyMemoryEditor',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** Open a topic, then the corner History button for its changes and diff. */
export const WithHistory: Story = { render: () => <Seeded /> };
