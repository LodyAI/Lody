import { afterEach, expect, it, vi } from 'vitest';
import { createStore, type PlatformProvider, type PlatformSessionState } from '@lody/platform';
import { installAttachmentWorkspaceAccess } from '../src/lib/attachment-workspace-access';
import { uploadSessionImage } from '../src/lib/session-image-upload';
import { uploadSessionFile } from '../src/lib/session-file-upload';
import { retainWorkspaceModeProof } from '../src/lib/e2ee-workspace-storage';
import type { WorkspaceAdmissionDescriptor } from '@lody/cloud-api';
import type { WorkspaceId, SessionId } from '@lody/shared';

const workspaceId = 'workspace' as WorkspaceId;
const sessionId = 'session' as SessionId;
let remove: (() => void) | undefined;
afterEach(() => {
  remove?.();
  remove = undefined;
  localStorage.clear();
  vi.unstubAllGlobals();
});
const plain = { workspaceId, contentMode: 'plaintext', contentModeVersion: 1 } as const;
const encrypted = {
  workspaceId,
  contentMode: 'e2ee',
  contentModeVersion: 1,
  activation: 'control-only',
  genesisHash: 'a'.repeat(64),
  cryptoOrgId: 'a'.repeat(64),
} as const;
const authenticated = (id: string): PlatformSessionState => ({
  status: 'authenticated',
  user: { id } as never,
});

function fixture(describe: () => Promise<WorkspaceAdmissionDescriptor> = async () => plain) {
  const session = createStore(authenticated('account'));
  remove = installAttachmentWorkspaceAccess({
    identity: { session, signOut: async () => {} },
    e2eeWorkspaces: { describe } as PlatformProvider['e2eeWorkspaces'],
    workspaces: {
      state: createStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
      setActive: async () => {},
    },
  });
  const bodies: unknown[] = [];
  class Xhr {
    upload = {};
    responseType = '';
    response: unknown;
    status = 200;
    onload?: () => void;
    open() {}
    setRequestHeader() {}
    abort() {}
    send(body: unknown) {
      bodies.push(body);
      this.response = {
        image: {
          type: 'image',
          imageId: 'image',
          fileName: 'secret.png',
          mimeType: 'image/png',
          sizeBytes: 6,
        },
        file: {
          type: 'file',
          fileId: 'file',
          fileName: 'secret.txt',
          mimeType: 'text/plain',
          sizeBytes: 6,
          sha256: 'a'.repeat(64),
          textPreview: true,
          transport: 'r2',
          uploadedAt: 1,
        },
      };
      this.onload?.();
    }
  }
  vi.stubGlobal('XMLHttpRequest', Xhr);
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    bodies.push(init?.body);
    return new Response('', { status: 403 });
  });
  return { bodies, session };
}
const upload = (kind: 'image' | 'file', accountId?: string) =>
  kind === 'image'
    ? uploadSessionImage({
        accountId,
        content: { mode: 'plaintext' },
        workspaceId,
        sessionId,
        token: 'token',
        file: new File(['secret'], 'secret.png', { type: 'image/png' }),
      })
    : uploadSessionFile({
        accountId,
        content: { mode: 'plaintext' },
        workspaceId,
        sessionId,
        token: 'token',
        file: new File(['secret'], 'secret.txt', { type: 'text/plain' }),
        sha256: 'a'.repeat(64),
        textPreview: true,
      });

it.each(['image', 'file'] as const)(
  'withholds the %s body until an unknown mode is confirmed, then preserves ordinary uploads',
  async (kind) => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<WorkspaceAdmissionDescriptor>();
    const f = fixture(() => {
      started.resolve();
      return result.promise;
    });
    const sending = upload(kind);
    await started.promise;
    expect(f.bodies).toEqual([]);
    result.resolve(plain);
    const ready = await sending;
    expect('encryption' in ready).toBe(false);
    expect(f.bodies).toHaveLength(1);
    const body = f.bodies[0];
    const file = body instanceof FormData ? (body.get('file') as File) : (body as File);
    expect(await file.text()).toBe('secret');
  }
);

it.each(['image', 'file'] as const)(
  'sends no %s request body on encrypted or unconfirmed mode, including retry',
  async (kind) => {
    let result: WorkspaceAdmissionDescriptor | Error = new Error('offline');
    const f = fixture(async () => {
      if (result instanceof Error) throw result;
      return result;
    });
    await expect(upload(kind)).rejects.toThrow('offline');
    expect(f.bodies).toEqual([]);
    result = encrypted;
    await expect(upload(kind)).rejects.toThrow('e2ee_attachment_unprotected');
    expect(f.bodies).toEqual([]);
    result = plain;
    await expect(upload(kind)).rejects.toThrow();
    expect(f.bodies).toEqual([]);
  }
);

it.each(['account', 'other-account', 'other-workspace'] as const)(
  'uses only a matching retained plaintext proof (%s)',
  async (proof) => {
    const f = fixture(async () => {
      throw new Error('no live mode');
    });
    retainWorkspaceModeProof(
      localStorage,
      proof === 'other-account' ? 'other-account' : 'account',
      'slug',
      { ...plain, workspaceId: proof === 'other-workspace' ? 'elsewhere' : workspaceId }
    );
    if (proof === 'account')
      await expect(upload('image')).resolves.toMatchObject({ imageId: 'image' });
    else await expect(upload('image')).rejects.toThrow('no live mode');
    expect(f.bodies).toHaveLength(proof === 'account' ? 1 : 0);
  }
);

it('rejects a mode answer completing after account replacement without sending a body', async () => {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<WorkspaceAdmissionDescriptor>();
  const f = fixture(() => {
    started.resolve();
    return result.promise;
  });
  const sending = upload('image');
  const rejected = expect(sending).rejects.toThrow();
  await started.promise;
  f.session.set(authenticated('other-account'));
  result.resolve(plain);
  await rejected;
  expect(f.bodies).toEqual([]);
});

it.each(['image', 'file'] as const)(
  'refuses an old-account %s draft even with a current plaintext proof',
  async (kind) => {
    const f = fixture();
    retainWorkspaceModeProof(localStorage, 'account', 'slug', plain);
    await expect(upload(kind, 'old-account')).rejects.toThrow('attachment_account_changed');
    expect(f.bodies).toEqual([]);
  }
);

it('keeps retained legacy admission usable without another mode request', async () => {
  const f = fixture(async () => {
    throw new Error('offline');
  });
  retainWorkspaceModeProof(localStorage, 'account', 'slug', {
    workspaceId,
    admission: 'legacy-unclassified',
  });
  await expect(upload('image')).resolves.toMatchObject({ imageId: 'image' });
  expect(await ((f.bodies[0] as FormData).get('file') as File).text()).toBe('secret');
});
