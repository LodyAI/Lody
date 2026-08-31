// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineId } from '@lody/shared';

import {
  AcpAuthenticationAuthorizationView,
  AcpAuthenticationInteractionView,
  areAcpAuthenticationTargetsEqual,
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

  it('treats launch, runtime, and environment changes as a different authentication target', () => {
    const target = {
      machineId: 'machine-1' as MachineId,
      cliType: 'custom' as const,
      agentType: 'provider',
      customAcp: { command: 'provider-acp', args: ['serve'] },
      runtimeOverrides: { codexPath: '/opt/codex' },
      env: { PROVIDER_TOKEN: 'first' },
    };

    expect(
      areAcpAuthenticationTargetsEqual(target, {
        ...target,
        customAcp: { command: 'provider-acp', args: ['serve'] },
        runtimeOverrides: { codexPath: '/opt/codex' },
        env: { PROVIDER_TOKEN: 'first' },
      })
    ).toBe(true);
    expect(
      areAcpAuthenticationTargetsEqual(target, {
        ...target,
        env: { PROVIDER_TOKEN: 'second' },
      })
    ).toBe(false);
    expect(
      areAcpAuthenticationTargetsEqual(target, {
        ...target,
        customAcp: { command: 'other-acp', args: ['serve'] },
      })
    ).toBe(false);
    expect(
      areAcpAuthenticationTargetsEqual(target, {
        ...target,
        runtimeOverrides: { codexPath: '/usr/local/bin/codex' },
      })
    ).toBe(false);
  });

  it('shows and exposes the device authorization actions without terminal output', async () => {
    const onOpenAuthorization = vi.fn();
    const onCopyUserCode = vi.fn();

    await act(async () => {
      root.render(
        <AcpAuthenticationAuthorizationView
          provider="ChatGPT"
          authorization={{
            authorizationUrl: 'https://auth.openai.com/codex/device',
            userCode: 'DQGR-SB46E',
            expiresInSeconds: 900,
          }}
          authorizationCode=""
          authorizationCodeSubmitted={false}
          submittingAuthorizationCode={false}
          userCodeCopied={false}
          onOpenAuthorization={onOpenAuthorization}
          onCopyUserCode={onCopyUserCode}
          onAuthorizationCodeChange={vi.fn()}
          onSubmitAuthorizationCode={vi.fn()}
        />
      );
    });

    expect(container.textContent).toContain('Finish signing in to ChatGPT');
    expect(container.textContent).toContain('DQGR-SB46E');
    expect(container.textContent).toContain('15 minutes');
    expect(container.querySelector('pre')).toBeNull();

    const buttons = Array.from(container.querySelectorAll('button'));
    const openButton = buttons.find((button) => button.textContent?.includes('Open authorization'));
    const copyButton = buttons.find((button) => button.textContent?.includes('Copy code'));
    expect(openButton).toBeDefined();
    expect(copyButton).toBeDefined();

    await act(async () => {
      openButton?.click();
      copyButton?.click();
    });
    expect(onOpenAuthorization).toHaveBeenCalledOnce();
    expect(onCopyUserCode).toHaveBeenCalledOnce();
  });

  it('submits the Claude browser-returned code from the Lody form', async () => {
    const onSubmitAuthorizationCode = vi.fn();

    await act(async () => {
      root.render(
        <AcpAuthenticationAuthorizationView
          provider="Claude"
          authorization={{
            authorizationUrl: 'https://claude.com/cai/oauth/authorize?client_id=test',
            acceptsAuthorizationCode: true,
          }}
          authorizationCode="browser-returned-code"
          authorizationCodeSubmitted={false}
          submittingAuthorizationCode={false}
          userCodeCopied={false}
          onOpenAuthorization={vi.fn()}
          onCopyUserCode={vi.fn()}
          onAuthorizationCodeChange={vi.fn()}
          onSubmitAuthorizationCode={onSubmitAuthorizationCode}
        />
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input?.value).toBe('browser-returned-code');
    const continueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Continue')
    );
    expect(continueButton).toBeDefined();

    await act(async () => {
      continueButton?.click();
    });
    expect(onSubmitAuthorizationCode).toHaveBeenCalledOnce();
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
    expect(container.querySelector('select')?.value).toBe('work');
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
