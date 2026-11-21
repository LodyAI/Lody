// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { resolveSessionPullRequestLinkList, type SessionMeta } from '@lody/shared';

import {
  SessionPullRequestLinksPanel,
  linkSessionPullRequestFromUi,
  unlinkSessionPullRequestFromUi,
} from '../src/components/sessions/session-pr-links';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderPanel(meta: Record<string, unknown>) {
  await initI18n();
  const writes: Array<Record<string, unknown>> = [];
  const state = { meta };
  const write = async (patch: Record<string, unknown>) => {
    writes.push(patch);
    state.meta = { ...state.meta, ...patch };
  };
  const draw = () =>
    root!.render(
      createElement(SessionPullRequestLinksPanel, {
        items: resolveSessionPullRequestLinkList(state.meta as SessionMeta),
        onLink: async (url: string) => {
          const outcome = await linkSessionPullRequestFromUi(state.meta, url, write, () => 1_000);
          draw();
          return outcome;
        },
        onUnlink: async (url: string) => {
          await unlinkSessionPullRequestFromUi(state.meta, url, write, () => 2_000);
          draw();
        },
      })
    );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => draw());
  return { writes, state, container };
}

async function paste(container: HTMLElement, value: string) {
  const input = container.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

describe('linked pull requests panel', () => {
  it('links a pasted GitHub URL as a user record and lists it as pending', async () => {
    const view = await renderPanel({ machineId: 'm1' });
    await paste(view.container, 'github.com/LodyAI/Lody/pull/3019/files');
    expect(view.writes).toEqual([
      { 'prLink:https://github.com/lodyai/lody/pull/3019': { k: 'l', o: 'u', t: 1_000 } },
    ]);
    expect(view.container.textContent).toContain('lodyai/lody#3019');
    expect(view.container.textContent).toContain('Checking');
  });

  it('refuses an unsupported URL without writing', async () => {
    const view = await renderPanel({});
    await paste(view.container, 'https://gitlab.com/a/b/-/merge_requests/1');
    expect(view.writes).toEqual([]);
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      'not supported yet'
    );
  });

  it('unlinks an associated PR, leaving the list without it', async () => {
    const url = 'https://github.com/o/r/pull/12';
    const view = await renderPanel({
      project: { kind: 'github', repoFullName: 'o/r' },
      pullRequests: [{ url, status: 'open' }],
    });
    expect(view.container.textContent).toContain('o/r#12');
    expect(view.container.textContent).toContain('Primary');
    const unlink = view.container.querySelector<HTMLButtonElement>('button[aria-label^="Unlink"]')!;
    await act(async () => unlink.click());
    expect(view.writes).toEqual([
      { 'prLink:https://github.com/o/r/pull/12': { k: 'u', o: 'u', t: 2_000 } },
    ]);
    expect(view.container.textContent).not.toContain('o/r#12');
  });
});
