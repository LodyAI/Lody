// @vitest-environment jsdom
import { act } from 'react';
import { createStore, Provider } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { bugReportDialogOpenAtom, userAtom } from '@/atoms';
import { BugReportDialogContainer } from '../src/components/bug-report/bug-report-dialog-container';
import { click, mount, one, press, step, type Mounted } from '../../ui/test/dom';

vi.mock('@/atoms', async () => {
  const { atom } = await import('jotai');
  return {
    bugReportDialogOpenAtom: atom(true),
    currentWorkspaceIdAtom: atom('workspace'),
    userAtom: atom({ id: 'reporter' }),
  };
});
vi.mock('@/atoms/runtime', async () => {
  const { atom } = await import('jotai');
  return { runtimeAtom: atom(null) };
});
vi.mock('@/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({ machines: new Map() }),
}));
vi.mock('@/hooks/use-machine-online-status', () => ({ useOnlineMachineIds: () => new Set() }));
vi.mock('@/lib/auth-bootstrap', () => ({ readStoredAuthToken: () => 'session' }));
vi.mock('@/lib/chat-landing-defaults', () => ({ readChatLandingDefaults: () => null }));
vi.mock('@/lib/cloud-http-port', () => ({ requireCloudAuthBaseUrl: () => 'https://auth.test' }));
vi.mock('@/lib/client-log', () => ({
  buildClientLogUploadWithin: async () => null,
  recordClientLog: () => {},
}));
vi.mock('@/lib/client-diagnostics', () => ({
  collectClientDiagnostics: async () => 'client environment and errors',
}));
vi.mock('@/lib/electron', () => ({
  isElectronRenderer: () => false,
  isMacOSElectronRenderer: () => false,
  isWindowsElectronRenderer: () => false,
  useElectronFullscreen: () => false,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

async function setup() {
  const requests: Array<{
    body: unknown;
    signal: AbortSignal | null | undefined;
    respond: (response: Response) => void;
  }> = [];
  let created = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    if (url.endsWith('/create')) {
      created += 1;
      return Promise.resolve(Response.json({ bugReportId: `report-${created}` }));
    }
    if (!url.endsWith('/client-diagnostics')) throw new Error(`Unexpected URL: ${url}`);
    // Deliberately ignore abort: a late adapter/server response must stay retired.
    return new Promise<Response>((respond) => {
      requests.push({ body: JSON.parse(String(init.body)), signal: init.signal, respond });
    });
  });
  const store = createStore();
  mounted = await mount(
    <Provider store={store}>
      <button data-outside="">normal application action</button>
      <BugReportDialogContainer />
    </Provider>
  );
  const submit = async () => {
    await step(() => {
      const textarea = one('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        'broken UI'
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Submit report'));
  };
  return { store, requests, submit, created: () => created };
}

it.each(['Close', 'cross', 'Escape', 'backdrop'])(
  'shows the saved ID and permits %s while diagnostics never respond',
  async (dismiss) => {
    const { store, requests, submit } = await setup();
    await submit();
    expect(document.body.textContent).toContain('report-1');
    expect(document.body.textContent).toContain('Client diagnostics are uploading');
    if (dismiss === 'Close') await click(button('Close'));
    else if (dismiss === 'cross') await click(one('[role="dialog"] button[aria-label="Close"]'));
    else if (dismiss === 'Escape') await press('Escape');
    else await click(one('[role="presentation"][data-open]'));
    expect(store.get(bugReportDialogOpenAtom)).toBe(false);
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect(one('[data-outside]').closest('[aria-hidden="true"], [inert]')).toBeNull();
  }
);

it('keeps the ID visible and retries only the same attachment after failure', async () => {
  const { requests, submit, created } = await setup();
  await submit();
  await act(async () => requests[0]?.respond(new Response(null, { status: 502 })));
  expect(document.body.textContent).toContain('report-1');
  expect(document.body.textContent).toContain('Your report is saved');
  await click(button('Retry diagnostics'));
  expect(document.body.textContent).toContain('report-1');
  expect(requests.map((request) => request.body)).toEqual([
    {
      workspaceId: 'workspace',
      bugReportId: 'report-1',
      diagnostics: 'client environment and errors',
    },
    {
      workspaceId: 'workspace',
      bugReportId: 'report-1',
      diagnostics: 'client environment and errors',
    },
  ]);
  expect(created()).toBe(1);
  await act(async () => requests[1]?.respond(Response.json({ attached: true })));
  expect(document.body.textContent).toContain('Client diagnostics were uploaded.');
});

it('ignores a closed upload response after another report starts', async () => {
  const { store, requests, submit } = await setup();
  await submit();
  await click(button('Close'));
  await act(async () => store.set(bugReportDialogOpenAtom, true));
  await submit();
  expect(document.body.textContent).toContain('report-2');
  await act(async () => requests[0]?.respond(Response.json({ attached: true })));
  expect(document.body.textContent).toContain('report-2');
  expect(document.body.textContent).not.toContain('report-1');
  expect(document.body.textContent).toContain('Client diagnostics are uploading');
});

it.each(['account loss', 'unmount'])('cancels and retires diagnostics on %s', async (retire) => {
  const { store, requests, submit } = await setup();
  await submit();
  if (retire === 'account loss') await act(async () => store.set(userAtom, null));
  else {
    await mounted?.unmount();
    mounted = undefined;
  }
  expect(requests[0]?.signal?.aborted).toBe(true);
  await act(async () => requests[0]?.respond(Response.json({ attached: true })));
  expect(document.body.textContent).not.toContain('report-1');
});
