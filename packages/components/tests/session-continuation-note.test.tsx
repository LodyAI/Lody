// @vitest-environment jsdom

// @vitest-environment jsdom
import { act } from 'react';
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
    act(() => {
      resume?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onResume).toHaveBeenCalledWith('wait-1');
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
