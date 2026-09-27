// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GitHubReviewErrorNotice } from '../src/components/sessions/github-review-error-notice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

it('keeps an identity failure visible and offers an explicit retry', async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  const root = createRoot(container);
  const onRetry = vi.fn();
  try {
    await act(async () =>
      root.render(
        <GitHubReviewErrorNotice
          message="Repository identity cannot be verified"
          onRetry={onRetry}
        />
      )
    );
    expect(container.textContent).toContain('Repository identity cannot be verified');
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Retry');
    expect(onRetry).not.toHaveBeenCalled();
    await act(async () => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Repository identity cannot be verified');
  } finally {
    await act(async () => root.unmount());
  }
});
