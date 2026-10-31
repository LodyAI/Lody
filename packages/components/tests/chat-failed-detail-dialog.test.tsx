// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { ChatFailedDetailDialog } from '../src/components/ai-gui/chat-failed-detail-dialog';
import { MessageRowView } from '../src/components/ai-gui/view';
import type { SessionId } from '@lody/shared';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RAW_MESSAGE =
  'Internal error: API Error: 500 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX9m4x2Qv"}';

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

const render = (props: Partial<Parameters<typeof ChatFailedDetailDialog>[0]> = {}) => {
  act(() => {
    root.render(
      createElement(ChatFailedDetailDialog, {
        open: true,
        onOpenChange: () => {},
        title: 'Upstream API error',
        reason: 'acp_upstream_api_error',
        sessionId: 'session-1',
        summary: 'Overloaded',
        message: RAW_MESSAGE,
        ...props,
      })
    );
  });
};

const findButtonByText = (text: string): HTMLButtonElement => {
  const button = Array.from(document.body.querySelectorAll('button')).find((element) =>
    element.textContent?.includes(text)
  );
  if (!button) {
    throw new Error(`No button containing "${text}"`);
  }
  return button as HTMLButtonElement;
};

beforeEach(async () => {
  await initI18n();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('ChatFailedDetailDialog', () => {
  it.each([
    ['sessionCancelFailed', 'Stop request failed', 'Lody will keep trying to end the task.'],
    ['sessionStopTimedOut', 'Stopping took too long', 'Lody is trying to force it to end.'],
    ['sessionTerminationFailed', 'Could not stop the task', 'The task may still be running'],
  ])('keeps %s visible with its raw error and recovery guidance', (source, title, guidance) => {
    act(() => {
      root.render(
        createElement(MessageRowView, {
          sessionId: 'stop-failure-session' as SessionId,
          message: {
            id: 'stop-failure',
            role: 'system',
            timestamp: '2026-10-29T00:00:00.000Z',
            items: [
              {
                type: 'system_notice',
                name: 'agent_warning',
                meta: { source, message: RAW_MESSAGE },
              },
            ],
          },
        })
      );
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(title);
    expect(alert?.textContent).toContain(guidance);
    expect(alert?.textContent).toContain(RAW_MESSAGE);
    expect(alert?.querySelector('dialog, details')).toBeNull();
  });

  it.each(['en', 'zh_CN'])(
    'shows the configuration rejection and recovery guidance in %s',
    async (language) => {
      await initI18n(language);
      act(() =>
        root.render(
          createElement(MessageRowView, {
            sessionId: 'config-failure-session' as SessionId,
            message: {
              id: 'config-failure',
              role: 'system',
              timestamp: '2026-10-31T00:00:00Z',
              items: [
                {
                  type: 'system_notice',
                  name: 'chat_failed',
                  meta: { reason: 'session_config_changed' },
                },
              ],
            },
          })
        )
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        language === 'en'
          ? 'The configuration was updated elsewhere. Resend with the current configuration.'
          : '配置已在别处更新，请用当前配置重新发送。'
      );
    }
  );

  it('shows the raw error verbatim instead of a truncated hover string', () => {
    render();
    expect(document.body.textContent).toContain(RAW_MESSAGE);
  });

  it('copies a report containing the identifying fields and the raw error', async () => {
    render({ code: 'git_executable_not_found', machineId: 'machine-1', agentType: 'claude' });

    await act(async () => {
      findButtonByText('Copy error').click();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]?.[0] as string;
    expect(copied).toContain('Reason: acp_upstream_api_error');
    expect(copied).toContain('Code: git_executable_not_found');
    expect(copied).toContain('Session: session-1');
    expect(copied).toContain('Machine: machine-1');
    expect(copied).toContain(RAW_MESSAGE);
  });

  it('falls back to the readable summary when there is no raw message', () => {
    render({ message: undefined, summary: 'Session is archived' });
    expect(document.body.textContent).toContain('Session is archived');
  });

  it('renders nothing while closed', () => {
    render({ open: false });
    expect(document.body.textContent).not.toContain(RAW_MESSAGE);
  });
});
