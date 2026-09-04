// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Records the `enabled` argument the composer passes to the skills scan. */
const skillScanEnabled: boolean[] = [];
const sessionItems: Array<{
  sessionId: string;
  title: string;
  slug: string;
  activityAt?: number;
  projectKey: 'chat' | `github:${string}` | `local:${string}:${string}`;
}> = [];

/** Counts the file source's activation-driven revalidations. */
const fileRefreshCalls: number[] = [];
let fileRefreshAvailable = true;

vi.mock('../src/components/mentions/mention-project-file-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectFiles: () => ({
    // Deliberately empty: activation is driven by the resolved menu VIEW, not by
    // the source having candidates, and giving every test in this file a real
    // entry made each one build a Fuse index and render file rows.
    fileData: { entry: null, status: 'ready' as const },
    initializeLazyDirectory: async () => undefined,
    getKnownFileTokens: () => new Set<string>(),
    refreshFiles: fileRefreshAvailable
      ? () => {
          fileRefreshCalls.push(1);
        }
      : undefined,
  }),
}));

vi.mock('../src/components/mentions/mention-skill-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMentionProjectSkills: (_source: unknown, enabled: boolean) => {
    skillScanEnabled.push(enabled);
    return {
      skillState: { status: enabled ? ('ready' as const) : ('idle' as const) },
      skillItems: [],
      knownSkillTokens: new Set<string>(),
    };
  },
}));

vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => sessionItems,
}));

