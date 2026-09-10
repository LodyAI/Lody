// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PermissionRequestCard } from '../src/components/sessions/floating-permission-request';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const options = [
  { optionId: 'implement', name: 'Implement plan', kind: 'allow_once' as const },
  { optionId: 'keep-planning', name: 'Keep planning', kind: 'reject_once' as const },
];

describe('PermissionRequestCard disclosure', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const renderCard = async (defaultCollapsed = false) => {
    await act(async () => {
      root.render(
        <PermissionRequestCard
          options={options}
          defaultCollapsed={defaultCollapsed}
          onSelect={() => undefined}
        />
      );
    });
  };

  it('keeps ordinary and composer permission cards expanded', async () => {
    await renderCard();

    expect(container.textContent).toContain('Implement plan');
    expect(container.querySelector('[aria-expanded]')).toBeNull();
  });

  it('can start collapsed and reveal the in-conversation options', async () => {
    await renderCard(true);

    const disclosure = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    const implementOption = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Implement plan'
    );
    expect(disclosure?.textContent).toContain('Permission Required');
    expect(implementOption?.closest('[hidden]')).not.toBeNull();

    await act(async () => disclosure?.click());

    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
    expect(implementOption?.closest('[hidden]')).toBeNull();
  });
});
