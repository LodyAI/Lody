// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageContent } from '@lody/shared';

import { PermissionPrompt } from '../src/components/sessions/floating-permission-request';
import { resolvePermissionSubject } from '../src/lib/permission-request-presentation';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type ToolCall = Extract<MessageContent, { type: 'tool_call' }>;
type Permission = NonNullable<ToolCall['permissionRequest']>;

const makeRequest = (
  options: Permission['options'],
  extra: { meta?: Record<string, unknown>; toolCall?: Partial<ToolCall> } = {}
) => {
  const permission: Permission = { requestId: 'req-1', options, _meta: extra.meta };
  const toolCall = {
    type: 'tool_call',
    toolCallId: 'tc-1',
    status: 'pending',
    kind: 'execute',
    title: 'pnpm test',
    content: [{ type: 'terminal_command', command: 'pnpm', args: ['test'], cwd: '/repo' }],
    permissionRequest: permission,
    ...extra.toolCall,
  } as ToolCall;
  return { toolCall, permission };
};

const ALLOW_ONCE = { optionId: 'allow', name: 'Yes', kind: 'allow_once' as const };
const ALLOW_ALWAYS = {
  optionId: 'always',
  name: "Yes, and don't ask again for `pnpm` commands",
  kind: 'allow_always' as const,
};
const REJECT_ONCE = { optionId: 'reject', name: 'No', kind: 'reject_once' as const };
const REJECT_ALWAYS = {
  optionId: 'block',
  name: 'No, and block this host in the future',
  kind: 'reject_always' as const,
};

describe('PermissionPrompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let selected: string[];

  beforeEach(async () => {
    await initI18n('en');
    selected = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = async (
    request: ReturnType<typeof makeRequest>,
    props: Partial<Parameters<typeof PermissionPrompt>[0]> = {}
  ) => {
    await act(async () => {
      root.render(
        <PermissionPrompt
          {...request}
          onSelect={(optionId) => selected.push(optionId)}
          {...props}
        />
      );
    });
  };

  const prompt = () => container.querySelector<HTMLElement>('[role="group"]')!;
  const press = async (key: string, target: Element = document.activeElement ?? prompt()) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  };
  // An option's text is its name, plus the `esc` key cap on the refusal.
  const optionButton = (name: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.replace(/esc$/, '') === name
    )!;

  it('asks in the provider’s words and shows exactly what would run', async () => {
    await render(
      makeRequest([ALLOW_ONCE, REJECT_ONCE], {
        meta: { permission: { title: 'Run command?', description: 'Reason: verify the fix' } },
      })
    );

    expect(container.textContent).toContain('Run command?');
    expect(container.textContent).toContain('Reason: verify the fix');
    expect(container.textContent).toContain('pnpm test');
    expect(container.textContent).toContain('in /repo');
  });

  it('falls back to a question from the tool kind when the provider sent none', async () => {
    await render(makeRequest([ALLOW_ONCE, REJECT_ONCE]));
    expect(prompt().getAttribute('aria-label')).toBe('Run this command?');
  });

  it('refuses once on Escape, never with an "always" refusal', async () => {
    await render(makeRequest([ALLOW_ONCE, REJECT_ALWAYS, REJECT_ONCE]), { autoFocus: true });
    expect(document.activeElement).toBe(prompt());

    await press('Escape');
    expect(selected).toEqual(['reject']);
  });

  it('answers nothing on Escape when the only refusal is permanent', async () => {
    await render(makeRequest([ALLOW_ONCE, REJECT_ALWAYS]), { autoFocus: true });
    await press('Escape');
    expect(selected).toEqual([]);
  });

  it('never answers from an Enter meant for the message the prompt replaced', async () => {
    await render(makeRequest([ALLOW_ONCE, ALLOW_ALWAYS, REJECT_ONCE]), { autoFocus: true });
    await press('Enter');
    expect(selected).toEqual([]);
  });

  it('lands the first arrow on the suggested answer, then walks the shown answers', async () => {
    await render(makeRequest([ALLOW_ALWAYS, ALLOW_ONCE, REJECT_ONCE]), { autoFocus: true });

    // The suggestion is the one-time allow, not the first option: widening
    // what the agent may do is never the default.
    await press('ArrowUp');
    expect(document.activeElement).toBe(optionButton('Yes'));

    // The standing answer is behind the allow family's chevron, not a button
    // of its own, so the arrows walk the two shown answers.
    expect(optionButton(ALLOW_ALWAYS.name)).toBeUndefined();
    await press('ArrowDown');
    expect(document.activeElement).toBe(optionButton('No'));
    await press('ArrowDown');
    expect(document.activeElement).toBe(optionButton('Yes'));

    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(selected).toEqual(['allow']);
  });

  it('suggests the refusal when the provider marks the request defaultToNo', async () => {
    await render(
      makeRequest([ALLOW_ONCE, REJECT_ONCE], { meta: { permission: { defaultToNo: true } } }),
      { autoFocus: true }
    );
    await press('ArrowDown');
    expect(document.activeElement).toBe(optionButton('No'));
  });

  it('does not take focus from something a person is using', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await render(makeRequest([ALLOW_ONCE, REJECT_ONCE]), { autoFocus: true });
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it('holds every answer while one is sending, and says when it failed', async () => {
    await render(makeRequest([ALLOW_ONCE, REJECT_ONCE]), { sendingOptionId: 'allow' });
    expect(optionButton('Yes').disabled).toBe(true);
    expect(optionButton('No').disabled).toBe(true);

    await render(makeRequest([ALLOW_ONCE, REJECT_ONCE]), {
      error: "Your answer didn't reach the agent. Try again.",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "didn't reach the agent"
    );
    expect(optionButton('Yes').disabled).toBe(false);
  });
});

describe('resolvePermissionSubject', () => {
  const toolCall = (fields: Partial<ToolCall>) =>
    ({ type: 'tool_call', toolCallId: 'tc', status: 'pending', ...fields }) as ToolCall;

  it('lists each path an edit touches once', () => {
    expect(
      resolvePermissionSubject(
        toolCall({
          kind: 'edit',
          title: 'Edit files',
          locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }, { path: 'src/a.ts' }],
        })
      )
    ).toEqual({ type: 'paths', paths: ['src/a.ts', 'src/b.ts'] });
  });

  it('has no subject for a plan decision, whose plan is the message above', () => {
    expect(resolvePermissionSubject(toolCall({ kind: 'switch_mode', title: 'Approve Plan' }))).toBe(
      null
    );
  });

  it('reads a command from the title when no command block was sent', () => {
    expect(resolvePermissionSubject(toolCall({ kind: 'execute', title: 'git push' }))).toEqual({
      type: 'command',
      command: 'git push',
      cwd: null,
    });
  });
});
