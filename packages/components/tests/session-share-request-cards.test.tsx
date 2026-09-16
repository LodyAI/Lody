// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { prepareSharePackage, createShareDeliveryKey } from '@lody/shared/session-sharing';
import { act, Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionMeta, WorkspaceId } from '@lody/shared';
const cloud = vi.hoisted(() => ({
  status: 'pending',
  queryError: null as Error | null,
  cancel: vi.fn(),
  publicKey: '',
  capture: vi.fn(),
  upload: vi.fn(),
  published: Promise.resolve(),
  finish: () => {},
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: (op: { name: string }) => {
    if (op.name === 'sessionSharing:getManagement') return null;
    // Convex surfaces a failed query by throwing out of render.
    if (cloud.queryError) throw cloud.queryError;
    return [
      {
        requestId: 'request',
        sourceSessionId: 'root',
        sessionIds: ['root'],
        status: cloud.status,
        purpose: 'Review together',
        deliveryPublicKey: cloud.publicKey,
      },
    ];
  },
  useCloudMutation: (op: { name: string }) =>
    op.name === 'sessionSharing:cancelRequest'
      ? cloud.cancel
      : async () => {
          if (op.name === 'sessionSharing:publishDeployment') cloud.finish();
          return {
            shareId: 'share',
            rootSessionId: 'root',
            publisherUserId: 'alice',
            status: op.name === 'sessionSharing:beginDeployment' ? 'draft' : 'active',
            revision: 1,
            credentialVersion: 1,
            deploymentId: 'deployment',
          };
        },
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
vi.mock('../src/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return {
    activeWorkspaceRuntimeAtom: atom({ workspaceId: 'workspace' }),
    authTokenAtom: atom('test-token'),
  };
});
vi.mock('../src/lib/session-share-publisher', () => ({
  captureSessionShare: (...args: unknown[]) => cloud.capture(...args),
}));
vi.mock('@lody/shared/session-sharing', async (original) => ({
  ...(await original<object>()),
  uploadPreparedShare: (...args: unknown[]) => cloud.upload(...args),
}));
import { SessionShareRequestCards } from '../src/components/sharing/session-share-request-cards';

/** Stands in for the chat-stream boundary the cards must never reach. */
class ConversationBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    return this.state.error ? <p>conversation crashed</p> : this.props.children;
  }
}
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <ConversationBoundary>
        <SessionShareRequestCards
          workspaceId={'workspace' as WorkspaceId}
          session={{ id: 'root' } as SessionMeta}
          isVisible
        />
      </ConversationBoundary>
    )
  );
const click = (text: string) =>
  act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === text)!
      .click()
  );
beforeEach(async () => {
  cloud.published = new Promise<void>((resolve) => {
    cloud.finish = resolve;
  });
  vi.stubGlobal('crypto', webcrypto);
  vi.stubEnv('VITE_SESSION_SHARE_ORIGIN', 'https://share.test');
  vi.stubEnv('VITE_SERVER_URL', 'https://api.test');
  cloud.publicKey = (await createShareDeliveryKey()).publicKey;
  cloud.capture.mockReset().mockResolvedValue(
    await prepareSharePackage({
      rootSourceId: 'root',
      conversations: [{ sourceId: 'root', title: 'Root', history: [] }],
      capturedAt: '2026-09-16T00:00:00Z',
      readAttachment: async () => {
        throw new Error('Unexpected attachment');
      },
    })
  );
  cloud.upload.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  cloud.status = 'pending';
  cloud.queryError = null;
  cloud.cancel.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('discloses full agent delivery and completes publication with one approval', async () => {
  await render();
  expect(container.textContent).toContain('Root title');
  expect(container.textContent).toContain(
    'complete access link will be returned to the requesting agent'
  );
  expect(localStorage.length).toBe(0);
  await act(async () => {
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Approve and share')!
      .click();
    await cloud.published;
  });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain(
    'Published. The agent can now receive the complete link.'
  );
  expect(container.textContent).not.toContain('Approve and share');
  expect(localStorage.length).toBeGreaterThan(0);
});

it('explains interrupted publication and displays the committed result', async () => {
  cloud.status = 'confirmed';
  await render();
  expect(container.textContent).toContain('Abandon deployment');
  expect(container.textContent).not.toContain('Approve and share');
  expect(container.textContent).toContain('new share request with a new requestId');
  cloud.status = 'published';
  await render();
  expect(container.textContent).toContain('Published.');
});

it('keeps the conversation alive when the share-request query fails, and recovers on retry', async () => {
  // React re-logs a caught render error; the boundary under test owns reporting.
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    cloud.queryError = new Error('[CONVEX Q(sessionSharing:listRequests)] Server Error');
    await render();
    expect(container.textContent).not.toContain('conversation crashed');
    expect(container.textContent).toContain('Could not load pending share requests.');
    cloud.queryError = null;
    await click('Retry');
    expect(container.textContent).toContain('Root title');
    expect(container.textContent).toContain('Approve and share');
  } finally {
    logged.mockRestore();
  }
});
