// @vitest-environment jsdom

import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type { AskUserQuestionPermissionMeta, AskUserQuestionAnswers } from '@lody/shared';
import { parseAskUserQuestionElicitationRequest } from '@lody/shared';

import { AskUserQuestionCard } from '../src/components/sessions/ask-user-question-card';
import { Tooltip } from '@lody/ui/tooltip';
import { initI18n } from '../src/i18n';
import storyMeta, { SecretNote } from '../src/stories/AskUserQuestionCard.stories';

const meta: AskUserQuestionPermissionMeta = {
  source: 'codex',
  version: 1,
  allowCustomAnswer: false,
  questions: [
    {
      header: 'Breakfast',
      question: 'Pick ingredients',
      multiSelect: true,
      options: [{ label: 'Eggs' }, { label: 'Toast' }],
    },
    {
      header: 'Drink',
      question: 'Pick a drink',
      multiSelect: false,
      options: [{ label: 'Coffee' }, { label: 'Tea' }],
    },
  ],
};

// Core/Codex puts the question in the property description even for one field.
const metaWithInfo = parseAskUserQuestionElicitationRequest({
  mode: 'form',
  message: 'Input requested',
  _meta: { lody: { elicitation: { version: 1 } } },
  requestedSchema: {
    type: 'object',
    properties: {
      strategy: {
        type: 'string',
        title: 'Strategy',
        description: 'Pick a strategy',
        oneOf: [
          {
            const: 'Use a Map',
            title: 'Use a Map',
            description: 'Best when keys are dynamic',
            _meta: { lody: { elicitation: { version: 1, preview: 'const cache = new Map();' } } },
          },
          { const: 'Use a plain object', title: 'Use a plain object' },
        ],
      },
    },
  },
})!.meta;

function dispatchTouchPointer(
  target: EventTarget,
  type: string,
  init: { x: number; y: number; pointerId?: number }
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: 'touch' },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
}

function getButton(container: HTMLElement, label: string): HTMLElement {
  // Option containers are <div role="button"> so the inline info icon can
  // nest next to the label; navigation/submit buttons stay native <button>.
  const button = [...container.querySelectorAll<HTMLElement>('button, [role="button"]')].find(
    (candidate) => candidate.textContent?.includes(label)
  );
  if (!button) {
    throw new Error(`Expected button "${label}" to be rendered`);
  }
  return button;
}

describe('AskUserQuestionCard touch navigation', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderCard() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(AskUserQuestionCard, {
          meta,
          mode: {
            kind: 'interactive',
            isReady: true,
            isPendingSubmit: false,
            isPendingCancel: false,
            disabled: false,
            onSubmit: vi.fn(),
            onCancel: vi.fn(),
          },
        })
      );
    });

    const card = container.firstElementChild;
    if (!(card instanceof HTMLElement)) {
      throw new Error('Expected the question card to render');
    }
    return card;
  }

  it('advances to the next question on a left touch swipe after the current answer is complete', () => {
    const card = renderCard();
    expect(container?.textContent).toContain('Pick ingredients');

    flushSync(() => {
      getButton(container!, 'Eggs').click();
    });

    flushSync(() => {
      dispatchTouchPointer(card, 'pointerdown', { x: 220, y: 80 });
      dispatchTouchPointer(card, 'pointermove', { x: 150, y: 82 });
      dispatchTouchPointer(card, 'pointerup', { x: 120, y: 82 });
    });

    expect(container?.textContent).toContain('Pick a drink');
  });

  it('does not advance on a left touch swipe when the current answer is incomplete', () => {
    const card = renderCard();

    flushSync(() => {
      dispatchTouchPointer(card, 'pointerdown', { x: 220, y: 80 });
      dispatchTouchPointer(card, 'pointermove', { x: 150, y: 82 });
      dispatchTouchPointer(card, 'pointerup', { x: 120, y: 82 });
    });

    expect(container?.textContent).toContain('Pick ingredients');
    expect(container?.textContent).not.toContain('Pick a drink');
  });
});

