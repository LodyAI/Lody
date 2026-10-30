// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { buildConversationMarkdown, type WorkspaceId, type SessionMeta } from '@lody/shared';
import { PlatformContext } from '@lody/platform/react';
import {
  createStore as createPlatformStore,
  type MutableStore,
  type PlatformSessionState,
} from '@lody/platform';
import { TEST_CLOUD_PLATFORM } from './test-platform';
import { userAtom } from '../src/atoms';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import {
  workspaceContentModeAtom,
  type WorkspaceContentMode,
} from '../src/atoms/workspace-content-mode';
import { usePlaintextCopy } from '../src/hooks/use-plaintext-copy';
import { initI18n } from '../src/i18n';
import { ChatShareImageDialog } from '../src/components/sessions/chat-share-image-dialog';
import { ForceMobileLayoutProvider } from '../src/hooks/use-mobile';
import { WorkspaceRouteTargetProvider } from '../src/providers/workspace-route-target';

const png = vi.hoisted(() => ({
  captured: [] as string[],
  saved: [] as { fileName: string; content: string }[],
  cancelSave: false,
  onCapture: null as (() => void) | null,
}));
vi.mock('@zumer/snapdom', () => ({
  snapdom: {
    toBlob: async (element: HTMLElement) => {
      const content = element.textContent ?? '';
      png.captured.push(content);
      png.onCapture?.();
      return new NodeBlob([content], { type: 'image/png' });
    },
  },
}));
vi.mock('../src/lib/image-preview-export', () => ({
  getImagePreviewExportBridge: () => ({
    saveAs: async ({ fileName, bytes }: { fileName: string; bytes: ArrayBuffer }) => {
      if (png.cancelSave) return { saved: false, canceled: true };
      png.saved.push({ fileName, content: new TextDecoder().decode(bytes) });
      return { saved: true };
    },
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let run: ReturnType<typeof usePlaintextCopy>['run'];
let platformSession: MutableStore<PlatformSessionState>;
const cloudPlatform = {
  ...TEST_CLOUD_PLATFORM,
  identity: {
    ...TEST_CLOUD_PLATFORM.identity,
    session: {
      get: () => platformSession.get(),
      subscribe: (listener: () => void) => platformSession.subscribe(listener),
    },
  },
};
const artifacts: string[] = [];
const selected = [
  {
    id: 'selected',
    role: 'user' as const,
    items: [{ type: 'text' as const, text: 'selected-copy-sentinel' }],
  },
];
const runtime = (contentMode: 'plaintext' | 'e2ee' = 'e2ee') =>
  ({
    workspaceId: 'workspace' as WorkspaceId,
    workspaceSlug: 'alpha',
    accountId: 'owner',
    contentMode,
    waitForContentAdmission: async () => {},
  }) as WorkspaceRuntime;
const mode = (contentMode: 'plaintext' | 'e2ee', genesisHash = 'a'.repeat(64)) =>
  ({
    accountId: 'owner',
    workspaceId: 'workspace',
    workspaceSlug: 'alpha',
    descriptor: {
      workspaceId: 'workspace',
      contentMode,
      contentModeVersion: 1,
      ...(contentMode === 'e2ee'
        ? { genesisHash, cryptoOrgId: 'synthetic-crypto-org', activation: 'control-only' }
        : {}),
    },
  }) as WorkspaceContentMode;

beforeEach(async () => {
  platformSession = createPlatformStore<PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'owner' },
  });
  await initI18n('en');
  artifacts.length = 0;
  png.captured = [];
  png.saved = [];
  png.cancelSave = false;
  png.onCapture = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Harness({ host, source }: { host: WorkspaceRuntime; source: unknown }) {
  const copy = usePlaintextCopy(host, source);
  run = copy.run;
  return copy.confirmation;
}
function setup(host = runtime(), local = false) {
  const store = createStore();
  store.set(userAtom, { id: 'owner' } as never);
  store.set(runtimeAtom, host);
  store.set(workspaceContentModeAtom, mode(host.contentMode!) as never);
  const render = (source: unknown = selected, slug = 'alpha') => {
    root.render(
      <PlatformContext.Provider value={{ ...cloudPlatform, kind: local ? 'local' : 'cloud' }}>
        <Provider store={store}>
          <WorkspaceRouteTargetProvider slug={slug}>
            <Harness host={host} source={source} />
          </WorkspaceRouteTargetProvider>
        </Provider>
      </PlatformContext.Provider>
    );
  };
  return { store, render };
}
async function copyText(assertCurrent: () => void) {
  const { markdown } = buildConversationMarkdown({
    history: selected,
    title: 'Selected conversation',
  });
  assertCurrent();
  artifacts.push(markdown);
  return markdown;
}
async function answer(text: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === text);
  expect(button, document.body.textContent ?? '').toBeDefined();
  await act(async () => button!.click());
}

it.each(['en', 'zh_CN'])(
  'requires a fresh explicit decrypted-copy choice in %s',
  async (language) => {
    await initI18n(language);
    const { render } = setup();
    await act(async () => render());
    let pending!: ReturnType<typeof run>;
    await act(async () => {
      pending = run(copyText);
    });
    expect(artifacts).toEqual([]);
    await answer(language === 'en' ? 'Cancel' : '取消');
    expect(await pending).toBeUndefined();
    expect(artifacts).toEqual([]);
    await act(async () => {
      pending = run(copyText);
    });
    expect(artifacts).toEqual([]);
    await answer(language === 'en' ? 'Create decrypted copy' : '创建解密副本');
    await pending;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toContain('selected-copy-sentinel');
    expect(artifacts[0]).toContain('Selected conversation');
    await act(async () => {
      pending = run(copyText);
    });
    expect(artifacts).toHaveLength(1);
    await answer(language === 'en' ? 'Cancel' : '取消');
    await pending;
  }
);

it('keeps unknown mode pending without producing a copy, then preserves ordinary admission', async () => {
  const admission = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const host = runtime('plaintext');
  host.waitForContentAdmission = () => {
    waiting.resolve();
    return admission.promise;
  };
  const { store, render } = setup(host);
  store.set(workspaceContentModeAtom, null);
  await act(async () => render());
  let pending!: ReturnType<typeof run>;
  await act(async () => {
    pending = run(copyText);
    await waiting.promise;
  });
  expect(artifacts).toEqual([]);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => {
    store.set(workspaceContentModeAtom, mode('plaintext') as never);
    admission.resolve();
    await pending;
  });
  expect(artifacts[0]).toContain('selected-copy-sentinel');
});

it.each(['account', 'runtime', 'admission', 'genesis', 'route', 'selection'] as const)(
  'rejects a late approved copy after %s changes',
  async (change) => {
    const host = runtime();
    const { store, render } = setup(host);
    await act(async () => render());
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    let pending!: ReturnType<typeof run>;
    await act(async () => {
      pending = run(async (assertCurrent) => {
        reading.resolve();
        await read.promise;
        return copyText(assertCurrent);
      });
    });
    await answer('Create decrypted copy');
    await reading.promise;
    await act(async () => {
      if (change === 'account') store.set(userAtom, { id: 'other' } as never);
      else if (change === 'runtime') store.set(runtimeAtom, runtime());
      else if (change === 'admission') store.set(workspaceContentModeAtom, null);
      else if (change === 'genesis') {
        store.set(workspaceContentModeAtom, mode('e2ee', 'b'.repeat(64)));
      } else if (change === 'route') render(selected, 'different-route');
      else render([{ id: 'different-selection' }]);
    });
    await act(async () => {
      read.resolve();
      await pending;
    });
    expect(artifacts).toEqual([]);
  }
);

it('cancels an unanswered choice on unmount and allows an independent later copy', async () => {
  const host = runtime();
  const { render } = setup(host);
  await act(async () => render());
  let pending!: ReturnType<typeof run>;
  await act(async () => {
    pending = run(copyText);
  });
  await act(async () => root.render(null));
  expect(await pending).toBeUndefined();
  expect(artifacts).toEqual([]);
  await act(async () => render());
  await act(async () => {
    pending = run(copyText);
  });
  await answer('Create decrypted copy');
  await pending;
  expect(artifacts).toHaveLength(1);
});

it('releases a cancelled UI waiter while the obsolete read drains independently', async () => {
  const { render } = setup();
  await act(async () => render());
  const read = Promise.withResolvers<void>();
  let oldFinished = false;
  let old!: ReturnType<typeof run>;
  await act(async () => {
    old = run(async (assertCurrent) => {
      await read.promise;
      return copyText(assertCurrent);
    });
    void old.then(() => {
      oldFinished = true;
    });
  });
  await answer('Create decrypted copy');
  await act(async () => render('replacement-selection'));
  let next!: ReturnType<typeof run>;
  await act(async () => {
    next = run(copyText);
  });
  await answer('Create decrypted copy');
  await next;
  try {
    expect(oldFinished).toBe(true);
    expect(artifacts).toHaveLength(1);
  } finally {
    await act(async () => {
      read.resolve();
      await old;
    });
  }
  expect(artifacts).toHaveLength(1);
});

it('retains local export behavior without cloud mode or account', async () => {
  const { store, render } = setup(runtime('plaintext'), true);
  store.set(userAtom, null);
  store.set(workspaceContentModeAtom, null);
  await act(async () => render());
  await act(async () => {
    await run(copyText);
  });
  expect(artifacts[0]).toContain('selected-copy-sentinel');
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it('retains a trusted legacy admission without treating it as plaintext classification', async () => {
  const { store, render } = setup(runtime('plaintext'));
  const legacy: WorkspaceContentMode = {
    accountId: 'owner',
    workspaceId: 'workspace',
    workspaceSlug: 'alpha',
    descriptor: { workspaceId: 'workspace', admission: 'legacy-unclassified' },
  };
  store.set(workspaceContentModeAtom, legacy);
  await act(async () => render());
  await act(async () => {
    await run(copyText);
  });
  expect(artifacts[0]).toContain('selected-copy-sentinel');
  expect(store.get(workspaceContentModeAtom)).toBe(legacy);
});

it('does not retain one failed admission as a permanent copy failure', async () => {
  const host = runtime();
  host.waitForContentAdmission = async () => {
    throw new Error('workspace_access_denied');
  };
  const { render } = setup(host);
  await act(async () => render());
  await act(async () => {
    await expect(run(copyText)).rejects.toThrow('workspace_access_denied');
  });
  expect(artifacts).toEqual([]);
  host.waitForContentAdmission = async () => {};
  let pending!: ReturnType<typeof run>;
  await act(async () => {
    pending = run(copyText);
  });
  await answer('Create decrypted copy');
  await pending;
  expect(artifacts).toHaveLength(1);
});

it('rechecks runtime retirement before transcript output even while admission atoms remain unchanged', async () => {
  const retired = new AbortController();
  const host = runtime();
  host.waitForContentAdmission = async () => retired.signal.throwIfAborted();
  const { store, render } = setup(host);
  await act(async () => render());
  const reading = Promise.withResolvers<void>();
  const read = Promise.withResolvers<void>();
  let pending!: ReturnType<typeof run>;
  await act(async () => {
    pending = run(async (assertCurrent, admitOutput) => {
      reading.resolve();
      await read.promise;
      await admitOutput();
      return copyText(assertCurrent);
    });
  });
  await answer('Create decrypted copy');
  await reading.promise;
  retired.abort();
  await act(async () => {
    read.resolve();
    await pending;
  });
  expect(store.get(runtimeAtom)).toBe(host);
  expect(store.get(workspaceContentModeAtom)?.descriptor).toMatchObject({ contentMode: 'e2ee' });
  expect(artifacts).toEqual([]);
});

it('does not save the actual PNG after runtime retirement precedes its UI publication', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: async () => {},
  });
  const retired = new AbortController();
  const host = runtime();
  host.waitForContentAdmission = async () => retired.signal.throwIfAborted();
  const { store } = setup(host);
  const completed: string[] = [];
  png.onCapture = () => retired.abort();
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={cloudPlatform}>
        <Provider store={store}>
          <ChatShareImageDialog
            open
            onOpenChange={() => {}}
            sourceRuntime={host}
            session={{ id: 'selected', title: 'Selected conversation' } as SessionMeta}
            messages={[{ id: 'selected', role: 'user', text: 'selected-copy-sentinel' }]}
            onCompleted={(action) => {
              completed.push(action);
            }}
          />
        </Provider>
      </PlatformContext.Provider>
    )
  );
  await answer('Export PNG');
  await answer('Create decrypted copy');
  expect(store.get(runtimeAtom)).toBe(host);
  expect(png.captured).toHaveLength(1);
  expect(png.saved).toEqual([]);
  expect(completed).toEqual([]);
});

