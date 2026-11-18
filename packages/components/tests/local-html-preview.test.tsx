// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initI18n } from '../src/i18n';
import {
  LocalHtmlPreviewConsentDialog,
  useLocalHtmlPreview,
} from '../src/components/sessions/local-html-preview';

const openHtmlPreview = vi.fn();
vi.mock('../src/lib/electron-ipc-client', () => ({
  getIpcServices: () => ({ machineRpc: { openHtmlPreview } }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ onCancel }: { readonly onCancel: () => void }) {
  const preview = useLocalHtmlPreview({
    active: true,
    machineId: 'local',
    hostPath: '/work/site/index.html',
    onCancel,
    onUnavailable: () => {},
  });
  return (
    <>
      <output data-testid="state">
        {preview.state.status === 'ready'
          ? `ready ${preview.state.url} scripts=${preview.state.allowScripts}`
          : preview.state.status}
      </output>
      <LocalHtmlPreviewConsentDialog
        open={preview.state.status === 'confirming'}
        fileName="index.html"
        workspaceRoot="/work"
        onConfirm={preview.confirm}
        onCancel={preview.cancel}
      />
    </>
  );
}

describe('desktop local HTML preview consent', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    openHtmlPreview.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  const button = (label: string) => {
    const found = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
    expect(found, label).toBeDefined();
    return found!;
  };
  const state = () => container.querySelector('[data-testid="state"]')?.textContent;

  it('opens the preview with the chosen script setting when the user confirms', async () => {
    let answer!: (value: unknown) => void;
    openHtmlPreview.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    let cancelled = false;
    await act(async () => root.render(<Harness onCancel={() => (cancelled = true)} />));

    await act(async () => document.querySelector<HTMLElement>('[role="checkbox"]')!.click());
    await act(async () => button('Preview').click());
    await act(async () => answer({ status: 'ok', url: 'lody-html-preview://t/index.html' }));

    expect(openHtmlPreview).toHaveBeenCalledWith({
      machineId: 'local',
      path: '/work/site/index.html',
      allowScripts: true,
    });
    expect(state()).toBe('ready lody-html-preview://t/index.html scripts=true');
    expect(cancelled).toBe(false);
  });

  it('opens with workspace resources and scripts independently selected', async () => {
    openHtmlPreview.mockResolvedValue({
      status: 'ok',
      url: 'lody-html-preview://t/site/index.html',
    });
    await act(async () => root.render(<Harness onCancel={() => {}} />));
    const labels = Array.from(document.querySelectorAll('label'));
    const workspace = labels.find((label) => label.textContent?.includes('/work'));
    expect(workspace).toBeDefined();
    await act(async () => workspace!.querySelector<HTMLElement>('[role="checkbox"]')!.click());
    await act(async () => button('Preview').click());
    expect(openHtmlPreview).toHaveBeenCalledWith({
      machineId: 'local',
      path: '/work/site/index.html',
      allowScripts: false,
      workspaceRoot: '/work',
      allowWorkspaceResources: true,
    });
    expect(state()).toBe('ready lody-html-preview://t/site/index.html scripts=false');
  });

  it('returns to the code view without opening anything when the user cancels', async () => {
    let cancelled = false;
    await act(async () => root.render(<Harness onCancel={() => (cancelled = true)} />));

    await act(async () => button('Cancel').click());

    expect(cancelled).toBe(true);
    expect(state()).toBe('idle');
    expect(openHtmlPreview).not.toHaveBeenCalled();
  });
});
