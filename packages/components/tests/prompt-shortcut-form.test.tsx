// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PromptShortcutForm,
  type ShortcutPromptEditorProps,
} from '../src/components/settings/prompt-shortcut-form';
import { initI18n } from '../src/i18n';
import type { PromptShortcut } from '@lody/shared/prompt-shortcuts';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const initial: PromptShortcut = {
  v: 1,
  id: 'test',
  workspaceId: 'ws',
  ownerUserId: 'alice',
  revision: 'r1',
  visibility: 'private',
  name: 'Review',
  slug: 'review',
  prompt: 'Review !{topic}',
  variables: [{ name: 'topic' }],
  mentions: [],
  scope: {},
  createdAt: 1,
  updatedAt: 1,
};
const options = {
  projects: [{ label: 'org/repo', value: { kind: 'github' as const, repository: 'org/repo' } }],
  machines: [{ value: 'machine', label: 'Laptop' }],
  providers: [{ value: 'builtin:codex', label: 'Codex' }],
};
let root: Root, container: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  await initI18n('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function edit(selector: string, value: string) {
  const field = container.querySelector<HTMLTextAreaElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      value
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('Prompt Shortcut editor', () => {
  it('names out-of-scope mentions and blocks saving until the author restores their scope', async () => {
    const onSave = vi.fn(async () => {});
    const project = options.projects[0]!.value;
    const prompt = '@src/app.ts';
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={{
            ...initial,
            prompt,
            variables: [],
            scope: { project },
            mentions: [
              {
                start: 0,
                end: prompt.length,
                label: prompt,
                target: { kind: 'file', path: 'src/app.ts', project },
              },
            ],
          }}
          options={options}
          canShare
          saving={false}
          onCancel={() => {}}
          onSave={onSave}
        />
      )
    );
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      false
    );
    const select = container.querySelector<HTMLSelectElement>('#shortcut-project')!;
    await act(async () => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('@src/app.ts');
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(
      'Requires matching Project'
    );
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      true
    );
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => {
      select.value = JSON.stringify(project);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      false
    );
  });
  it('preserves newly inserted semantic mentions when scope changes remount the prompt source', async () => {
    let editor: ShortcutPromptEditorProps | undefined;
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={initial}
          options={options}
          canShare
          saving={false}
          onCancel={() => {}}
          onSave={async () => {}}
          renderPrompt={(props) => {
            editor = props;
            return null;
          }}
        />
      )
    );
    const range = {
      start: 0,
      end: 5,
      kind: 'agent_role' as const,
      value: JSON.stringify({ kind: 'agent_role', agentRoleId: 'role' }),
    };
    await act(async () => {
      editor!.onValueChange('@role');
      editor!.onRangesChange([range]);
    });
    await act(async () => {
      const select = container.querySelector<HTMLSelectElement>('#shortcut-project')!;
      select.value = JSON.stringify(options.projects[0]!.value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(editor!.scope.project).toEqual(options.projects[0]!.value);
    expect(editor!.value).toBe('@role');
    expect(editor!.initialRanges).toEqual([range]);
  });
  it('keeps scope empty by default, derives variables and saves multiline literal defaults', async () => {
    let saved: PromptShortcut | undefined;
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={initial}
          options={options}
          canShare
          saving={false}
          onCancel={() => {}}
          onSave={async (value) => {
            saved = value;
          }}
        />
      )
    );
    expect([...container.querySelectorAll('select')].map((field) => field.value)).toEqual([
      '',
      '',
      '',
    ]);
    await edit('#shortcut-prompt', 'Review !{topic}\nExplain !{reason}');
    await edit('#shortcut-variable-topic', 'line one\n$literal @literal !{literal}');
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(saved?.scope).toEqual({});
    expect(saved?.visibility).toBe('private');
    expect(saved?.variables).toEqual([
      { name: 'topic', defaultValue: 'line one\n$literal @literal !{literal}' },
      { name: 'reason' },
    ]);
  });
  it('omits cloud sharing and remote-machine selection on local-only platforms', async () => {
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={initial}
          options={options}
          canShare={false}
          allowMachineSelection={false}
          saving={false}
          onCancel={() => {}}
          onSave={async () => {}}
        />
      )
    );
    expect(container.textContent).not.toContain('Share with workspace');
    expect(container.querySelector('#shortcut-machine')).toBeNull();
    expect(container.textContent).toContain('Limit to this machine');
  });
  it('blocks saving an ambiguous publication but leaves cancellation available', async () => {
    let cancelled = false;
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={initial}
          options={options}
          canShare
          saving={false}
          saveBlocked
          onCancel={() => {
            cancelled = true;
          }}
          onSave={async () => {
            throw new Error('must not save');
          }}
        />
      )
    );
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true
    );
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )!;
    await act(async () => cancel.click());
    expect(cancelled).toBe(true);
  });
});
