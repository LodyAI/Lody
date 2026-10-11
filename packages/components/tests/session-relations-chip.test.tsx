// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Provider } from 'jotai';
import type { SessionMeta } from '@lody/shared';
import { SessionRelationsChip } from '../src/components/sessions/session-relations-chip';

vi.mock('../src/hooks/use-session-actions', () => ({ useSessionActions: () => ({}) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

it('requires confirmation, disables duplicate submits, and exposes restore only after the stop succeeds', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  let complete!: () => void;
  const request = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const accepted: boolean[] = [];
  const session = {
    id: 'root',
    machineId: 'machine',
    userId: 'user',
    cliType: 'builtin',
    agentType: 'codex',
    title: 'Work',
    createdAt: '2026-10-11T00:00:00Z',
  } as SessionMeta;
  function Harness() {
    const [stopped, setStopped] = useState(false);
    return (
      <Provider>
        <SessionRelationsChip
          tree={{ session: { ...session, collaborationStopped: stopped }, tabs: [], children: [] }}
          currentSessionId={session.id}
          onOpenSession={() => {}}
          defaultOpen
          onSetCollaborationStopped={async (next) => {
            if (next) await request;
            accepted.push(next);
            setStopped(next);
          }}
        />
      </Provider>
    );
  }
  await act(async () => root.render(createElement(Harness)));
  const button = (name: string) => {
    const match = [...document.querySelectorAll('button')].find(
      (item) => item.textContent === name
    );
    if (!match) throw new Error(`Missing button: ${name}`);
    return match;
  };
  await act(async () => button('Stop all conversation collaboration').click());
  expect(document.body.textContent).toContain(
    'This will stop all conversations in the conversation tree.'
  );
  await act(async () => button('Cancel').click());
  expect(accepted).toEqual([]);
  await act(async () => button('Stop all conversation collaboration').click());
  await act(async () => button('Confirm').click());
  expect(button('Confirm').disabled).toBe(true);
  expect(accepted).toEqual([]);
  await act(async () => {
    complete();
    await request;
  });
  expect(accepted).toEqual([true]);
  expect(document.body.textContent).toContain('Collaboration stopped.');
  await act(async () => button('Restore collaboration').click());
  expect(accepted).toEqual([true, false]);
  expect(button('Stop all conversation collaboration')).toBeDefined();
});
