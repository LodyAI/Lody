// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { E2eeWorkspaceControlPage } from '../src/components/pages/e2ee-workspace-control-page';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
});

function render(overrides: Partial<ComponentProps<typeof E2eeWorkspaceControlPage>>) {
  const props: ComponentProps<typeof E2eeWorkspaceControlPage> = {
    workspaceId: 'workspace-1',
    history: null,
    loading: false,
    failure: null,
    diagnostics: () => '{"kind":"lody-e2ee-workspace-diagnostics"}',
    onRepairLocal: vi.fn(),
    onResetProgress: vi.fn(),
    onLoadMore: vi.fn(),
    onRefresh: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<E2eeWorkspaceControlPage {...props} />));
  return props;
}

const button = (label: string) =>
  [...container!.querySelectorAll('button')].find((item) => item.textContent === label);

describe('encrypted workspace control page recovery', () => {
  it('always marks the workspace as an encrypted developer preview', () => {
    render({});
    expect(container!.textContent).toContain('e2ee.control.badge');
  });

  it('requires a second confirmation before resetting observed history progress', () => {
    const props = render({ failure: { kind: 'progress-conflict', code: 'rolled-back' } });
    expect(container!.textContent).toContain('e2ee.control.failure.progressConflict');
    act(() => button('e2ee.control.resetProgress')!.click());
    expect(props.onResetProgress).not.toHaveBeenCalled();
    expect(container!.textContent).toContain('e2ee.control.resetProgressWarning');
    act(() => button('e2ee.control.resetProgressConfirm')!.click());
    expect(props.onResetProgress).toHaveBeenCalledTimes(1);
  });

  it('offers no local reset for an identity conflict and repair only for unreadable caches', () => {
    render({ failure: { kind: 'identity-conflict', code: 'pin-mismatch' } });
    expect(button('e2ee.control.resetProgress')).toBeUndefined();
    expect(button('e2ee.control.repairLocal')).toBeUndefined();
    expect(button('e2ee.control.copyDiagnostics')).toBeDefined();
    act(() => root?.unmount());
    const props = render({
      failure: { kind: 'local-corrupt', code: 'Invalid workspace mode proof' },
    });
    act(() => button('e2ee.control.repairLocal')!.click());
    expect(props.onRepairLocal).toHaveBeenCalledTimes(1);
  });

  it('shows the diagnostics report when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('denied')) },
    });
    render({ failure: { kind: 'server', code: 'bad-signature' } });
    await act(async () => {
      button('e2ee.control.copyDiagnostics')!.click();
      await Promise.resolve();
    });
    expect(container!.querySelector('details')?.open).toBe(true);
    expect(container!.textContent).toContain('lody-e2ee-workspace-diagnostics');
  });
});
