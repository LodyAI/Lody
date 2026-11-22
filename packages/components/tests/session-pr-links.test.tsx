// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { resolveSessionPullRequestLinkList, type SessionMeta } from '@lody/shared';

import {
  SessionPullRequestLinksPanel,
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
  return { writes, container };
}

describe('linked pull requests panel', () => {
  const url = 'https://github.com/o/r/pull/12';

  it('unlinks a PR from its row menu as a user record, leaving the list without it', async () => {
    const view = await renderPanel({
      project: { kind: 'github', repoFullName: 'o/r' },
      pullRequests: [{ url, status: 'open' }],
    });
    expect(view.container.textContent).toContain('o/r#12');
    expect(view.container.textContent).toContain('Primary');
    const trigger = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions: o/r#12"]'
    )!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    const items = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      'Open on GitHub',
      'Copy link',
      'Unlink',
    ]);
    await act(async () => items[2]!.click());
    expect(view.writes).toEqual([
      { 'prLink:https://github.com/o/r/pull/12': { k: 'u', o: 'u', t: 2_000 } },
    ]);
    expect(view.container.textContent).not.toContain('o/r#12');
  });

  it('shows agent- or shim-written links the machine has not confirmed, with their reason', async () => {
    const view = await renderPanel({
      'prLink:https://github.com/o/r/pull/77': { k: 'l', o: 's', t: 1 },
      'prLink:https://github.com/o/r/pull/78': { k: 'l', o: 'a', t: 2 },
      'prLinkCheck:https://github.com/o/r/pull/78': { r: 'u', t: 3 },
      'prLink:https://gitlab.com/a/b/-/merge_requests/1': { k: 'l', o: 'a', t: 4 },
    });
    const text = view.container.textContent ?? '';
    expect(text).toContain('o/r#77');
    expect(text).toContain('Checking');
    expect(text).toContain('GitHub did not return this pull request');
    expect(text).toContain('This provider is not supported yet.');
  });
});
