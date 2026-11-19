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
      codec: 'session/v1',
      model: 'loro',
      action: 'merge',
      state: 'new',
      label: 'Fix login',
    },
    {
      id: 'session-2',
      codec: 'session/v1',
      model: 'loro',
      action: 'merge',
      state: 'unchanged',
      label: 'Old chat',
    },
    {
      id: 'session-3',
      codec: 'session/v1',
      model: 'loro',
      action: 'skip',
      reason: 'unrelated-same-id',
      label: 'Release notes',
    },
    {
      id: 'schedule-x',
      codec: 'schedule/v1',
      model: 'loro',
      action: 'merge',
      state: 'merge',
      label: 'Daily digest',
    },
    {
      id: 'ws_a:sr',
      codec: 'schedule-registry/v1',
      model: 'flock',
      action: 'merge',
      state: 'merge',
    },
    {
      id: 'ws_a:wf:workspace',
      codec: 'workspace-catalog/v1',
      model: 'flock',
      action: 'merge',
      state: 'merge',
    },
    {
      id: 'ws_a:mf:m1',
      codec: 'machine-catalog/v1',
      model: 'flock',
      action: 'skip',
      reason: 'machine-room',
    },
    {
      id: 'meta',
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
  it('groups changes by what people know and names skipped items', () => {
    expect(summarizeImportPlan(plan)).toEqual({
      kinds: [
        { kind: 'conversations', new: 1, updated: 0, unchanged: 1, skipped: 1 },
        { kind: 'schedules', new: 0, updated: 1, unchanged: 0, skipped: 0 },
        { kind: 'catalog', new: 0, updated: 1, unchanged: 0, skipped: 0 },
        { kind: 'machines', new: 0, updated: 0, unchanged: 0, skipped: 1 },
      ],
      skipped: [
        {
          kind: 'conversations',
          label: 'Release notes',
          reason: 'unrelated-same-id',
          detail: null,
        },
        { kind: 'machines', label: null, reason: 'machine-room', detail: null },
      ],
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
    expect(review).toContain('Release notes');
    expect(review).toContain('settings.workspaceData.kinds.conversations');
    expect(review).toContain('settings.workspaceData.skipReasons.unrelatedSameId');
    // People see names and plain reasons, never storage ids or internal row counts.
    for (const internal of ['session-3', 'ws_a:mf:m1', 'unrelated-same-id', 'review.metadata'])
      expect(review).not.toContain(internal);
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
