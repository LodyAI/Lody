// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContinuationNote } from '../src/components/sessions/session-continuation-note';
import {
  autoDeliveryStatusLabel,
  SessionAutoDeliveryNote,
} from '../src/components/sessions/session-auto-delivery';
import type { SessionContinuationView } from '../src/components/sessions/session-continuation';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n({ language: 'zh-CN' });

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;

function view(patch: Partial<SessionContinuationView> = {}): SessionContinuationView {
  return {
    id: 'wait-1',
    reason: '等 CI 通过后继续',
    phase: 'waiting',
    nextCheckAt: NOW + 20_000,
    ...patch,
  };
}

describe('SessionContinuationNote', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('turns a stopped continuation into a direct nudge with a resume action', () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        withTestI18n(
          <SessionContinuationNote
            view={view({ phase: 'matched', continuation: 'blocked', block: 'stopped' })}
            now={NOW}
            onCancel={() => {}}
            onResume={onResume}
          />,
          testI18n
        )
      );
    });

    expect(container.textContent).toContain('条件已满足，会话已停止');
    expect(container.textContent).toContain('等 CI 通过后继续');
    const resume = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '恢复会话'
    );
    expect(resume).toBeDefined();
    act(() => {
      resume?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onResume).toHaveBeenCalledWith('wait-1');
  });

  it('never announces an uncertain delivery as success', () => {
    act(() => {
      root.render(
        withTestI18n(
          <SessionContinuationNote
            view={view({ phase: 'matched', continuation: 'unknown' })}
            now={NOW}
            onCancel={() => {}}
            onAskAgent={() => {}}
          />,
          testI18n
        )
      );
    });

    expect(container.textContent).toContain('正在确认是否送达');
    expect(container.textContent).not.toContain('完成');
    expect(container.textContent).not.toContain('已继续');
  });

  it('renders Auto delivery with the shared automation nudge when stalled by a stopped session', () => {
    const onResume = vi.fn();
    const onTurnOff = vi.fn();
    act(() => {
      root.render(
        withTestI18n(
          <SessionAutoDeliveryNote
            status={{ state: 'stalled', reason: 'stopped', updatedAt: NOW }}
            now={NOW}
            onResume={onResume}
            onTurnOff={onTurnOff}
          />,
          testI18n
        )
      );
    });

    expect(container.textContent).toContain('停住了，等你：stopped');
    const resume = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '恢复会话'
    );
    expect(resume).toBeDefined();
    act(() => {
      resume?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('renders Auto delivery as the shared automation note chip with an inline action', () => {
    const onTurnOff = vi.fn();
    act(() => {
      root.render(
        withTestI18n(
          <SessionAutoDeliveryNote
            status={{ state: 'fix', attempt: 2, updatedAt: NOW }}
            now={NOW}
            onTurnOff={onTurnOff}
          />,
          testI18n
        )
      );
    });

    const note = container.querySelector('[data-auto-delivery-state="fix"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('修复 CI 中');
    const turnOff = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Turn off'
    );
    expect(turnOff).toBeDefined();
    act(() => {
      turnOff?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });

  it('formats blocked Auto delivery labels for localized, unknown, and omitted block reasons', () => {
    const localizedI18n = createTestI18n({ language: 'zh-CN' });
    localizedI18n.addResourceBundle('zh-CN', 'translation', {
      'sessions.autoDelivery.state.stalled': '停住了，等你：{{reason}}',
      'sessions.autoDelivery.reason.request_blocked': '请求被阻塞，暂无法下发',
      'sessions.autoDelivery.blockReason.permission_denied': '已失去该会话的编辑权限',
    });
    const t = localizedI18n.t.bind(localizedI18n);

    expect(
      autoDeliveryStatusLabel(
        {
          state: 'stalled',
          reason: 'request_blocked',
          blockReason: 'permission_denied',
          updatedAt: NOW,
        },
        t
      )
    ).toBe('停住了，等你：已失去该会话的编辑权限');

    expect(
      autoDeliveryStatusLabel(
        {
          state: 'stalled',
          reason: 'request_blocked',
          blockReason: 'custom_block_code',
          updatedAt: NOW,
        },
        t
      )
    ).toBe('停住了，等你：请求被阻塞，暂无法下发 (custom_block_code)');

    expect(
      autoDeliveryStatusLabel({ state: 'stalled', reason: 'request_blocked', updatedAt: NOW }, t)
    ).toBe('停住了，等你：请求被阻塞，暂无法下发');
  });
});
