// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WorkspaceDataSettingContent,
  type WorkspaceBundleApi,
} from '../src/components/settings/workspace-data-setting';
import type { WorkspaceBundlePlan } from '@lody/shared/workspace-bundle-control';
import { createTestI18n } from './test-i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const plan: WorkspaceBundlePlan = {
  digest: 'd',
  sourceWorkspaceId: 'ws_a',
  targetWorkspaceId: 'ws_b',
  gaps: [{ id: 'session-r', kind: 'roost', reason: 'cannot read' }],
  rooms: [
    {
      id: 'session-1',
      kind: 'conversations',
      counted: true,
      action: 'merge',
      state: 'new',
      label: 'Fix login',
    },
    {
      id: 'session-2',
      kind: 'conversations',
      counted: true,
      action: 'merge',
      state: 'unchanged',
      label: 'Old chat',
    },
    {
      id: 'session-3',
      kind: 'conversations',
      counted: true,
      action: 'skip',
      reason: 'unrelated-same-id',
      label: 'Release notes',
    },
    {
      id: 'schedule-x',
      kind: 'schedules',
      counted: true,
      action: 'merge',
      state: 'merge',
      label: 'Daily digest',
    },
    { id: 'ws_a:sr', kind: 'schedules', counted: false, action: 'merge', state: 'merge' },
    { id: 'ws_a:wf:workspace', kind: 'catalog', counted: true, action: 'merge', state: 'merge' },
    { id: 'ws_a:mf:m1', kind: 'machines', counted: true, action: 'skip', reason: 'machine-room' },
    { id: 'meta', kind: 'other', counted: false, action: 'merge', state: 'merge' },
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
      summary: { file: '/home/u/Team.lodybundle', rooms: 5, blobs: 2, gaps: [], digest: 'd' },
    }),
    chooseImportFile: async () => ({ status: 'chosen', token: 'tok', fileName: 'in.lodybundle' }),
    previewImport: async () => ({ status: 'planned', plan }),
    importWorkspace: async () => ({
      status: 'done',
      outcome: { plan, result: { imported: 3, skipped: 1, resumed: 0 }, uploadPending: [] },
    }),
    ...overrides,
  };
}

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

  it('offers no actions to members', () => {
    render(fakeApi(), false);
    expect(byTestId('workspace-bundle-export')).toBeNull();
    expect(byTestId('workspace-bundle-choose')).toBeNull();
    expect(byTestId('workspace-bundle-members-note')).not.toBeNull();
  });
});