describe('AskUserQuestionCard submit behavior', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderInteractiveCard() {
    let acceptedAnswers: AskUserQuestionAnswers | undefined;
    function InteractiveCard() {
      const [answers, setAnswers] = useState<AskUserQuestionAnswers>();
      return createElement(AskUserQuestionCard, {
        meta,
        mode: answers
          ? { kind: 'readonly', answers }
          : {
              kind: 'interactive',
              isReady: true,
              isPendingSubmit: false,
              isPendingCancel: false,
              disabled: false,
              onSubmit: (next) => {
                acceptedAnswers = next;
                setAnswers(next);
              },
              onCancel: () => {},
            },
      });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root?.render(createElement(InteractiveCard)));
    return () => acceptedAnswers;
  }

  it('submits only when the user clicks the Submit button after answering all questions', async () => {
    const acceptedAnswers = renderInteractiveCard();

    flushSync(() => {
      getButton(container!, 'Eggs').click();
    });
    flushSync(() => {
      getButton(container!, 'Next').click();
    });
    flushSync(() => {
      getButton(container!, 'Coffee').click();
    });

    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    expect(acceptedAnswers()).toBeUndefined();
    expect(container?.textContent).not.toContain('Answered');
    expect((getButton(container!, 'Submit') as HTMLButtonElement).disabled).toBe(false);

    flushSync(() => {
      getButton(container!, 'Submit').click();
    });

    expect(container?.textContent).toContain('Answered');
    expect(Object.values(acceptedAnswers()!)).toEqual([['Eggs'], 'Coffee']);
    expect(getButton(container!, 'Coffee').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('AskUserQuestionCard info button keyboard a11y', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
  });

  function renderWithInfo(onSubmit = vi.fn()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    flushSync(() => {
      root?.render(
        createElement(
          Tooltip.Provider,
          { delayDuration: 0 },
          createElement(AskUserQuestionCard, {
            meta: metaWithInfo,
            mode: {
              kind: 'interactive',
              isReady: true,
              isPendingSubmit: false,
              isPendingCancel: false,
              disabled: false,
              onSubmit,
              onCancel: vi.fn(),
            },
          })
        )
      );
    });
  }

  it('opens the info dialog (not the parent option) when Enter is pressed on the (i) button', () => {
    renderWithInfo();
    expect(container!.textContent).toContain('Pick a strategy');
    expect(container!.textContent).not.toContain('Input requested');

    const infoButton = container!.querySelector<HTMLButtonElement>(
      'button[aria-label="Show details"]'
    );
    if (!infoButton) throw new Error('Expected an info button to be rendered');

    flushSync(() => {
      infoButton.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
      // jsdom does not synthesize the native Enter→click; emit it explicitly
      // to model what a real browser does AFTER the option's outer handler
      // (correctly) opts out of preventing the default.
      infoButton.click();
    });

    expect(document.body.textContent).toContain('Best when keys are dynamic');
    // The parent option must not have been toggled by the bubbled keydown.
    const optionRow = container!.querySelector<HTMLElement>('[role="button"][aria-pressed]');
    expect(optionRow?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('AskUserQuestionCard answer notes', () => {
  let root: Root;
  let container: HTMLDivElement;
  const noteMeta: AskUserQuestionPermissionMeta = {
    source: 'lody',
    version: 1,
    allowCustomAnswer: false,
    questions: [
      {
        id: 'approach',
        header: 'Approach',
        question: 'Which approach?',
        options: [{ label: 'Small change' }, { label: 'None of the above' }],
        multiSelect: false,
        note: { fieldId: 'approach_note', title: 'Context' },
      },
    ],
  };
  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });
  function render(customMeta = noteMeta) {
    let submitted: AskUserQuestionAnswers | undefined;
    let cancelled = false;
    flushSync(() =>
      root.render(
        createElement(AskUserQuestionCard, {
          meta: customMeta,
          mode: {
            kind: 'interactive',
            isReady: true,
            isPendingSubmit: false,
            isPendingCancel: false,
            disabled: false,
            onSubmit: (answers) => {
              submitted = answers;
            },
            onCancel: () => {
              cancelled = true;
            },
          },
        })
      )
    );
    return { answers: () => submitted, cancelled: () => cancelled };
  }
  function typeNote(value: string) {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea'
    )!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(
        input instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype,
        'value'
      )!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  it.each(['Small change', 'None of the above'])(
    'submits %s alongside an independently edited note',
    (choice) => {
      const result = render();
      typeNote('Preserve the API');
      expect((getButton(container, 'Submit') as HTMLButtonElement).disabled).toBe(true);
      flushSync(() => getButton(container, choice).click());
      expect(container.querySelector('textarea')!.value).toBe('Preserve the API');
      typeNote('Keep compatibility\nKeep the API');
      expect(getButton(container, choice).getAttribute('aria-pressed')).toBe('true');
      flushSync(() => getButton(container, 'Submit').click());
      expect(result.answers()).toEqual({
        approach: choice,
        approach_note: 'Keep compatibility\nKeep the API',
      });
    }
  );
  it.each(['', '   '])('omits blank notes (%j)', (value) => {
    const result = render();
    typeNote(value);
    flushSync(() => getButton(container, 'Small change').click());
    flushSync(() => getButton(container, 'Submit').click());
    expect(result.answers()).toEqual({ approach: 'Small change' });
  });
  it('keeps multi-question notes on their own fields and stays on the current question after selection', () => {
    const result = render({
      ...noteMeta,
      questions: [
        { ...noteMeta.questions[0]!, note: { fieldId: 'first_note' } },
        {
          ...noteMeta.questions[0]!,
          id: 'approach_note',
          question: 'Second question',
          note: { fieldId: 'second_note', title: 'Second context' },
        },
      ],
    });
    typeNote('First');
    flushSync(() => getButton(container, 'Small change').click());
    expect(container.textContent).toContain('Which approach?');
    flushSync(() => getButton(container, 'Next').click());
    typeNote('Second');
    flushSync(() => getButton(container, 'None of the above').click());
    flushSync(() => getButton(container, 'Submit').click());
    expect(result.answers()).toEqual({
      approach: 'Small change',
      first_note: 'First',
      approach_note: 'None of the above',
      second_note: 'Second',
    });
  });
  it('cancels without submitting a draft note', () => {
    const result = render();
    typeNote('Draft');
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="Cancel"]')!.click());
    expect(result.cancelled()).toBe(true);
    expect(result.answers()).toBeUndefined();
  });
  it('keeps the legacy custom answer as a replacement, without clearing its note', () => {
    const result = render({
      ...noteMeta,
      questions: [{ ...noteMeta.questions[0]!, allowCustomAnswer: true }],
    });
    flushSync(() => getButton(container, 'Small change').click());
    typeNote('Another approach');
    expect(getButton(container, 'Small change').getAttribute('aria-pressed')).toBe('false');
    const noteInput = container.querySelector('textarea')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        noteInput,
        'Reason'
      );
      noteInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    flushSync(() => getButton(container, 'Submit').click());
    expect(result.answers()).toEqual({ approach: 'Another approach', approach_note: 'Reason' });
  });
  it.each([{ isComposing: true }, { keyCode: 229 }, { which: 229 }])(
    'keeps candidate confirmation out of answer submission (%j)',
    (imeSignal) => {
      const result = render({
        ...noteMeta,
        questions: [{ ...noteMeta.questions[0]!, allowCustomAnswer: true }],
      });
      typeNote('保留现有接口');
      const input = container.querySelector('input')!;
      const candidate = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...imeSignal,
      });
      flushSync(() => input.dispatchEvent(candidate));
      expect(candidate.defaultPrevented).toBe(false);
      expect(result.answers()).toBeUndefined();
      expect(input.value).toBe('保留现有接口');
      flushSync(() =>
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          })
        )
      );
      expect(result.answers()).toEqual({ approach: '保留现有接口' });
    }
  );

  it('renders the real readonly story fixtures with independent secret masking', () => {
    flushSync(() => root.render(createElement(AskUserQuestionCard, storyMeta.args)));
    expect(container.querySelector('textarea')!.value).toBe('Keep the public API stable.');
    flushSync(() =>
      root.render(createElement(AskUserQuestionCard, { ...storyMeta.args, ...SecretNote.args }))
    );
    expect(container.querySelector('input')!.value).toBe('••••••••');
    expect(getButton(container, 'Small change').getAttribute('aria-pressed')).toBe('true');
  });
  it('replays the choice and masks only the secret note', () => {
    flushSync(() =>
      root.render(
        createElement(AskUserQuestionCard, {
          meta: {
            ...noteMeta,
            questions: [
              { ...noteMeta.questions[0]!, note: { fieldId: 'approach_note', isSecret: true } },
            ],
          },
          mode: {
            kind: 'readonly',
            answers: { approach: 'Small change', approach_note: 'Hidden note' },
          },
        })
      )
    );
    expect(getButton(container, 'Small change').getAttribute('aria-pressed')).toBe('true');
    const input = container.querySelector('input')!;
    expect(input.type).toBe('password');
    expect(input.value).toBe('••••••••');
    expect(container.innerHTML).not.toContain('Hidden note');
  });
  it('replays old records without a note input', () => {
    const { note: _note, ...question } = noteMeta.questions[0]!;
    flushSync(() =>
      root.render(
        createElement(AskUserQuestionCard, {
          meta: { ...noteMeta, questions: [question] },
          mode: { kind: 'readonly', answers: { approach: 'Small change' } },
        })
      )
    );
    expect(getButton(container, 'Small change').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('input')).toBeNull();
  });
});
