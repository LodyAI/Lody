// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceProject } from '@lody/shared';

import { projectEditorRequestAtom } from '../src/atoms/project-editor';
import type { ProjectGroupEditorState } from '../src/components/settings/project-group-editor-dialog';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const existing = { id: 'existing', name: 'Existing', ownerUserId: 'user-1', members: [] };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/use-workspace-projects', () => ({
  canManageWorkspaceProject: () => true,
  useWorkspaceProjectActions: () => ({ remove: vi.fn() }),
  useWorkspaceProjects: () => ({ projects: [existing], synced: true }),
}));
vi.mock('@/hooks/use-project-member-sources', () => ({
  useProjectMemberSources: () => ({ byKey: new Map() }),
}));

// The real dialog saves through the machine runtime; this stand-in saves
// whatever the host opened, the way the dialog reports a successful save.
vi.mock('../src/components/settings/project-group-editor-dialog', () => ({
  openProjectGroupEditorForCreate: () => ({ mode: 'add', projectId: 'created', value: {} }),
  openProjectGroupEditorForEdit: (project: WorkspaceProject) => ({
    mode: 'edit',
    project,
    value: {},
    readOnly: false,
  }),
  ProjectGroupEditorDialog: ({
    editor,
    onClose,
    onSaved,
  }: {
    editor: ProjectGroupEditorState | null;
    onClose: () => void;
    onSaved?: (project: WorkspaceProject, meta: { created: boolean }) => void;
  }) =>
    editor ? (
      <button
        type="button"
        onClick={() => {
          const project =
            editor.mode === 'add'
              ? ({ ...existing, id: editor.projectId } as unknown as WorkspaceProject)
              : editor.project;
          onSaved?.(project, { created: editor.mode === 'add' });
          onClose();
        }}
      >
        save
      </button>
    ) : null,
}));

const { ProjectEditorHost } = await import('../src/components/settings/project-editor-host');

describe('ProjectEditorHost', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
    await act(async () => {
      root.render(
        <Provider store={store}>
          <ProjectEditorHost />
        </Provider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  const save = async () => {
    await act(async () => container.querySelector('button')?.click());
  };

  it('hands the created project to the surface that asked for it', async () => {
    const onCreated = vi.fn();
    await act(async () => store.set(projectEditorRequestAtom, { kind: 'create', onCreated }));
    await save();
    expect(onCreated).toHaveBeenCalledWith('created');
    expect(container.querySelector('button')).toBeNull();
  });

  it('does not report an edit to an earlier create request', async () => {
    const onCreated = vi.fn();
    await act(async () => store.set(projectEditorRequestAtom, { kind: 'create', onCreated }));
    await act(async () =>
      store.set(projectEditorRequestAtom, { kind: 'edit', projectId: 'existing' })
    );
    await save();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
