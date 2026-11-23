// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectSkillGroup } from '@lody/shared';

const state = vi.hoisted(() => ({
  control: vi.fn(),
  cache: new Map<string, unknown>(),
}));

vi.mock('../src/atoms', async () => {
  const { atom } = await import('jotai');
  return {
    userAtom: atom({ id: 'user-1' }),
    getAllAgentConfigAtom: atom([]),
    runtimeAtom: atom({
      requestLocalProjectControl: (request: unknown) => state.control(request),
    }),
  };
});
vi.mock('../src/lib/project-skills-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readProjectSkillsCacheEntry: async (key: string) => state.cache.get(key) ?? null,
  writeProjectSkillsCacheEntry: async (entry: { key: string }) => {
    state.cache.set(entry.key, entry);
  },
}));

import { useProjectSkills } from '../src/hooks/use-project-skills';
import { getLocalProjectSkillsCacheKey } from '../src/lib/project-skills-cache';
import { KNOWN_SKILL_DIRS_VERSION } from '@lody/shared';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const container = document.createElement('div');
const root = createRoot(container);
afterEach(async () => {
  await act(async () => root.render(null));
  state.control.mockReset();
  state.cache.clear();
});

const group = (
  scope: ProjectSkillGroup['scope'],
  dir: string,
  name: string
): ProjectSkillGroup => ({
  scope,
  dir,
  truncated: false,
  skills: [
    { id: `${dir}/${name}`, name, relativePath: `${dir}/${name}/SKILL.md`, isSymlink: false },
  ],
});

function Probe() {
  const skills = useProjectSkills({
    kind: 'local',
    workspaceId: 'ws',
    machineId: 'machine-1',
    localProjectId: 'lp-1',
  });
  return (
    <span>
      {skills.status}:{skills.rawGroups.map((g) => g.skills[0]?.name).join(',')}
    </span>
  );
}

it('sends the cached fingerprints and keeps the half the host reports unchanged', async () => {
  const key = getLocalProjectSkillsCacheKey('user-1', 'ws', 'machine-1', 'lp-1');
  state.cache.set(key, {
    key,
    source: 'local',
    groups: [
      group('project', '.agents/skills', 'Review'),
      group('global', '~/.claude/skills', 'Old'),
    ],
    contentFingerprint: 'project:P1|global:G1',
    knownDirsVersion: KNOWN_SKILL_DIRS_VERSION,
    fetchedAt: 1,
  });
  state.control.mockImplementation(async (request: { type: string }) =>
    request.type === 'local-project/list-skills'
      ? {
          ok: true,
          type: request.type,
          result: { groups: [], contentFingerprint: 'P1', unchanged: true },
        }
      : {
          ok: true,
          type: request.type,
          result: {
            groups: [group('global', '~/.claude/skills', 'Deploy')],
            contentFingerprint: 'G2',
          },
        }
  );

  await act(async () => root.render(<Probe />));
  await act(async () => {});

  expect(state.control.mock.calls.map(([request]) => request.knownFingerprint)).toEqual([
    'P1',
    'G1',
  ]);
  expect(container.textContent).toBe('ready:Review,Deploy');
  expect(state.cache.get(key)).toMatchObject({ contentFingerprint: 'project:P1|global:G2' });
});
