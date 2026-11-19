// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import {
  summarizeImportPlan,
  WorkspaceDataSettingContent,
  type WorkspaceBundleApi,
} from '../src/components/settings/workspace-data-setting';
import { createTestI18n } from './test-i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const plan = {
  digest: 'd',
  sourceWorkspaceId: 'ws_a',
  targetWorkspaceId: 'ws_b',
  gaps: [{ id: 'session-r', kind: 'roost', reason: 'cannot read' }],
  rooms: [
    {
      id: 'session-1',
      targetId: 'session-1',
      codec: 'session/v1',
      model: 'loro',
      action: 'merge',
      state: 'new',
    },
    {
      id: 'session-2',
      targetId: 'session-2',
      codec: 'session/v1',
      model: 'loro',
      action: 'merge',
      state: 'unchanged',
    },
    {
      id: 'session-3',
      targetId: 'session-3',
      codec: 'session/v1',
      model: 'loro',
      action: 'skip',
      reason: 'unrelated-same-id',
    },
    {
      id: 'meta',
      targetId: 'meta',
      codec: 'meta/v1',
      model: 'meta',
      action: 'merge',
      state: 'merge',
      rows: { added: 4, updated: 1, deleted: 2 },
    },
  ],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(api: WorkspaceBundleApi, canManage = true) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const i18n = createTestI18n({ keyLabels: true, exposeValues: true });
  act(() =>
    root!.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(WorkspaceDataSettingContent, {
          workspaceId: 'ws_b',
          workspaceName: 'Team',
          canManage,
          api,
        })
      )
    )
  );
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function click(id: string) {
  const element = byTestId(id);
  if (!element) throw new Error(`missing ${id}`);
  await act(async () => {
    element.click();
  });
}

function fakeApi(overrides: Partial<WorkspaceBundleApi> = {}): WorkspaceBundleApi {
  return {
    exportWorkspace: async () => ({
      status: 'done',
      summary: { file: '/home/u/Team.lodybundle', rooms: 5, blobs: 2, gaps: [] },
    }),
    chooseImportFile: async () => ({ status: 'chosen', token: 'tok', fileName: 'in.lodybundle' }),
    previewImport: async () => ({ status: 'planned', plan }),
    importWorkspace: async () => ({
      status: 'done',
      outcome: { result: { imported: 3, skipped: 1, resumed: 0 }, uploadPending: [] },
    }),
    ...overrides,
  };
}

describe('summarizeImportPlan', () => {
  it('counts what an import changes and lists what it skips', () => {
    expect(summarizeImportPlan(plan)).toEqual({
      newRooms: 1,
      updatedRooms: 0,
      unchangedRooms: 1,
      metadata: { added: 4, updated: 1, deleted: 2 },
      skipped: [{ id: 'session-3', reason: 'unrelated-same-id', detail: null }],
      gaps: 1,
    });
  });
});

describe('workspace data settings', () => {
  it('shows where the export was saved and what it contains', async () => {
    render(fakeApi());
    await click('workspace-bundle-export');
    const result = byTestId('workspace-bundle-export-result')?.textContent ?? '';
    expect(result).toContain('/home/u/Team.lodybundle');
    expect(result).toContain('5');
  });

  it('reviews the plan before importing and reports the result', async () => {
    render(fakeApi());
    await click('workspace-bundle-choose');
    const review = byTestId('workspace-bundle-review')?.textContent ?? '';
    expect(review).toContain('in.lodybundle');
    expect(review).toContain('session-3');
    expect(review).toContain('settings.workspaceData.skipReasons.unrelatedSameId');
    expect(review).not.toContain('unrelated-same-id');
    expect(byTestId('workspace-bundle-import-result')).toBeNull();
    await click('workspace-bundle-confirm');
    expect(byTestId('workspace-bundle-review')).toBeNull();
    expect(byTestId('workspace-bundle-import-result')?.textContent).toContain('3');
  });

  it('keeps nothing when the person cancels the review', async () => {
    render(
      fakeApi({ importWorkspace: async () => ({ status: 'error', message: 'should not run' }) })
    );
    await click('workspace-bundle-choose');
    await click('workspace-bundle-cancel');
    expect(byTestId('workspace-bundle-review')).toBeNull();
    expect(byTestId('workspace-bundle-import-result')).toBeNull();
  });

  it('shows a refusal from the local agent', async () => {
    render(
      fakeApi({
        exportWorkspace: async () => ({ status: 'error', message: 'local_agent_unavailable' }),
      })
    );
    await click('workspace-bundle-export');
    expect(byTestId('workspace-bundle-error')?.textContent).toContain('localAgentUnavailable');
  });

  it('offers no actions to members', () => {
    render(fakeApi(), false);
    expect(byTestId('workspace-bundle-export')).toBeNull();
    expect(byTestId('workspace-bundle-choose')).toBeNull();
    expect(byTestId('workspace-bundle-members-note')).not.toBeNull();
  });
});
