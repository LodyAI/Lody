// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionId, SessionMeta, MachineId, WorkspaceId } from '@lody/shared';
import {
  createLocalPlatformProvider,
  createStaticStore,
  CLOUD_PLATFORM_CAPABILITIES,
} from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { SessionShareMobileMenu } from '../src/components/sharing/session-share-mobile-menu';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/ui/drawer', () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Drawer: ({ children, open }: { children?: ReactNode; open: boolean }) =>
      open ? <div>{children}</div> : null,
    DrawerContent: Part,
    DrawerTitle: Part,
    DrawerDescription: Part,
  };
});
// Management behavior has its own hook tests; assert the exact target at the
// mobile entry boundary while keeping the real mobile action/close behavior.
vi.mock('../src/components/sharing/session-share-dialog', () => ({
  SessionShareDialog: ({
    session,
    workspaceId,
    onClose,
  }: {
    session: SessionMeta;
    workspaceId: WorkspaceId;
    onClose: () => void;
  }) => (
    <div role="dialog" data-session={session.id} data-workspace={workspaceId}>
      <button onClick={onClose}>Close share</button>
    </div>
  ),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const child: SessionMeta = {
  id: 'child' as SessionId,
  userId: 'author',
  machineId: 'story-machine' as MachineId,
  cliType: 'builtin',
  agentType: 'claude',
  createdAt: '2026-09-07T00:00:00Z',
  title: 'Selected child',
  parentSessionId: 'root' as SessionId,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(session: SessionMeta | null, enabled = true) {
  const local = createLocalPlatformProvider({
    session: createStaticStore({ status: 'unauthenticated' }),
    workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
  });
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <PlatformContext.Provider
        value={{
          ...local,
          capabilities: enabled ? CLOUD_PLATFORM_CAPABILITIES : local.capabilities,
        }}
      >
        <SessionShareMobileMenu
          key={session?.id ?? 'draft'}
          open={open}
          onOpenChange={setOpen}
          workspaceId={'workspace' as WorkspaceId}
          session={session}
          infoRows={[]}
          actions={[]}
        />
      </PlatformContext.Provider>
    );
  }
  await act(async () => root.render(<Harness />));
}
it('opens sharing for the selected child Tab and closes the mobile action sheet', async () => {
  await render(child);
  const button = [...container.querySelectorAll('button')].find(
    (node) => node.textContent === 'Share conversation'
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(container.querySelector('[role="dialog"]')?.getAttribute('data-session')).toBe('child');
  expect(container.querySelector('[role="dialog"]')?.getAttribute('data-workspace')).toBe(
    'workspace'
  );
  expect(container.textContent).not.toContain('Share conversation');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it('does not offer a public link on a local platform', async () => {
  await render(child, false);
  expect(container.textContent).not.toContain('Share conversation');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it('does not substitute the root conversation for a draft or viewer', async () => {
  await render(null);
  expect(container.textContent).not.toContain('Share conversation');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