it.each([false, true])(
  'guards the actual PNG dialog and preserves cancelled selection (mobile: %s)',
  async (mobile) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: async () => {},
    });
    const host = runtime();
    const { store } = setup(host);
    const completed: string[] = [];
    const session = {
      id: 'selected',
      title: 'Selected conversation',
      cliType: 'builtin',
      agentType: 'claude',
    } as SessionMeta;
    const outside = document.createElement('div');
    outside.textContent = 'outside-copy-sentinel';
    await act(async () =>
      root.render(
        <PlatformContext.Provider value={cloudPlatform}>
          <Provider store={store}>
            <ForceMobileLayoutProvider force={mobile}>
              <ChatShareImageDialog
                open
                onOpenChange={() => {}}
                sourceRuntime={host}
                session={session}
                messages={[{ id: 'selected', role: 'user', text: 'selected-copy-sentinel' }]}
                onCompleted={(action) => {
                  completed.push(action);
                }}
              />
            </ForceMobileLayoutProvider>
          </Provider>
        </PlatformContext.Provider>
      )
    );
    container.append(outside);
    await answer('Export PNG');
    expect(png.captured).toEqual([]);
    expect(png.saved).toEqual([]);
    await answer('Cancel');
    expect(completed).toEqual([]);
    expect(png.captured).toEqual([]);
    expect(document.body.textContent).toContain('selected-copy-sentinel');
    png.cancelSave = true;
    await answer('Export PNG');
    await answer('Create decrypted copy');
    expect(png.captured).toHaveLength(1);
    expect(png.saved).toEqual([]);
    expect(completed).toEqual([]);
    expect(document.body.textContent).toContain('selected-copy-sentinel');
    png.cancelSave = false;
    await answer('Export PNG');
    await answer('Create decrypted copy');
    expect(completed).toEqual(['saved']);
    expect(png.saved).toHaveLength(1);
    expect(png.saved[0].fileName).toBe('Selected conversation.png');
    expect(png.saved[0].content).toContain('selected-copy-sentinel');
    expect(png.saved[0].content).not.toContain('outside-copy-sentinel');
  }
);

