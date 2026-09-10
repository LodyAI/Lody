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

/** Radix Select opens on a real pointer event; jsdom has no PointerEvent. */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

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
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  await initI18n('en');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function edit(selector: string, value: string) {
  const field = container.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector)!;
  const prototype =
    field instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function scopeTrigger(id: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`#${id}`)!;
}
/** Open one "Applies to" selector and pick an option by its visible label. */
async function chooseScope(id: string, label: string) {
  await act(async () => {
    scopeTrigger(id).dispatchEvent(
      new TestPointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
    );
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label
  );
  if (!option) throw new Error(`No "${label}" option in ${id}`);
  await act(async () => {
    option.focus();
    option.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  });
}
const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function submitForm() {
  await act(async () => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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
    expect(submitButton().disabled).toBe(false);

    await chooseScope('shortcut-project', 'None');
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('@src/app.ts');
    expect(alert.textContent).toContain('Requires matching Project');
    expect(submitButton().disabled).toBe(true);
    await submitForm();
    expect(onSave).not.toHaveBeenCalled();

    await chooseScope('shortcut-project', 'org/repo');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(submitButton().disabled).toBe(false);
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
    await chooseScope('shortcut-project', 'org/repo');
    expect(editor!.scope.project).toEqual(options.projects[0]!.value);
    expect(editor!.value).toBe('@role');
    expect(editor!.initialRanges).toEqual([range]);
  });

  it('keeps scope empty by default and saves the prompt verbatim', async () => {
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
    // Each axis names itself in its trigger; there is no field label above it.
    expect(
      ['shortcut-project', 'shortcut-machine', 'shortcut-provider'].map(
        (id) => scopeTrigger(id).textContent
      )
    ).toEqual(['ProjectNone', 'MachineNone', 'AgentNone']);
    // `!{name}` is ordinary text now: it is stored and sent exactly as written.
    await edit('#shortcut-prompt', 'Review !{topic}\nExplain the plan');
    await submitForm();
    expect(saved?.scope).toEqual({});
    expect(saved?.visibility).toBe('private');
    expect(saved?.prompt).toBe('Review !{topic}\nExplain the plan');
  });

  it('derives the slash command from the name only while the author has not written one', async () => {
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={{ ...initial, name: '', slug: '', prompt: '' }}
          isNew
          options={options}
          canShare
          saving={false}
          onCancel={() => {}}
          onSave={async () => {}}
        />
      )
    );
    const slug = () => container.querySelector<HTMLInputElement>('#shortcut-slug')!.value;
    await edit('#shortcut-name', 'Review PR');
    expect(slug()).toBe('review-pr');
    await edit('#shortcut-slug', 'audit');
    await edit('#shortcut-name', 'Review pull request');
    expect(slug()).toBe('audit');
  });

  it('never moves an existing shortcut command when its name is edited', async () => {
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={initial}
          options={options}
          canShare
          saving={false}
          onCancel={() => {}}
          onSave={async () => {}}
        />
      )
    );
    await edit('#shortcut-name', 'Review everything');
    expect(container.querySelector<HTMLInputElement>('#shortcut-slug')!.value).toBe('review');
  });

  it('still names a saved scope whose option is missing from the loaded lists', async () => {
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={{
            ...initial,
            scope: {
              project: { kind: 'github', repository: 'org/not-loaded' },
              machineId: 'machine-not-loaded',
            },
          }}
          options={{ projects: [], machines: [], providers: [] }}
          canShare
          saving={false}
          onCancel={() => {}}
          onSave={async () => {}}
        />
      )
    );
    // Blank would read as "None", which is a different Shortcut from the saved one.
    expect(scopeTrigger('shortcut-project').textContent).toContain('org/not-loaded');
    expect(scopeTrigger('shortcut-machine').textContent).toContain('machine-not-loaded');
  });

  it('shares privately by default and warns before publishing to the workspace', async () => {
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
    const share = container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(share.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).not.toContain('Workspace members can read');
    await act(async () => share.click());
    expect(container.textContent).toContain('Workspace members can read');
    await submitForm();
    expect(saved?.visibility).toBe('workspace');
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
    expect(
      container.querySelector('button[role="switch"][aria-label="Limit to this machine"]')
    ).not.toBeNull();
  });

  it('blocks only an in-progress local save and prevents duplicate submissions', async () => {
    let cancelled = false;
    await act(async () =>
      root.render(
        <PromptShortcutForm
          initial={initial}
          options={options}
          canShare
          saving
          onCancel={() => {
            cancelled = true;
          }}
          onSave={async () => {
            throw new Error('must not save');
          }}
        />
      )
    );
    expect(submitButton().disabled).toBe(true);
    const cancel = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel'
    )!;
    await act(async () => cancel.click());
    expect(cancelled).toBe(false);
  });
});
