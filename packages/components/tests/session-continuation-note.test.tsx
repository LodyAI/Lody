// @vitest-environment jsdom

import { act } from 'react';
import { getDefaultStore } from 'jotai';
import {
  developerModeEnabledAtom,
  sessionContinuationBetaEnabledAtom,
} from '../src/atoms/settings';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContinuationNote } from '../src/components/sessions/session-continuation-note';
import type { SessionContinuationView } from '../src/components/sessions/session-continuation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'zh-CN' },
  }),
}));

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
    getDefaultStore().set(developerModeEnabledAtom, true);
    getDefaultStore().set(sessionContinuationBetaEnabledAtom, true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    getDefaultStore().set(developerModeEnabledAtom, false);
    getDefaultStore().set(sessionContinuationBetaEnabledAtom, false);
    container.remove();
  });

  it('requires both developer mode and the continuation opt-in', () => {
    act(() => {
      getDefaultStore().set(sessionContinuationBetaEnabledAtom, false);
      root.render(<SessionContinuationNote view={view()} now={NOW} onCancel={() => {}} />);
    });
    expect(container.textContent).toBe('');
    act(() => getDefaultStore().set(sessionContinuationBetaEnabledAtom, true));
    expect(container.textContent).toContain('等 CI 通过后继续');
    act(() => getDefaultStore().set(developerModeEnabledAtom, false));
    expect(container.textContent).toBe('');
    expect(getDefaultStore().get(sessionContinuationBetaEnabledAtom)).toBe(true);
  });

  it('renders the Agent sentence and the countdown as one quiet line', () => {
    act(() => {
      root.render(<SessionContinuationNote view={view()} now={NOW} onCancel={() => {}} />);
    });

    expect(container.textContent).toContain('等 CI 通过后继续');
    expect(container.textContent).toContain('等待条件满足');
    expect(container.textContent).toContain('20');
    expect(container.textContent).not.toContain('完成');
    expect(container.querySelector('[data-session-continuation-tone="calm"]')).not.toBeNull();
  });

  it('cancels from the line without opening the card', () => {
    const onCancel = vi.fn();
    act(() => {
      root.render(<SessionContinuationNote view={view()} now={NOW} onCancel={onCancel} />);
    });

    const cancel = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '取消等待'
    );
    expect(cancel).toBeDefined();
    act(() => cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCancel).toHaveBeenCalledWith('wait-1');
  });

  it('turns a stopped continuation into a direct nudge with a resume action', () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        <SessionContinuationNote
          view={view({ phase: 'matched', continuation: 'blocked', block: 'stopped' })}
          now={NOW}
          onCancel={() => {}}
          onResume={onResume}
        />
      );
    });

    expect(container.textContent).toContain('条件已满足，会话已停止');
    expect(container.textContent).toContain('等 CI 通过后继续');
    const resume = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '恢复会话'
    );
    expect(resume).toBeDefined();
    act(() => resume?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onResume).toHaveBeenCalledWith('wait-1');
  });

  it('asks the Agent to look when the checks failed', () => {
    const onAskAgent = vi.fn();
    act(() => {
      root.render(
        <SessionContinuationNote
          view={view({ phase: 'failed' })}
          now={NOW}
          onCancel={() => {}}
          onAskAgent={onAskAgent}
        />
      );
    });

    expect(container.textContent).toContain('自动化执行失败');
    const ask = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('请 Agent 检查')
    );
    expect(ask).toBeDefined();
    act(() => ask?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onAskAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps the phone form to one line', () => {
    act(() => {
      root.render(<SessionContinuationNote view={view()} now={NOW} compact onCancel={() => {}} />);
    });

    expect(container.textContent).toContain('等 CI 通过后继续');
    expect(container.textContent).not.toContain('等待条件满足');
    expect(container.textContent).not.toContain('取消等待');
  });

  it('never announces an uncertain delivery as success', () => {
    act(() => {
      root.render(
        <SessionContinuationNote
          view={view({ phase: 'matched', continuation: 'unknown' })}
          now={NOW}
          onCancel={() => {}}
          onAskAgent={() => {}}
        />
      );
    });

    expect(container.textContent).toContain('正在确认是否送达');
    expect(container.textContent).not.toContain('完成');
    expect(container.textContent).not.toContain('已继续');
  });
});