it('allows an approved local encrypted copy during uncertain offline authentication', async () => {
  const { store, render } = setup();
  platformSession.set({ status: 'unauthenticated', uncertain: true });
  store.set(userAtom, null);
  await act(async () => render());
  let pending!: ReturnType<typeof run>;
  await act(async () => {
    pending = run(copyText);
  });
  expect(artifacts).toEqual([]);
  await answer('Create decrypted copy');
  await pending;
  expect(artifacts[0]).toContain('selected-copy-sentinel');
});

it.each(['signed-out', 'different-account'] as const)(
  'rejects a stale approved runtime after %s before bootstrap atoms change',
  async (state) => {
    const host = runtime();
    const { store, render } = setup(host);
    await act(async () => render());
    platformSession.set(
      state === 'signed-out'
        ? { status: 'unauthenticated' }
        : { status: 'authenticated', user: { id: 'other' } }
    );
    let pending!: ReturnType<typeof run>;
    await act(async () => {
      pending = run(copyText);
    });
    if (
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Create decrypted copy'
      )
    )
      await answer('Create decrypted copy');
    await pending;
    expect(store.get(runtimeAtom)).toBe(host);
    expect(store.get(userAtom)?.id).toBe('owner');
    expect(artifacts).toEqual([]);
  }
);
