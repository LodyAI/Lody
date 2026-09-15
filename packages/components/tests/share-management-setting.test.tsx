// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  enabled: true,
  user: 'alice',
  workspace: 'workspace',
  workspaceSlug: 'acme' as string | null,
  sessionMeta: {} as Record<string, { id: string }>,
  navigate: vi.fn(),
  setSettingsDialogOpen: vi.fn(),
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: (...args: unknown[]) => mocks.query(...args),
}));
vi.mock('../src/lib/app-platform', () => ({ useAppCapability: () => mocks.enabled }));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ workspaceId: mocks.workspace, enabled: mocks.enabled }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../src/atoms', () => ({
  userAtom: 'user',
  currentWorkspaceSlugAtom: 'workspaceSlug',
}));
vi.mock('../src/atoms/settings', () => ({ settingsDialogOpenAtom: 'settingsDialogOpen' }));
vi.mock('../src/atoms/doc-meta', () => ({ sessionMetaCacheAtom: 'meta' }));
vi.mock('jotai', async (original) => ({
  ...(await original<object>()),
  useAtomValue: (atom: string) => {
    if (atom === 'user') return { id: mocks.user };
    if (atom === 'workspaceSlug') return mocks.workspaceSlug;
    if (atom === 'meta') return mocks.sessionMeta;
    return {};
  },
  useSetAtom: () => mocks.setSettingsDialogOpen,
}));
vi.mock('../src/hooks/use-session-share-management', () => ({
  useSessionShareLinkActions: () => ({
    secretFor: () => null,
    busy: false,
    error: null,
    notice: null,
  }),
}));
vi.mock('../src/components/sharing/session-share-dialog', () => ({
  SessionShareDialog: () => null,
}));
vi.mock('../src/components/settings', () => ({ settingContainerClass: '' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
import { ShareManagementSetting } from '../src/components/settings/share-management-setting';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe('share management settings inventory', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.navigate.mockReset();
    mocks.setSettingsDialogOpen.mockReset();
    mocks.enabled = true;
    mocks.workspace = 'workspace';
    mocks.workspaceSlug = 'acme';
    mocks.sessionMeta = {};
    mocks.user = 'alice';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = () => act(async () => root.render(<ShareManagementSetting />));
  it('paginates without accumulating stale copies and resets on workspace change', async () => {
    mocks.query.mockImplementation((_op, args) => ({
      page: [],
      isDone: args.paginationOpts.cursor !== null,
      continueCursor: 'page-2',
    }));
    await render();
    const next = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Next'
      )!;
    await act(async () => next().click());
    expect(mocks.query.mock.lastCall?.[1]).toMatchObject({
      workspaceId: 'workspace',
      paginationOpts: { cursor: 'page-2' },
    });
    expect(next().disabled).toBe(true);
    mocks.workspace = 'other';
    await render();
    expect(mocks.query.mock.lastCall?.[1]).toMatchObject({
      workspaceId: 'other',
      paginationOpts: { cursor: null },
    });
  });
  it('shows returned historical entries but never invents missing link secrets', async () => {
    mocks.query.mockReturnValue({
      page: [
        {
          shareId: 'share',
          rootSessionId: 'deleted',
          publisherUserId: 'alice',
          title: 'Archived copy',
          status: 'revoked',
          revision: 2,
          credentialVersion: 1,
          createdAt: 1,
          updatedAt: 2,
          totalBytes: 3,
          conversationCount: 1,
          canManage: false,
          canRevoke: false,
        },
      ],
      isDone: true,
      continueCursor: '',
    });
    await render();
    expect(container.textContent).toContain('Archived copy');
    expect(container.textContent).toContain('Revoked');
    expect(container.textContent).not.toContain('Copy link');
    expect(container.textContent).not.toContain('Update share');
  });
  it('opens the source conversation only while the session is locally known', async () => {
    const entry = {
      shareId: 'share',
      rootSessionId: 'session-1',
      publisherUserId: 'alice',
      title: 'Shared run',
      status: 'active',
      revision: 1,
      credentialVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      totalBytes: 3,
      conversationCount: 1,
      canManage: true,
      canRevoke: true,
    };
    mocks.query.mockReturnValue({ page: [entry], isDone: true, continueCursor: '' });
    const viewButton = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'View conversation'
      );
    await render();
    expect(viewButton()).toBeUndefined();

    mocks.sessionMeta = { 'session-1': { id: 'session-1' } };
    await render();
    await act(async () => viewButton()!.click());
    // Settings is a desktop modal over the workspace; the session is only visible
    // once it closes.
    expect(mocks.setSettingsDialogOpen).toHaveBeenCalledWith(false);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/$workspaceName/sessions/$sessionId',
      params: { workspaceName: 'acme', sessionId: 'session-1' },
    });
  });
  it('does not query cloud sharing when the platform capability is absent', async () => {
    mocks.enabled = false;
    await render();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
