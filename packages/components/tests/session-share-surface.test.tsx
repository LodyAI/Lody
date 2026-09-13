// @vitest-environment jsdom
import { act, StrictMode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionHistory } from '@lody/shared';
import { SessionShareSurface } from '../src/components/sharing/session-share-page';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));
vi.mock('../src/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: () => {} }),
  nextCycledTheme: () => 'dark',
}));
// Keep the real page and row-building path; only replace virtual layout, which
// needs browser measurements. Assert visible message content, not callback counts.
vi.mock('../src/components/ai-gui/view', () => ({
  SessionChatStreamView: ({
    items,
    emptyState,
  }: ComponentProps<typeof import('../src/components/ai-gui/view').SessionChatStreamView>) => (
    <section>
      {items.map((item) =>
        item.type === 'message' ? (
          <article key={item.message.id} data-message={item.message.id}>
            {item.message.items.map((content, index) =>
              content.type === 'text' ? <p key={index}>{content.text}</p> : null
            )}
          </article>
        ) : item.type === 'empty' ? (
          <div key="empty">{emptyState}</div>
        ) : null
      )}
    </section>
  ),
  MessageRowView: () => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const turn = (text: string): SessionHistory => ({
  id: 'answer',
  role: 'assistant',
  timestamp: '2026-09-12T00:00:00Z',
  fileDiff: [],
  items: [{ type: 'text', text }],
});
async function render(history: readonly SessionHistory[], sessionId = 'main') {
  await act(async () =>
    root.render(
      <StrictMode>
        <SessionShareSurface
          manifest={{
            shareId: 'fixture',
            rootSessionId: 'main',
            workspaceName: 'Fixture',
            scopeVersion: 1,
            credentialVersion: 1,
            validUntil: 2_000_000_000_000,
            targets: [
              { sessionId: 'main', title: 'Main' },
              { sessionId: 'other', title: 'Other' },
            ],
          }}
          sessionId={sessionId}
          status="ready"
          snapshot={{ status: 'live', history }}
          onSelect={() => {}}
          attachmentAccess={{
            read: async () => {
              throw new Error('No attachment read expected');
            },
          }}
        />
      </StrictMode>
    )
  );
}

it('shows the initial shared answer and its streamed replacement', async () => {
  await render([turn('Visible answer')]);
  expect(container.querySelector('[data-message="answer"]')?.textContent).toBe('Visible answer');
  await render([turn('Visible answer, completed')]);
  expect(container.querySelector('[data-message="answer"]')?.textContent).toBe(
    'Visible answer, completed'
  );
  expect(container.querySelectorAll('[data-message]')).toHaveLength(1);
});

it('clears old rows when the target becomes empty and shows the new target', async () => {
  await render([turn('Old target')]);
  await render([], 'other');
  expect(container.querySelector('[data-message]')).toBeNull();
  expect(container.textContent).toContain('No messages yet');
  await render([turn('New target')], 'other');
  expect(container.querySelector('[data-message="answer"]')?.textContent).toBe('New target');
  expect(container.textContent).not.toContain('Old target');
});
