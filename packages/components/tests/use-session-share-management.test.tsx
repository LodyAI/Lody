// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionShareManagement } from '@lody/cloud-api';
import type { WorkspaceId } from '@lody/shared';
const cloud = vi.hoisted(() => ({
  state: null as SessionShareManagement,
  enabled: true,
  mutation: vi.fn(),
  capture: vi.fn(),
  upload: vi.fn(),
}));
vi.mock('@lody/platform/react', () => ({
  useCloudQuery: (_op: unknown, args: unknown) => (args === 'skip' ? undefined : cloud.state),
  useCloudMutation: (op: { name: string }) => (args: unknown) => cloud.mutation(op.name, args),
}));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ workspaceId: 'workspace', enabled: cloud.enabled }),
}));
vi.mock('../src/atoms', async () => ({
  userAtom: (await import('jotai')).atom<{ id: string } | null>({ id: 'alice' }),
}));
vi.mock('../src/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return {
    activeWorkspaceRuntimeAtom: atom({ workspaceId: 'workspace' }),
    authTokenAtom: atom('app-token'),
  };
});
vi.mock('../src/atoms/doc-meta', async () => ({
  sessionMetaCacheAtom: (await import('jotai')).atom({
    'session-root': { id: 'root', title: 'Root' },
  }),
}));
vi.mock('../src/lib/session-share-publisher', () => ({
  captureSessionShare: (...args: unknown[]) => cloud.capture(...args),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('@lody/shared/session-sharing', async (original) => ({
  ...(await original<object>()),
  createSessionShareSecret: () => 'a'.repeat(64),
  hashSessionShareSecret: async () => 'b'.repeat(64),
  uploadPreparedShare: (...args: unknown[]) => cloud.upload(...args),
}));
import { prepareSharePackage } from '@lody/shared/session-sharing';
import { userAtom } from '../src/atoms';
import { useSessionShareManagement } from '../src/hooks/use-session-share-management';
import {
  readSessionShareSecret,
  saveSessionShareSecret,
  sessionShareSecretKey,
} from '../src/lib/session-share-secrets';
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const entry = {
  shareId: 'share',
  rootSessionId: 'root',
  publisherUserId: 'alice',
  title: 'Root',
  status: 'active' as const,
  revision: 1,
  credentialVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  sourceIds: [{ sourceId: 'root', conversationId: 'c1' }],
  selectedSourceIds: ['root'],
  canManage: true,
  canRevoke: true,
};
const key = sessionShareSecretKey('alice', 'workspace', 'share');
describe('static publication client lifecycle', () => {
  let root: Root, container: HTMLDivElement, store: ReturnType<typeof createStore>;
  let control: ReturnType<typeof useSessionShareManagement>;
  let confirmation: { requestId: string; sessionIds: string[] } | undefined;
  function Harness() {
    control = useSessionShareManagement(
      'workspace' as WorkspaceId,
      'root',
      ['root'],
      undefined,
      confirmation
    );
    return null;
  }
  const render = () =>
    act(async () =>
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>
      )
    );
  beforeEach(async () => {
    cloud.state = null;
    confirmation = undefined;
    cloud.enabled = true;
    cloud.mutation.mockReset();
    cloud.capture.mockReset();
    cloud.upload.mockReset();
    cloud.upload.mockResolvedValue(undefined);
    cloud.capture.mockResolvedValue(
      await prepareSharePackage({
        rootSourceId: 'root',
        conversations: [{ sourceId: 'root', title: 'Root', history: [] }],
        capturedAt: '2026-09-12T00:00:00.000Z',
        readAttachment: async () => {
          throw new Error('Unexpected');
        },
      })
    );
    localStorage.clear();
    vi.stubEnv('VITE_SESSION_SHARE_ORIGIN', 'https://share.test');
    vi.stubEnv('VITE_SERVER_URL', 'https://api.test');
    store = createStore();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    cloud.mutation.mockImplementation(async (name: string) =>
      name === 'sessionSharing:beginDeployment'
        ? { ...entry, status: 'draft', revision: 0, deploymentId: 'deployment' }
        : entry
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
  });
  it('uploads only after the human action and saves the secret only after publication', async () => {
    await render();
    await act(async () => control.onPrepare());
    expect(cloud.capture).toHaveBeenCalledOnce();
    expect(cloud.mutation).not.toHaveBeenCalled();
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(control.pending).not.toBeNull();
    expect(readSessionShareSecret(localStorage, key, 1)).toBeNull();
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
      'sessionSharing:beginDeployment',
      'sessionSharing:publishDeployment',
    ]);
    expect(cloud.upload).toHaveBeenCalledOnce();
    expect(JSON.stringify(cloud.mutation.mock.calls)).not.toContain('a'.repeat(64));
    expect(readSessionShareSecret(localStorage, key, 1)).toBe('a'.repeat(64));
  });
  it('freezes, uploads and publishes from one action and reports a real clipboard write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await act(async () => control.onPublish());
    expect(cloud.capture).toHaveBeenCalledOnce();
    expect(cloud.upload).toHaveBeenCalledOnce();
    expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
      'sessionSharing:beginDeployment',
      'sessionSharing:publishDeployment',
    ]);
    const url = `https://share.test/s/share#access=v1.${'a'.repeat(64)}`;
    expect(writeText).toHaveBeenCalledWith(url);
    expect(control.result).toEqual({ url, copied: true });
    expect(control.phase).toBe('idle');
    expect(control.pending).toBeNull();
  });

  it('never claims a copy the clipboard refused, and keeps the link recoverable', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await act(async () => control.onPublish());
    expect(control.result).toEqual({
      url: `https://share.test/s/share#access=v1.${'a'.repeat(64)}`,
      copied: false,
    });
    expect(control.error).toBeNull();
  });

  it('reports a measured phase only while bytes move', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const gate = () => {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      return { promise, open };
    };
    const captureEntered = gate(),
      captureHeld = gate(),
      uploadEntered = gate(),
      uploadHeld = gate();
    const frozen = await prepareSharePackage({
      rootSourceId: 'root',
      conversations: [{ sourceId: 'root', title: 'Root', history: [] }],
      capturedAt: '2026-09-12T00:00:00.000Z',
      readAttachment: async () => {
        throw new Error('Unexpected');
      },
    });
    cloud.capture.mockImplementation(async () => {
      captureEntered.open();
      await captureHeld.promise;
      return frozen;
    });
    cloud.upload.mockImplementation(
      async ({ onProgress }: { onProgress?: (uploaded: number, total: number) => void }) => {
        onProgress?.(1, 2);
        uploadEntered.open();
        await uploadHeld.promise;
      }
    );
    await render();
    let published!: Promise<void>;
    // Freezing has no byte total, so it must not report a percentage.
    await act(async () => {
      published = control.onPublish();
      await captureEntered.promise;
    });
    expect([control.phase, control.progress]).toEqual(['capturing', 0]);
    await act(async () => {
      captureHeld.open();
      await uploadEntered.promise;
    });
    expect([control.phase, control.progress]).toEqual(['uploading', 50]);
    await act(async () => {
      uploadHeld.open();
      await published;
    });
    expect([control.phase, control.progress]).toEqual(['idle', 0]);
  });

  it('does not upload when an explicit preview freezes the package', async () => {
    await render();
    await act(async () => control.onPrepare());
    expect(control.pending).not.toBeNull();
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(cloud.mutation).not.toHaveBeenCalled();
    expect(control.phase).toBe('idle');
  });

  it('retries a failed publish without uploading or creating another deployment', async () => {
    let attempts = 0;
    cloud.mutation.mockImplementation(async (name: string) => {
      if (name === 'sessionSharing:beginDeployment')
        return { ...entry, status: 'draft', revision: 0, deploymentId: 'deployment' };
      if (++attempts === 1) throw new Error('Response lost');
      return entry;
    });
    await render();
    await act(async () => control.onPrepare());
    await act(async () => control.onPublish());
    expect(control.pending).not.toBeNull();
    expect(control.error).not.toBeNull();
    cloud.state = { ...entry, currentDeploymentId: 'deployment' };
    await render();
    expect(control.conflict).toBe(false);
    await act(async () => control.onPublish());
    expect(cloud.upload).toHaveBeenCalledOnce();
    expect(
      cloud.mutation.mock.calls.filter(([name]) => name === 'sessionSharing:beginDeployment')
    ).toHaveLength(1);
    expect(control.pending).toBeNull();
  });
  it('requires the frozen MCP target set and sends its approval identity only when publishing', async () => {
    confirmation = { requestId: 'request', sessionIds: ['root'] };
    await render();
    await act(async () => control.onSelect(['root', 'foreign']));
    await act(async () => control.onPrepare());
    expect(
      cloud.capture.mock.calls[0]?.[0].sessions.map((session: { id: string }) => session.id)
    ).toEqual(['root']);
    expect(cloud.mutation).not.toHaveBeenCalled();
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls[0]?.[1]).toMatchObject({ confirmationRequestId: 'request' });
  });
  it('updates the same share without creating or sending a new reader secret', async () => {
    cloud.state = entry;
    await render();
    await act(async () => control.onPrepare());
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls[0]?.[1]).toMatchObject({
      shareId: 'share',
      expectedRevision: 1,
    });
    expect(cloud.mutation.mock.calls[0]?.[1].credentialHash).toBeUndefined();
    expect(readSessionShareSecret(localStorage, key, 1)).toBeNull();
  });
  it('copies only the publisher’s device-local secret in the configured fragment URL', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    cloud.state = entry;
    saveSessionShareSecret(localStorage, key, { secret: 'a'.repeat(64), credentialVersion: 1 });
    await render();
    await act(async () => control.onCopy());
    expect(writeText).toHaveBeenCalledWith(
      `https://share.test/s/share#access=v1.${'a'.repeat(64)}`
    );
    store.set(userAtom, { id: 'bob' });
    await render();
    expect(control.hasSecret).toBe(false);
  });
  it('blocks publication when a prepared revision has changed', async () => {
    cloud.state = entry;
    await render();
    await act(async () => control.onPrepare());
    cloud.state = { ...entry, revision: 2 };
    await render();
    expect(control.conflict).toBe(true);
    await act(async () => control.onPublish());
    expect(cloud.mutation).not.toHaveBeenCalled();
  });
});