// Agent Roles read the visible-machine index, which needs the authenticated
// Convex context; the same reason the session source above is stubbed.
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { CombinedMentionTextarea } from '../src/components/mentions/combined-mention-textarea';
import { initI18n } from '../src/i18n';
import { commands } from '../src/lib/commands';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CombinedMentionTextarea mention enablement and activation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

  beforeEach(async () => {
    await initI18n('en');
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    skillScanEnabled.length = 0;
    sessionItems.length = 0;
    fileRefreshCalls.length = 0;
    fileRefreshAvailable = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      delete (
        HTMLElement.prototype as { scrollIntoView?: typeof HTMLElement.prototype.scrollIntoView }
      ).scrollIntoView;
    }
  });

  async function render(props: {
    value: string;
    skillAgent?: { machineId?: string; cliType?: string };
    mentionSource?: unknown;
    commandsEnabled?: boolean;
  }) {
    function ControlledComposer() {
      const [value, setValue] = React.useState(props.value);
      return (
        <CombinedMentionTextarea
          value={value}
          onValueChange={setValue}
          skillAgent={props.skillAgent as never}
          mentionSource={props.mentionSource as never}
          commandsEnabled={props.commandsEnabled}
          resetOnEmpty={false}
        />
      );
    }

    await act(async () => {
      root.render(<ControlledComposer />);
    });
  }

  function textarea() {
    return container.querySelector('textarea');
  }

  /**
   * The `<Mention>` tree renders a real `<label>`; the plain-textarea fallback
   * only sets `aria-label`. That is the observable difference between a
   * composer that can mention and one that silently cannot.
   */
  function mentionTreeMounted() {
    return container.querySelector('label') !== null;
  }

  function highlightedRowText() {
    return document.querySelector<HTMLElement>('[data-slot="mention-item"][data-highlighted]')
      ?.textContent;
  }

  /** Types into the composer the way the mention primitive observes it. */
  async function typeInto(value: string) {
    const input = textarea();
    if (!input) throw new Error('composer textarea missing');
    await act(async () => {
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      setter?.call(input, value);
      input.selectionStart = value.length;
      input.selectionEnd = value.length;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const localMentionSource = {
    kind: 'local',
    machineId: 'machine-1',
    workspaceId: 'lw_1',
    localProjectId: 'lp_1',
  };

  it('revalidates a local file list once per @ menu cycle', async () => {
    await render({ value: '', mentionSource: localMentionSource });

    // A bare `@` shows the category index and queries nothing, so nothing loads.
    await typeInto('@');
    expect(fileRefreshCalls).toHaveLength(0);

    // The first real query is what asks the machine; further keystrokes in the
    // same open menu must not re-spawn `git ls-files`.
    await typeInto('@ap');
    await typeInto('@app');
    expect(fileRefreshCalls).toHaveLength(1);

    // Closing and reopening is a new cycle: the working tree may have moved.
    await typeInto('');
    await typeInto('@ap');
    expect(fileRefreshCalls).toHaveLength(2);
  });

  it('does not revalidate a file source that provides no refresh', async () => {
    fileRefreshAvailable = false;

    await render({ value: '', mentionSource: localMentionSource });
    await typeInto('@ap');

    expect(fileRefreshCalls).toHaveLength(0);
  });

  it('renders a plain textarea when no mention type is reachable', async () => {
    await render({ value: '' });

    expect(textarea()).not.toBeNull();
    expect(mentionTreeMounted()).toBe(false);
  });

  it('mounts the mention tree when sessions are the only mentionable type', async () => {
    sessionItems.push({
      sessionId: 's1',
      title: 'Fix the parser',
      slug: 'fix-the-parser',
      projectKey: 'chat',
    });

    await render({ value: '' });

    expect(mentionTreeMounted()).toBe(true);
  });

  it('wraps ArrowUp from the first @ result and continues in reverse order', async () => {
    sessionItems.push(
      {
        sessionId: 's1',
        title: 'First session',
        slug: 'first-session',
        activityAt: 3,
        projectKey: 'chat',
      },
      {
        sessionId: 's2',
        title: 'Second session',
        slug: 'second-session',
        activityAt: 2,
        projectKey: 'chat',
      },
      {
        sessionId: 's3',
        title: 'Third session',
        slug: 'third-session',
        activityAt: 1,
        projectKey: 'chat',
      }
    );
    await render({ value: '' });
    await typeInto('@session:');

    const input = textarea();
    if (!input) throw new Error('composer textarea missing');
    expect(highlightedRowText()).toContain('First session');

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      );
    });
    expect(highlightedRowText()).toContain('Third session');

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      );
    });
    expect(highlightedRowText()).toContain('Second session');
  });

  it('starts in the current project and toggles without losing query or focus', async () => {
    sessionItems.push(
      {
        sessionId: 'current',
        title: 'Current parser work',
        slug: 'current-parser-work',
        activityAt: 2,
        projectKey: 'github:lodyai/lody',
      },
      {
        sessionId: 'other',
        title: 'Other parser work',
        slug: 'other-parser-work',
        activityAt: 1,
        projectKey: 'github:lodyai/other',
      }
    );
    await render({
      value: '',
      mentionSource: { kind: 'github', repoFullName: ' LodyAI/Lody ' },
    });
    await typeInto('@session:parser');

    const input = textarea();
    if (!input) throw new Error('composer textarea missing');
    expect(document.body.textContent).toContain('Current parser work');
    expect(document.body.textContent).not.toContain('Other parser work');
    expect(document.body.textContent).toContain('Current project');

    const toggle = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[role="group"][aria-label="Session project scope"] button'
      )
    ).find((button) => button.textContent === 'All projects');
    if (!toggle) throw new Error('scope toggle missing');
    await act(async () => {
      toggle.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      toggle.click();
    });

    expect(input.value).toBe('@session:parser');
    expect(document.activeElement).toBe(input);
    expect(document.body.textContent).toContain('Other parser work');
    expect(document.body.textContent).toContain('All projects');

    // Going back within the same open menu preserves the temporary scope.
    await typeInto('@');
    await typeInto('@session:parser');
    expect(document.body.textContent).toContain('Other parser work');

    // Closing the menu resets the next open to the current project.
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
    });
    await typeInto('');
    await typeInto('@session:parser');
    expect(document.body.textContent).not.toContain('Other parser work');
    expect(document.body.textContent).toContain('Current project');
  });

  it('offers all projects from an empty current-project result and scopes the command', async () => {
    sessionItems.push({
      sessionId: 'other',
      title: 'Cross project session',
      slug: 'cross-project-session',
      activityAt: 1,
      projectKey: 'github:lodyai/other',
    });
    await render({
      value: '',
      mentionSource: { kind: 'github', repoFullName: 'lodyai/lody' },
    });

    expect(commands.execute('mention.toggleSessionProjectScope')).toBe(false);
    await typeInto('@session:cross');
    expect(document.body.textContent).toContain(
      'There are no other sessions in the current project.'
    );
    expect(document.body.textContent).not.toContain('Cross project session');

    expect(commands.execute('mention.toggleSessionProjectScope')).toBe(true);
    await act(async () => Promise.resolve());
    expect(document.body.textContent).toContain('Cross project session');

    await typeInto('@');
    expect(commands.execute('mention.toggleSessionProjectScope')).toBe(false);
  });

  it('does not let a hidden retained composer own the scope command', async () => {
    sessionItems.push({
      sessionId: 'other',
      title: 'Other session',
      slug: 'other-session',
      activityAt: 1,
      projectKey: 'chat',
    });
    await render({ value: '', commandsEnabled: false });
    await typeInto('@session:');

    expect(commands.execute('mention.toggleSessionProjectScope')).toBe(false);
  });

  it('does not scan skills until something asks for them', async () => {
    await render({ value: '', skillAgent: { machineId: 'machine-1' } });

    expect(skillScanEnabled).not.toContain(true);
  });

  it('scans skills when the menu scopes to the Skills category', async () => {
    await render({ value: '', skillAgent: { machineId: 'machine-1' } });
    expect(skillScanEnabled).not.toContain(true);

    // Typed/pasted namespace prefixes still activate their lazy source.
    await typeInto('@skill:');

    expect(skillScanEnabled).toContain(true);
  });

  it('retains $ as a direct skill-menu trigger', async () => {
    await render({ value: '', skillAgent: { machineId: 'machine-1' } });
    expect(skillScanEnabled).not.toContain(true);

    await typeInto('$');

    expect(skillScanEnabled).toContain(true);
  });

  it('still scans skills for a draft that already carries a $ token', async () => {
    await render({ value: 'use $review', skillAgent: { machineId: 'machine-1' } });

    expect(skillScanEnabled).toContain(true);
  });
});
