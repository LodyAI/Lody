// @vitest-environment jsdom

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AcpAuthenticationInteractionView,
  isAllowedAcpAuthorizationUrl,
} from '../src/components/settings/acp-authentication-panel';
import { initI18n } from '../src/i18n';

describe('AcpAuthenticationAuthorizationView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('allows only HTTP(S) authorization pages', () => {
    expect(isAllowedAcpAuthorizationUrl('https://provider.example.test/oauth')).toBe(true);
    expect(isAllowedAcpAuthorizationUrl('http://127.0.0.1:8787/callback')).toBe(true);
    expect(isAllowedAcpAuthorizationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedAcpAuthorizationUrl('file:///tmp/credential')).toBe(false);
    expect(isAllowedAcpAuthorizationUrl('not a url')).toBe(false);
  });

  it('renders ACP method selection and submits the selected method id', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <AcpAuthenticationInteractionView
          interaction={{
            type: 'methods',
            interactionId: 'methods-1',
            methods: [
              { type: 'agent', id: 'oauth', name: 'Browser OAuth' },
              { type: 'terminal', id: 'terminal', name: 'Terminal login' },
            ],
          }}
          values={{}}
          submitting={false}
          onValuesChange={vi.fn()}
          onSubmit={onSubmit}
        />
      );
    });

    const oauth = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Browser OAuth')
    );
    await act(async () => oauth?.click());
    expect(onSubmit).toHaveBeenCalledWith({ action: 'accept', methodId: 'oauth' });
    expect(container.textContent).not.toContain('Terminal login');
  });

  it('renders text, secret, and select authentication fields without exposing secret input', async () => {
    const onSubmit = vi.fn();
    await act(async () => {
      root.render(
        <AcpAuthenticationInteractionView
          interaction={{
            type: 'form',
            interactionId: 'form-1',
            message: 'Complete provider sign-in',
            form: {
              fields: [
                { id: 'email', type: 'text', label: 'Email', required: true },
                { id: 'token', type: 'secret', label: 'Token', required: true },
                {
                  id: 'account',
                  type: 'select',
                  label: 'Account',
                  required: true,
                  options: [{ value: 'work', label: 'Work' }],
                },
              ],
            },
          }}
          values={{ email: 'user@example.com', token: 'hidden', account: 'work' }}
          submitting={false}
          onValuesChange={vi.fn()}
          onSubmit={onSubmit}
        />
      );
    });

    expect(container.querySelectorAll('input')[0]?.type).toBe('text');
    expect(container.querySelectorAll('input')[1]?.type).toBe('password');
    expect(container.querySelector('[role="combobox"]')?.textContent).toBe('Work');
    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue')
    );
    await act(async () => continueButton?.click());
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'accept',
      content: { email: 'user@example.com', token: 'hidden', account: 'work' },
    });
  });
});
