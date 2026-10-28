// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
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
  language: 'en',
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
// The browser WASM loader needs a browser URL; this jsdom boundary exercises the uncompressed package variant.
vi.mock('@loro-dev/streams-crdt/zstd', () => ({ compress: async (bytes: Uint8Array) => bytes }));
vi.mock('../src/lib/session-share-publisher', () => ({
  captureSessionShare: (...args: unknown[]) => cloud.capture(...args),
}));
vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const i18n = createInstance();
  const en = (await import('../../../locales/en.json')).default;
  const zh = (await import('../../../locales/zh_CN.json')).default;
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: en }, zh_CN: { translation: zh } },
  });
  return { useTranslation: () => ({ t: i18n.getFixedT(cloud.language) }) };
});
vi.mock('@lody/shared/session-sharing', async (original) => ({
  ...(await original<object>()),
  createSessionShareSecret: () => 'a'.repeat(64),
  hashSessionShareSecret: async () => 'b'.repeat(64),
  uploadPreparedShare: (...args: unknown[]) => cloud.upload(...args),
}));
import {
  prepareSharePackage,
  createShareDeliveryKey,
  decryptShareDelivery,
  decodeShareHistoryBytes,
  type PreparedSharePackage,
} from '@lody/shared/session-sharing';
import { userAtom } from '../src/atoms';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { SessionShareManager } from '../src/components/sharing/session-share-manager';
import {
  useSessionShareManagement,
  useSessionShareStatus,
} from '../src/hooks/use-session-share-management';
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
  let recipient: Awaited<ReturnType<typeof createShareDeliveryKey>>;
  let showEditor = false;
  let candidates = ['root'];
  let publication: Promise<void> | undefined;
  let confirmation:
    | { requestId: string; sessionIds: string[]; deliveryPublicKey: string }
    | undefined;
  function Harness() {
    control = useSessionShareManagement(
      'workspace' as WorkspaceId,
      'root',
      candidates,
      undefined,
      confirmation
    );
    return showEditor ? (
      <SessionShareManager
        embedded
        sessionId="root"
        candidates={[{ sessionId: 'root', title: 'Root' }]}
        {...control}
        onConfirmPlaintextPublish={() => {
          publication = control.onConfirmPlaintextPublish();
          return publication;
        }}
      />
    ) : null;
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
    vi.stubGlobal('crypto', webcrypto);
    recipient = await createShareDeliveryKey();
    cloud.state = null;
    cloud.language = 'en';
    confirmation = undefined;
    showEditor = false;
    candidates = ['root'];
    publication = undefined;
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
  it('changing the server selection during consent must not disclose an unselected conversation', async () => {
    showEditor = true;
    const reads: string[] = [];
    const uploads = new Map<string, Uint8Array>();
    store.set(sessionMetaCacheAtom, {
      root: { id: 'root', title: 'Root' },
      private: { id: 'private-foreign', title: 'Unrelated private conversation' },
    } as never);
    store.set(activeWorkspaceRuntimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
      prepareSessionTarget: async () => {},
      acquireSessionStore: async (id: string) => ({
        sessionId: id,
        firstSynced: Promise.resolve(),
        acquireSync: () => () => {},
        sessionData: {
          history: {
            readAll: async () => {
              reads.push(id);
              return [
                {
                  id: 't',
                  role: 'assistant',
                  items: [
                    {
                      type: 'text',
                      text:
                        id === 'root' ? 'Approved root' : 'DO_NOT_PUBLISH_UNSELECTED_CONVERSATION',
                    },
                  ],
                },
              ];
            },
          },
        },
      }),
      releaseSessionStoreRef: () => {},
    } as never);
    const actualPublisher = await vi.importActual<
      typeof import('../src/lib/session-share-publisher')
    >('../src/lib/session-share-publisher');
    const actualProtocol = await vi.importActual<typeof import('@lody/shared/session-sharing')>(
      '@lody/shared/session-sharing'
    );
    cloud.capture.mockImplementation(actualPublisher.captureSessionShare);
    cloud.upload.mockImplementation((options) =>
      actualProtocol.uploadPreparedShare({
        ...options,
        fetch: async (url: string, init?: RequestInit) => {
          if (init?.method === 'PUT') uploads.set(url, new Uint8Array(init.body as ArrayBuffer));
          return new Response(null, { status: 204 });
        },
      })
    );
    cloud.state = { ...entry };
    await render();
    expect(control.selected).toEqual(['root']);
    expect(control.canCapture).toBe(true);
    await act(async () => control.onPublish());
    expect(control.plaintextConfirmation).toBe(true);
    expect(reads).toEqual([]);
    // A live management-query update changes the record after the warning opened.
    cloud.state = { ...entry, revision: 2, selectedSourceIds: ['root', 'private-foreign'] };
    await render();
    expect(control.canCapture).toBe(false);
    expect(control.plaintextConfirmation).toBe(true);
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((node) => node.textContent === 'Publish decrypted copy')!
        .click();
      await publication;
    });
    expect(control.result).toBeNull();
    expect(control.plaintextConfirmation).toBe(false);
    expect(reads).toEqual([]);
    expect(uploads.size).toBe(0);
    expect(cloud.mutation).not.toHaveBeenCalled();
  });

  it.each([
    'selected set',
    'revision',
    'credential version',
    'source map',
    'candidate removal',
    'source removal',
  ])('invalidates consent on %s changes and requires a new human action', async (change) => {
    store.set(activeWorkspaceRuntimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
    } as never);
    store.set(sessionMetaCacheAtom, {
      root: { id: 'root', title: 'Root' },
      child: { id: 'child', title: 'Child' },
    } as never);
    candidates = ['root', 'child'];
    cloud.state = { ...entry };
    await render();
    await act(async () => control.onPublish());
    const staleConfirm = control.onConfirmPlaintextPublish;
    if (change === 'selected set') cloud.state = { ...entry, selectedSourceIds: ['root', 'child'] };
    if (change === 'revision') cloud.state = { ...entry, revision: 2 };
    if (change === 'credential version') cloud.state = { ...entry, credentialVersion: 2 };
    if (change === 'source map')
      cloud.state = { ...entry, sourceIds: [{ sourceId: 'root', conversationId: 'replacement' }] };
    if (change === 'candidate removal') candidates = [];
    if (change === 'source removal') store.set(sessionMetaCacheAtom, {} as never);
    await render();
    await act(async () => staleConfirm());
    expect(control.result).toBeNull();
    expect(control.plaintextConfirmation).toBe(false);
    expect(cloud.capture).not.toHaveBeenCalled();
    expect(cloud.mutation).not.toHaveBeenCalled();
    expect(cloud.upload).not.toHaveBeenCalled();
    // Restore a valid selection. The rejected confirmation cannot authorize the replacement.
    candidates = ['root'];
    store.set(sessionMetaCacheAtom, { root: { id: 'root', title: 'Root' } } as never);
    cloud.state = { ...entry, revision: 2 };
    await render();
    await act(async () => staleConfirm());
    expect(cloud.capture).not.toHaveBeenCalled();
    await act(async () => control.onPublish());
    expect(control.plaintextConfirmation).toBe(true);
    expect(cloud.capture).not.toHaveBeenCalled();
    await act(async () => control.onConfirmPlaintextPublish());
    expect(control.error).toBeNull();
    expect(control.result).not.toBeNull();
    expect(cloud.mutation.mock.calls[0]?.[1]).toMatchObject({ expectedRevision: 2 });
  });

  it('revalidates the record after asynchronous capture before sending the manifest', async () => {
    store.set(activeWorkspaceRuntimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
    } as never);
    cloud.state = { ...entry };
    const prepared = await prepareSharePackage({
      rootSourceId: 'root',
      conversations: [{ sourceId: 'root', title: 'Root', history: [] }],
      capturedAt: '2026-09-12T00:00:00Z',
      readAttachment: async () => {
        throw new Error('Unexpected');
      },
    });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    cloud.capture.mockImplementation(async () => {
      entered();
      await held;
      return prepared;
    });
    await render();
    await act(async () => control.onPublish());
    let publishing!: Promise<void>;
    await act(async () => {
      publishing = control.onConfirmPlaintextPublish();
      await started;
    });
    cloud.state = { ...entry, revision: 2 };
    await render();
    await act(async () => {
      release();
      await publishing;
    });
    expect(control.result).toBeNull();
    expect(control.hasPending).toBe(false);
    expect(cloud.mutation).not.toHaveBeenCalled();
    expect(cloud.upload).not.toHaveBeenCalled();
  });

  it.each([
    { existingShare: false, externalChange: false },
    { existingShare: false, externalChange: true },
    { existingShare: true, externalChange: false },
    { existingShare: true, externalChange: true },
  ])(
    'recognizes its own admission (existing=$existingShare, external=$externalChange)',
    async ({ existingShare, externalChange }) => {
      store.set(activeWorkspaceRuntimeAtom, {
        workspaceId: 'workspace',
        contentMode: 'e2ee',
      } as never);
      cloud.state = existingShare ? { ...entry } : null;
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = {
        ...entry,
        status: existingShare ? ('active' as const) : ('draft' as const),
        revision: 2,
        deploymentId: 'deployment',
      };
      cloud.mutation.mockImplementation(async (name: string) => {
        if (name === 'sessionSharing:beginDeployment') {
          entered();
          await held;
          return admitted;
        }
        return { ...admitted, status: 'active' };
      });
      await render();
      await act(async () => control.onPublish());
      let publishing!: Promise<void>;
      await act(async () => {
        publishing = control.onConfirmPlaintextPublish();
        await started;
      });
      cloud.state = { ...admitted, revision: externalChange ? 3 : 2 };
      await render();
      await act(async () => {
        release();
        await publishing;
      });
      if (externalChange) {
        expect(control.result).toBeNull();
        expect(control.hasPending).toBe(false);
        expect(cloud.upload).not.toHaveBeenCalled();
        expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
          'sessionSharing:beginDeployment',
        ]);
      } else {
        expect(control.error).toBeNull();
        expect(control.result).not.toBeNull();
        expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
          'sessionSharing:beginDeployment',
          'sessionSharing:publishDeployment',
        ]);
      }
    }
  );

  it.each(['empty draft', 'prepared draft', 'wrong record', 'wrong version', 'foreign mapping'])(
    'replaces a revoked encrypted share only with its own acknowledged %s',
    async (scenario) => {
      store.set(activeWorkspaceRuntimeAtom, {
        workspaceId: 'workspace',
        contentMode: 'e2ee',
      } as never);
      cloud.state = {
        ...entry,
        status: 'revoked',
        revision: 2,
        canManage: false,
        canRevoke: false,
      };
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = {
        ...entry,
        shareId: 'replacement-share',
        status: 'draft' as const,
        revision: 0,
        title: '',
        createdAt: 2,
        updatedAt: 2,
        deploymentId: 'replacement-deployment',
      };
      cloud.mutation.mockImplementation(async (name: string) => {
        if (name === 'sessionSharing:beginDeployment') {
          entered();
          await held;
          return admitted;
        }
        return { ...admitted, status: 'active', revision: 1 };
      });
      await render();
      expect(control.canCapture).toBe(true);
      await act(async () => control.onPublish());
      expect(control.plaintextConfirmation).toBe(true);
      let publishing!: Promise<void>;
      await act(async () => {
        publishing = control.onConfirmPlaintextPublish();
        await started;
      });
      // Convex getManagement follows the new draft created by this very beginDeployment.
      const prepared: PreparedSharePackage = await cloud.capture.mock.results[0]!.value;
      cloud.state = {
        ...admitted,
        sourceIds: [],
        selectedSourceIds: [],
        canManage: true,
        canRevoke: true,
      };
      if (scenario === 'prepared draft')
        cloud.state = {
          ...cloud.state,
          sourceIds: prepared.sourceIds,
          selectedSourceIds: ['root'],
        };
      if (scenario === 'wrong record') cloud.state = { ...cloud.state, shareId: 'foreign-share' };
      if (scenario === 'wrong version') cloud.state = { ...cloud.state, revision: 1 };
      if (scenario === 'foreign mapping')
        cloud.state = {
          ...cloud.state,
          sourceIds: [{ sourceId: 'foreign', conversationId: 'foreign' }],
          selectedSourceIds: ['foreign'],
        };
      await render();
      expect(control.canCapture).toBe(true);
      await act(async () => {
        release();
        await publishing;
      });
      if (['wrong record', 'wrong version', 'foreign mapping'].includes(scenario)) {
        expect(control.result).toBeNull();
        expect(control.hasPending).toBe(false);
        expect(cloud.upload).not.toHaveBeenCalled();
        expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
          'sessionSharing:beginDeployment',
        ]);
        return;
      }
      expect(control.error).toBeNull();
      expect(control.result).not.toBeNull();
      expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
        'sessionSharing:beginDeployment',
        'sessionSharing:publishDeployment',
      ]);
      expect(cloud.mutation.mock.calls[0]?.[1]).toMatchObject({
        shareId: undefined,
        expectedRevision: undefined,
      });
      expect(control.result?.url).toContain('/s/replacement-share');
      expect(control.hasPending).toBe(false);
    }
  );

  it('does not commit after the share changes during upload', async () => {
    store.set(activeWorkspaceRuntimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
    } as never);
    cloud.state = { ...entry };
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    cloud.upload.mockImplementation(async () => {
      entered();
      await held;
    });
    await render();
    await act(async () => control.onPublish());
    let publishing!: Promise<void>;
    await act(async () => {
      publishing = control.onConfirmPlaintextPublish();
      await started;
    });
    cloud.state = { ...entry, revision: 2 };
    await render();
    await act(async () => {
      release();
      await publishing;
    });
    expect(control.result).toBeNull();
    expect(control.hasPending).toBe(false);
    expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
      'sessionSharing:beginDeployment',
    ]);
  });

  it.each(['en', 'zh_CN'])(
    'confirms encrypted copies before real capture and HTTP upload (%s)',
    async (language) => {
      cloud.language = language;
      showEditor = true;
      const history = [
        {
          id: 't',
          role: 'assistant',
          items: [{ type: 'text', text: 'Synthetic encrypted conversation' }],
        },
      ];
      const held = new Set<string>();
      store.set(activeWorkspaceRuntimeAtom, {
        workspaceId: 'workspace',
        contentMode: 'e2ee',
        prepareSessionTarget: async () => {},
        acquireSessionStore: async (id: string) => {
          held.add(id);
          return {
            sessionId: id,
            firstSynced: Promise.resolve(),
            acquireSync: () => () => {},
            sessionData: { history: { readAll: async () => history } },
          };
        },
        releaseSessionStoreRef: (id: string) => held.delete(id),
      } as never);
      const { captureSessionShare } = await vi.importActual<
        typeof import('../src/lib/session-share-publisher')
      >('../src/lib/session-share-publisher');
      const { uploadPreparedShare } = await vi.importActual<
        typeof import('@lody/shared/session-sharing')
      >('@lody/shared/session-sharing');
      cloud.capture.mockImplementation(captureSessionShare);
      const uploads = new Map<string, Uint8Array>();
      let sealed: unknown = null;
      const fetch = async (url: string, init?: RequestInit) => {
        const bytes = new Uint8Array(init!.body as ArrayBuffer);
        if (init?.method === 'PUT') uploads.set(url, bytes);
        else sealed = JSON.parse(new TextDecoder().decode(bytes));
        return new Response(null, { status: 204 });
      };
      cloud.upload.mockImplementation((options) => uploadPreparedShare({ ...options, fetch }));
      const click = async (name: string) => {
        const button = [...container.querySelectorAll('button')].find(
          (node) => node.textContent === name
        );
        expect(button, `missing button: ${name}`).toBeTruthy();
        await act(async () => {
          button!.click();
          await publication;
        });
      };
      const disclosure =
        language === 'en'
          ? 'Sharing publishes a decrypted copy outside E2EE, where the server can read it.'
          : '分享会把一份解密后的副本发布到 E2EE 之外（服务器可读）';
      const publishLabel = language === 'en' ? 'Share conversation' : '分享对话';
      const cancelLabel = language === 'en' ? 'Cancel' : '取消';
      const confirmLabel = language === 'en' ? 'Publish decrypted copy' : '确认发布解密副本';
      await render();
      await click(publishLabel);
      expect(container.textContent).toContain(disclosure);
      expect(container.textContent).toContain(
        language === 'en'
          ? 'Revoking the share cannot take back content that has already been viewed or copied.'
          : '撤销分享不会撤回已被看过或复制的内容'
      );
      expect(control.phase).toBe('idle');
      expect(control.result).toBeNull();
      expect(uploads.size).toBe(0);
      expect(sealed).toBeNull();
      expect(cloud.capture).not.toHaveBeenCalled();
      expect(cloud.mutation).not.toHaveBeenCalled();
      const staleConfirm = control.onConfirmPlaintextPublish;
      await click(cancelLabel);
      await act(async () => staleConfirm());
      expect(container.textContent).not.toContain(disclosure);
      expect(control.result).toBeNull();
      expect(uploads.size).toBe(0);
      expect(cloud.capture).not.toHaveBeenCalled();
      expect(cloud.mutation).not.toHaveBeenCalled();
      await click(publishLabel);
      await click(confirmLabel);
      const prepared: PreparedSharePackage = await cloud.capture.mock.results[0]!.value;
      expect(control.error).toBeNull();
      expect(control.result?.url).toContain('https://share.test/s/share');
      expect(sealed).toEqual(prepared.manifest);
      const descriptor = prepared.manifest.objects.find(
        (candidate) => candidate.id === prepared.manifest.conversations[0]!.historyObjectId
      )!;
      const bytes = uploads.get(
        `https://api.test/api/share-deployments/deployment/objects/${descriptor.id}`
      )!;
      expect(
        JSON.parse(new TextDecoder().decode(decodeShareHistoryBytes(bytes, descriptor)))
      ).toEqual(history);
      expect(held.size).toBe(0);
      expect(control.hasPending).toBe(false);
    }
  );

  it('rejects consent from a replaced encrypted runtime', async () => {
    store.set(activeWorkspaceRuntimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
    } as never);
    await render();
    await act(async () => control.onPublish());
    store.set(activeWorkspaceRuntimeAtom, {
      workspaceId: 'workspace',
      contentMode: 'e2ee',
    } as never);
    await act(async () => control.onConfirmPlaintextPublish());
    expect(control.result).toBeNull();
    expect(cloud.capture).not.toHaveBeenCalled();
    expect(cloud.mutation).not.toHaveBeenCalled();
  });

  it.each([
    [
      'share_quota_exceeded',
      'at most 2 unfinished publications, 10 new publication attempts per hour, and 2 GiB',
    ],
    ['share_conflict', 'Close and reopen sharing'],
    ['share_forbidden', 'no longer have permission'],
    ['share_unavailable', 'no longer available'],
    ['share_confirmation_required', 'send a new request'],
    ['unauthenticated', 'Sign in again'],
  ])('explains %s without publishing or exposing the server payload', async (code, expected) => {
    cloud.mutation.mockRejectedValue(
      Object.assign(new Error('private transcript access=v1.secret'), {
        data: { code, privateDetail: 'private transcript' },
      })
    );
    await render();
    await act(async () => control.onPublish());
    expect(control.error).toContain(expected);
    expect(control.error).not.toMatch(/private transcript|access=v1/);
    expect(control.result).toBeNull();
    expect(cloud.upload).not.toHaveBeenCalled();
  });

  it.each([
    [new Error('Share image exceeds size limit'), 'Each image can be up to 20 MB'],
    [new Error('Share history exceeds size limit'), 'history can be up to 32 MiB'],
    [new Error('Share package exceeds size limit'), 'share can be up to 256 MiB'],
    [new Error('Too many share attachments'), 'up to 64 images'],
    [new Error('Invalid share selection'), 'between 1 and 32 conversations'],
    [
      new Error('Share object exceeds size limit'),
      '32 MiB, each image 20 MB, and the whole share 256 MiB',
    ],
    [new Error('Share attachment unavailable'), 'image could not be loaded'],
    [new DOMException('expired', 'TimeoutError'), 'took too long'],
    [new Error('unknown private transcript'), 'Could not load the conversations'],
  ])('explains capture failures and allows a fresh retry', async (failure, expected) => {
    cloud.capture.mockRejectedValueOnce(failure);
    await render();
    await act(async () => control.onPublish());
    expect(control.error).toContain(expected);
    expect(control.phase).toBe('idle');
    expect(control.hasPending).toBe(false);
    expect(cloud.mutation).not.toHaveBeenCalled();
    await act(async () => control.onPublish());
    expect(control.error).toBeNull();
    expect(control.result).not.toBeNull();
  });

  it('identifies upload failures after progress resets and preserves the retry', async () => {
    cloud.upload.mockRejectedValueOnce(new TypeError('Failed to fetch private URL'));
    await render();
    await act(async () => control.onPublish());
    expect(control.phase).toBe('idle');
    expect(control.error).toContain('upload did not finish');
    expect(control.error).not.toContain('private URL');
    expect(control.hasPending).toBe(true);
    await act(async () => control.onPublish());
    expect(control.error).toBeNull();
    expect(control.result).not.toBeNull();
    expect(cloud.capture).toHaveBeenCalledOnce();
    expect(
      cloud.mutation.mock.calls.filter(([name]) => name === 'sessionSharing:beginDeployment')
    ).toHaveLength(1);
  });

  it('distinguishes admission failure from upload failure', async () => {
    cloud.mutation.mockRejectedValue(new Error('Unknown transport failure'));
    await render();
    await act(async () => control.onPublish());
    expect(control.error).toContain('Could not start sharing');
    expect(cloud.upload).not.toHaveBeenCalled();
  });

  it('keeps the published link available when manual copy is blocked', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await act(async () => control.onPublish());
    expect(control.error).toBeNull();
    expect(control.result?.copied).toBe(false);
    const link = control.shareLink;
    expect(link).toContain('https://share.test/s/');
    await act(async () => control.onCopy());
    expect(control.error).toContain('copy the full link');
    expect(control.shareLink).toBe(link);
  });

  it('explains a missing device credential without attempting clipboard access', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    cloud.state = entry;
    await render();
    await act(async () => control.onCopy());
    expect(control.error).toContain('previous link will stop working');
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each(['onReset', 'onRevoke'] as const)(
    'reports uncertain %s results without claiming success',
    async (action) => {
      cloud.state = entry;
      cloud.mutation.mockRejectedValue(new Error('Response lost'));
      await render();
      await act(async () => {
        await control[action]();
      });
      expect(control.error).toContain(
        action === 'onReset' ? 'whether the link was reset' : 'whether sharing was stopped'
      );
      expect(control.notice).toBeNull();
    }
  );

  it('retains the reader credential when the dialog closes during publication', async () => {
    let finish!: (value: typeof entry) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    cloud.mutation.mockImplementation(async (name: string) => {
      if (name === 'sessionSharing:beginDeployment')
        return { ...entry, status: 'draft', deploymentId: 'deployment' };
      expect(readSessionShareSecret(localStorage, key, 1)).toBe('a'.repeat(64));
      entered();
      return new Promise<typeof entry>((resolve) => {
        finish = resolve;
      });
    });
    await render();
    let pending!: Promise<void>;
    await act(async () => {
      pending = control.onPublish();
      await started;
    });
    await act(async () => root.render(null));
    await act(async () => {
      finish(entry);
      await pending;
    });
    cloud.state = entry;
    await render();
    expect(control.shareLink).toBe(`https://share.test/s/share#access=v1.${'a'.repeat(64)}`);
  });

  it('blocks upload and publication on storage failure and reuses the deployment on retry', async () => {
    await render();
    const write = vi
      .spyOn(Object.getPrototypeOf(localStorage) as Storage, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage disabled');
      });
    try {
      await act(async () => control.onPublish());
      expect(control.error).toContain('Could not save the share link');
      expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
        'sessionSharing:beginDeployment',
      ]);
      expect(cloud.upload).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
      'sessionSharing:beginDeployment',
      'sessionSharing:publishDeployment',
    ]);
    expect(control.shareLink).toBe(`https://share.test/s/share#access=v1.${'a'.repeat(64)}`);
  });

  it('does not overwrite a newer saved credential or publish with a stale one', async () => {
    saveSessionShareSecret(localStorage, key, { credentialVersion: 2, secret: 'c'.repeat(64) });
    await render();
    await act(async () => control.onPublish());
    expect(readSessionShareSecret(localStorage, key, 2)).toBe('c'.repeat(64));
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(control.error).toContain('Could not save the share link');
    expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
      'sessionSharing:beginDeployment',
    ]);
  });

  it('revokes an unfinished draft before beginning a fresh deployment', async () => {
    cloud.state = { ...entry, status: 'draft' };
    await render();
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls.map(([name]) => name)).toEqual([
      'sessionSharing:revoke',
      'sessionSharing:beginDeployment',
      'sessionSharing:publishDeployment',
    ]);
    expect(cloud.mutation.mock.calls[0]?.[1]).toEqual({
      shareId: 'share',
      expectedRevision: 1,
    });
  });

  it('uploads only after the human action and retains the published secret', async () => {
    await render();
    expect(cloud.capture).not.toHaveBeenCalled();
    expect(cloud.mutation).not.toHaveBeenCalled();
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(control.hasPending).toBe(false);
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
    expect(control.hasPending).toBe(false);
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

  it('retries a failed publish without uploading or creating another deployment', async () => {
    let attempts = 0;
    cloud.mutation.mockImplementation(async (name: string) => {
      if (name === 'sessionSharing:beginDeployment')
        return { ...entry, status: 'draft', revision: 0, deploymentId: 'deployment' };
      if (++attempts === 1) throw new Error('Response lost');
      return entry;
    });
    await render();
    await act(async () => control.onPublish());
    expect(control.hasPending).toBe(true);
    expect(control.error).toContain('Could not confirm whether the share was published');
    cloud.state = { ...entry, currentDeploymentId: 'deployment' };
    await render();
    expect(control.conflict).toBe(false);
    await act(async () => control.onPublish());
    expect(cloud.upload).toHaveBeenCalledOnce();
    expect(
      cloud.mutation.mock.calls.filter(([name]) => name === 'sessionSharing:beginDeployment')
    ).toHaveLength(1);
    expect(control.hasPending).toBe(false);
  });
  it('requires the frozen MCP target set and sends its approval identity only when publishing', async () => {
    confirmation = {
      requestId: 'request',
      sessionIds: ['root'],
      deliveryPublicKey: recipient.publicKey,
    };
    await render();
    await act(async () => control.onSelect(['root', 'foreign']));
    expect(cloud.capture).not.toHaveBeenCalled();
    expect(cloud.mutation).not.toHaveBeenCalled();
    await act(async () => control.onPublish());
    expect(
      cloud.capture.mock.calls[0]?.[0].sessions.map((session: { id: string }) => session.id)
    ).toEqual(['root']);
    expect(cloud.mutation.mock.calls[0]?.[1]).toMatchObject({ confirmationRequestId: 'request' });
    const delivery = cloud.mutation.mock.calls[0]?.[1].delivery;
    expect(await decryptShareDelivery(recipient.privateKey, 'request', delivery)).toBe(
      'a'.repeat(64)
    );
    expect(control.result?.url).toBe('https://share.test/s/share#access=v1.' + 'a'.repeat(64));
  });
  it("publishes an independent MCP link without requiring another device's existing secret", async () => {
    cloud.state = entry;
    confirmation = {
      requestId: 'request',
      sessionIds: ['root'],
      deliveryPublicKey: recipient.publicKey,
    };
    await render();
    await act(async () => control.onPublish());
    const args = cloud.mutation.mock.calls[0]?.[1];
    expect(args.shareId).toBeUndefined();
    expect(args.credentialHash).toBeDefined();
    expect(await decryptShareDelivery(recipient.privateKey, 'request', args.delivery)).toBe(
      'a'.repeat(64)
    );
    expect(control.result?.url).toContain('/s/share#access=v1.');
  });

  it('keeps the encrypted result identical after an ambiguous begin response', async () => {
    confirmation = {
      requestId: 'request',
      sessionIds: ['root'],
      deliveryPublicKey: recipient.publicKey,
    };
    cloud.mutation.mockRejectedValueOnce(new Error('Response lost'));
    await render();
    await act(async () => control.onPublish());
    const first = cloud.mutation.mock.calls[0]?.[1];
    expect(control.hasPending).toBe(true);
    expect(control.result).toBeNull();
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls[1]?.[1]).toEqual(first);
    expect(control.result?.url).toContain('/s/share#access=v1.');
  });

  it('retries MCP capture only after another explicit publish action', async () => {
    confirmation = {
      requestId: 'request',
      sessionIds: ['root'],
      deliveryPublicKey: recipient.publicKey,
    };
    cloud.capture.mockRejectedValueOnce(new Error('Capture unavailable'));
    await render();
    expect(cloud.capture).not.toHaveBeenCalled();
    await act(async () => control.onPublish());
    expect(control.error).not.toBeNull();
    expect(control.hasPending).toBe(false);
    expect(cloud.upload).not.toHaveBeenCalled();
    expect(cloud.mutation).not.toHaveBeenCalled();
    await render();
    expect(cloud.capture).toHaveBeenCalledTimes(1);
    await act(async () => control.onPublish());
    expect(cloud.mutation.mock.calls[0]?.[1]).toMatchObject({ confirmationRequestId: 'request' });
    expect(control.result?.url).toContain('/s/share#access=');
  });
  it('updates the same share without creating or sending a new reader secret', async () => {
    cloud.state = entry;
    await render();
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
    cloud.upload.mockRejectedValueOnce(new Error('Upload interrupted'));
    await act(async () => control.onPublish());
    cloud.mutation.mockClear();
    cloud.state = { ...entry, revision: 2 };
    await render();
    expect(control.conflict).toBe(true);
    await act(async () => control.onPublish());
    expect(cloud.mutation).not.toHaveBeenCalled();
  });
});

describe('header share status', () => {
  let root: Root, container: HTMLDivElement, store: ReturnType<typeof createStore>;
  let status: ReturnType<typeof useSessionShareStatus>;
  let workspaceId: WorkspaceId | null;
  function Harness() {
    status = useSessionShareStatus(workspaceId, 'root');
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
  beforeEach(() => {
    cloud.state = null;
    cloud.enabled = true;
    store = createStore();
    workspaceId = 'workspace' as WorkspaceId;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it('reports an active share', async () => {
    cloud.state = entry;
    await render();
    expect(status).toBe('shared');
  });
  it('reports a conversation that was never published', async () => {
    await render();
    expect(status).toBe('none');
  });
  it.each(['draft', 'revoked'] as const)('does not report a %s share as shared', async (state) => {
    cloud.state = { ...entry, status: state };
    await render();
    expect(status).toBe('none');
  });
  it('stays unknown until the control plane answers', async () => {
    cloud.state = undefined as unknown as SessionShareManagement;
    await render();
    expect(status).toBe('unknown');
  });
  it('reports nothing shared without a workspace, whatever the control plane holds', async () => {
    workspaceId = null;
    cloud.state = entry;
    await render();
    expect(status).toBe('none');
  });
});
