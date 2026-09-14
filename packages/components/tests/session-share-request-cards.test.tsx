// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
const cloud = vi.hoisted(() => ({ status: 'pending', cancel: vi.fn() }));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: () => [
    { requestId: 'request', sourceSessionId: 'root', sessionIds: ['root'], status: cloud.status },
  ],
  useCloudMutation: () => cloud.cancel,
}));
vi.mock('../src/lib/app-platform', () => ({ useAppCapability: () => true }));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ enabled: true }),
}));
vi.mock('../src/atoms', async () => ({ userAtom: (await import('jotai')).atom({ id: 'alice' }) }));
vi.mock('../src/atoms/doc-meta', async () => ({
  sessionMetaCacheAtom: (await import('jotai')).atom({ root: { id: 'root', title: 'Root title' } }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/components/sharing/session-share-dialog', () => ({
  SessionShareDialog: ({
    confirmation,
    onClose,
  }: {
    confirmation: { requestId: string };
    onClose: () => void;
  }) => (
    <div role="dialog" data-request={confirmation.requestId}>
      <button onClick={onClose}>Close editor</button>
    </div>
  ),
}));
import { SessionShareRequestCards } from '../src/components/sharing/session-share-request-cards';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <SessionShareRequestCards
        workspaceId={'workspace' as WorkspaceId}
        session={{ id: 'root' } as SessionMeta}
        isVisible
      />
    )
  );
const click = (text: string) =>
  act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === text)!
      .click()
  );
beforeEach(() => {
  cloud.status = 'pending';
  cloud.cancel.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it('opens human review without publishing and retains its editor after confirmation consumes the request', async () => {
  await render();
  expect(container.textContent).toContain('Root title');
  await click('Review and share');
  expect(container.querySelector('[role="dialog"]')?.getAttribute('data-request')).toBe('request');
  expect(cloud.cancel).not.toHaveBeenCalled();
  cloud.status = 'confirmed';
  await render();
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.textContent).toContain('Closing it discards the upload credentials');
  await click('Close editor');
  expect(container.textContent).toContain('cannot be resumed after the editor closes');
  expect(container.textContent).not.toContain('Retry in the open editor');
  await click('Abandon deployment');
  expect(cloud.cancel).toHaveBeenCalledWith({ requestId: 'request' });
});

it('explains abandon-and-restart after remount and hides completed requests', async () => {
  cloud.status = 'confirmed';
  await render();
  expect(container.textContent).toContain('Abandon deployment');
  expect(container.textContent).not.toContain('Review and share');
  expect(container.textContent).toContain('new share request with a new requestId');
  cloud.status = 'published';
  await render();
  expect(container.querySelector('section')).toBeNull();
});
