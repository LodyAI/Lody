// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContinuationTweaks } from '../src/components/sessions/session-continuation-tweaks';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'zh-CN' },
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const VALUE = {
  recoverCapacity: false,
  archiveAfterMerge: true,
  compactWhenIdle: false,
};

describe('SessionContinuationTweaks', () => {
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

  it('reports the switch that changed, not a whole settings object', () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<SessionContinuationTweaks value={VALUE} onChange={onChange} />);
    });

    const recover = container.querySelector(
      '[data-session-continuation-tweak="recoverCapacity"] button'
    );
    expect(recover).not.toBeNull();
    act(() => {
      recover?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('recoverCapacity', true);
  });

  it('disables an unsupported behavior and states the reason', () => {
    act(() => {
      root.render(
        <SessionContinuationTweaks
          value={VALUE}
          onChange={() => {}}
          capabilities={{
            recoverCapacity: {
              supported: false,
              reason: '当前 Provider 没有可用的额度窗口',
            },
          }}
        />
      );
    });

    const recover = container.querySelector(
      '[data-session-continuation-tweak="recoverCapacity"] button'
    );
    expect(
      recover?.hasAttribute('disabled') || recover?.getAttribute('aria-disabled') === 'true'
    ).toBe(true);
    expect(container.textContent).toContain('当前 Provider 没有可用的额度窗口');
  });
});
