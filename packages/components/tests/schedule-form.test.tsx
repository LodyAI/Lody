// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../../../locales/en.json';
import { ScheduleForm } from '../src/components/schedules/schedule-view';
import { evaluateSchedule, ScheduleDefinitionSchema } from '@lody/shared';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Fixed clock: the preview and "next run" copy must not depend on the wall time. */
const NOW = Date.parse('2026-09-06T09:12:00+08:00');

describe('Schedule editor', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ScheduleForm>;
  beforeAll(async () => {
    await i18next.use(initReactI18next).init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = {
      initial: {
        title: 'Daily review',
        prompt: 'Review recent changes.',
        trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
        misfire: 'run_once',
        overlap: 'queue_one',
      },
      saving: false,
      now: NOW,
      timeZone: 'Asia/Shanghai',
      onSave: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = () => act(() => root.render(<ScheduleForm {...props} />));
  const button = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const submit = () =>
    act(() => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  /** The problem marks next to fields; each names its reason. */
  const marks = () =>
    [...container.querySelectorAll('[role="img"][aria-label]')].map((mark) =>
      mark.getAttribute('aria-label')
    );
  const footer = () => container.querySelector(`#${button().getAttribute('aria-describedby')}`)!;
  const field = (label: string) =>
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  const type = (label: string, text: string) =>
    act(() => {
      const element = field(label);
      const setter = Object.getOwnPropertyDescriptor(
        element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        'value'
      )!.set!;
      setter.call(element, text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });

  it('saves without any confirmation checkbox', () => {
    render();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button().disabled).toBe(false);
    expect(marks()).toEqual([]);
    submit();
    expect(props.onSave).toHaveBeenCalledWith(props.initial);
  });

  it('names its fields without a visible label, using placeholders as the hint', () => {
    render();
    expect(field(en['schedules.name']).placeholder).toBe(en['schedules.namePlaceholder']);
    expect(field(en['schedules.prompt']).placeholder).toBe(en['schedules.promptPlaceholder']);
    // The accessible names exist, but no <label> text takes up vertical space.
    expect(container.querySelectorAll('label')).toHaveLength(0);
  });

  it('has no time zone picker; the rule is read on the target machine clock', () => {
    props.timeZone = 'America/New_York';
    props.clockName = 'Studio';
    render();
    expect(container.querySelector('[aria-label="Time zone"]')).toBeNull();
    expect(container.textContent).toContain('Studio');
    submit();
    // Same wall time, moved onto the machine that runs it.
    expect(vi.mocked(props.onSave).mock.calls[0]![0].trigger).toEqual({
      kind: 'cron',
      expression: '0 9 * * *',
      timeZone: 'America/New_York',
    });
  });

  it.each([
    ['America/Los_Angeles', '2026-10-01T02:21', '2026-10-01T09:21:00.000Z', '2:21 AM'],
    ['Asia/Singapore', '2026-10-01T02:21', '2026-09-30T18:21:00.000Z', '2:21 AM'],
    ['America/Los_Angeles', '2026-10-01T23:21', '2026-10-02T06:21:00.000Z', '11:21 PM'],
    ['America/Los_Angeles', '2026-03-08T02:30', '2026-03-08T10:30:00.000Z', '3:30 AM'],
    ['America/Los_Angeles', '2026-11-01T01:30', '2026-11-01T08:30:00.000Z', '1:30 AM'],
  ])('keeps Once input, preview, save and due slot on %s (%s)', (zone, input, at, time) => {
    props.timeZone = zone;
    props.clockName = 'Fixture machine';
    props.now = Date.parse(at) - 86_400_000;
    props.initial = {
      ...props.initial,
      trigger: { kind: 'once', at: new Date(Date.parse(at) - 60_000).toISOString() },
    };
    render();
    type(en['schedules.repeat.runAt'], input);
    const normalizedInput = input === '2026-03-08T02:30' ? '2026-03-08T03:30' : input;
    expect(field(en['schedules.repeat.runAt']).value).toBe(normalizedInput);
    const preview = container.querySelector('[aria-atomic="true"]')!;
    expect(preview.textContent).toContain(time);
    expect(preview.querySelector('[title]')?.getAttribute('title')).toBe(zone);
    submit();
    const trigger = vi.mocked(props.onSave).mock.calls[0]![0].trigger;
    expect(trigger).toEqual({ kind: 'once', at });
    const definition = ScheduleDefinitionSchema.parse({
      scheduleId: 'fixture',
      title: 'Fixture',
      ownerId: 'owner',
      machineId: 'machine',
      enabled: true,
      activationId: 'activation',
      activeFrom: props.now,
      trigger,
      misfirePolicy: { kind: 'run_once' },
      overlapPolicy: 'queue_one',
      agent: { agentConfigId: 'agent' },
      retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      createdAt: props.now,
      updatedAt: props.now,
      createdBy: 'owner',
    });
    expect(evaluateSchedule(definition, undefined, Date.parse(at) - 1).due).toBeUndefined();
    expect(evaluateSchedule(definition, undefined, Date.parse(at)).due).toEqual({
      scheduledFor: Date.parse(at),
      disposition: 'run',
    });
  });

  it('keeps a Once instant when switching machines and reopening the saved form', () => {
    const at = '2026-10-01T09:21:00.000Z';
    props.initial = { ...props.initial, trigger: { kind: 'once', at } };
    props.now = Date.parse('2026-09-30T00:00:00Z');
    props.timeZone = 'America/Los_Angeles';
    render();
    expect(field(en['schedules.repeat.runAt']).value).toBe('2026-10-01T02:21');
    props.timeZone = 'Asia/Singapore';
    render();
    expect(field(en['schedules.repeat.runAt']).value).toBe('2026-10-01T17:21');
    expect(container.querySelector('[aria-atomic="true"]')!.textContent).toContain('5:21 PM');
    submit();
    const saved = vi.mocked(props.onSave).mock.calls[0]![0];
    expect(saved.trigger).toBe(props.initial.trigger);
    act(() => root.unmount());
    root = createRoot(container);
    props.initial = saved;
    render();
    expect(field(en['schedules.repeat.runAt']).value).toBe('2026-10-01T17:21');
  });

  it('keeps a stored second DST-fold instant when saving an untouched Once field', () => {
    const trigger = { kind: 'once', at: '2026-11-01T09:30:00.000Z' } as const;
    props.initial = { ...props.initial, trigger };
    props.timeZone = 'America/Los_Angeles';
    props.now = Date.parse('2026-10-31T00:00:00Z');
    render();
    expect(field(en['schedules.repeat.runAt']).value).toBe('2026-11-01T01:30');
    submit();
    expect(vi.mocked(props.onSave).mock.calls[0]![0].trigger).toBe(trigger);
  });

  it('switches Once to a periodic rule using the machine hour and keeps it through Manual', async () => {
    props.initial = { ...props.initial, trigger: { kind: 'once', at: '2026-10-01T09:21:00.000Z' } };
    props.timeZone = 'America/Los_Angeles';
    props.now = Date.parse('2026-10-01T00:30:00Z');
    render();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${en['schedules.repeat.label']}"]`)!
        .click();
    });
    await act(async () => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent === en['schedules.repeat.daily']
      )!;
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      option.click();
    });
    expect(field(en['schedules.repeat.at']).value).toBe('02:21');
    const tab = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (entry) => entry.textContent === name
      )!;
    act(() => tab(en['schedules.trigger.manual']).click());
    act(() => tab(en['schedules.trigger.timed']).click());
    submit();
    expect(vi.mocked(props.onSave).mock.calls[0]![0].trigger).toEqual({
      kind: 'cron',
      expression: '21 2 * * *',
      timeZone: 'America/Los_Angeles',
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(`[aria-label="${en['schedules.repeat.label']}"]`)!
        .click();
    });
    await act(async () => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (item) => item.textContent === en['schedules.repeat.once']
      )!;
      option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      option.click();
    });
    expect(field(en['schedules.repeat.runAt']).value).toBe('2026-09-30T18:30');
    expect(container.querySelector('[aria-atomic="true"]')!.textContent).toContain('6:30 PM');
    submit();
    expect(vi.mocked(props.onSave).mock.calls[1]![0].trigger).toEqual({
      kind: 'once',
      at: '2026-10-01T01:30:00.000Z',
    });
  });

  it('marks unfinished fields only once the person tries to save, and focuses the first', () => {
    props.initial = { ...props.initial, title: '', prompt: '' };
    render();
    expect(marks()).toEqual([]);
    submit();
    expect(props.onSave).not.toHaveBeenCalled();
    expect(marks()).toEqual([en['schedules.requireName'], en['schedules.requirePrompt']]);
    expect(document.activeElement).toBe(field(en['schedules.name']));
    // Nothing is listed at the bottom; the footer only points at the marks.
    expect(footer().textContent).toBe(en['schedules.fixMarked']);
    type(en['schedules.name'], 'Daily review');
    expect(marks()).toEqual([en['schedules.requirePrompt']]);
  });

  it('marks a real conflict at once and keeps it off the footer', () => {
    props.agentBar = ({ revealMissing }) => (
      <span data-testid="run-bar">{revealMissing ? 'revealed' : 'quiet'}</span>
    );
    props.issues = [
      { field: 'agent', kind: 'invalid', message: en['schedules.destination.agentMismatch'] },
    ];
    render();
    expect(button().disabled).toBe(false);
    expect(footer().textContent).toBe('');
    submit();
    expect(props.onSave).not.toHaveBeenCalled();
    // The Agent controls own the Agent mark and are told the person tried to save.
    expect(container.querySelector('[data-testid="run-bar"]')!.textContent).toBe('revealed');
  });

  it('puts a reason that belongs to no control beside Save and blocks it', () => {
    props.issues = [{ field: 'form', kind: 'invalid', message: en['schedules.workspaceNotReady'] }];
    render();
    expect(button().disabled).toBe(true);
    expect(footer().textContent).toContain(en['schedules.workspaceNotReady']);
    submit();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('rejects an invalid expression it was opened with', () => {
    props.initial = {
      ...props.initial,
      trigger: { kind: 'cron', expression: 'invalid', timeZone: 'Asia/Shanghai' },
    };
    render();
    expect(container.textContent).toContain(en['schedules.invalidTime']);
    submit();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('does not resubmit while saving', () => {
    props.saving = true;
    render();
    submit();
    expect(button().textContent).toBe(en['schedules.saving']);
    expect(button().disabled).toBe(true);
    expect(props.onSave).not.toHaveBeenCalled();
  });
});

describe('Time rules a person opens', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSave: ReturnType<typeof vi.fn>;
  beforeAll(async () => {
    if (!i18next.isInitialized)
      await i18next.use(initReactI18next).init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    onSave = vi.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  /**
   * A fresh root per case: `initial` seeds uncontrolled editor state, so
   * re-rendering the same root would keep the previous rule's picker.
   */
  const open = (
    trigger: ComponentProps<typeof ScheduleForm>['initial']['trigger'],
    timeZone = 'Asia/Shanghai'
  ) => {
    act(() => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    act(() =>
      root.render(
        <ScheduleForm
          now={NOW}
          saving={false}
          onSave={onSave}
          timeZone={timeZone}
          initial={{
            title: 'Daily review',
            prompt: 'Review recent changes.',
            trigger,
            misfire: 'run_once',
            overlap: 'queue_one',
          }}
        />
      )
    );
  };
  const submit = () =>
    act(() => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  const repeatValue = () =>
    container.querySelector(`[aria-label="${en['schedules.repeat.label']}"]`)!.textContent;

  it('opens a weekday rule as “Every weekday”, not as cron text', () => {
    open({ kind: 'cron', expression: '0 9 * * MON-FRI', timeZone: 'Asia/Shanghai' });
    expect(repeatValue()).toBe(en['schedules.repeat.weekdays']);
    expect(container.querySelector(`[aria-label="${en['schedules.expression']}"]`)).toBeNull();
  });

  it('opens each named rule under its own name', () => {
    const cases: [ComponentProps<typeof ScheduleForm>['initial']['trigger'], string][] = [
      [{ kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' }, en['schedules.repeat.daily']],
      [{ kind: 'cron', expression: '0 9 * * 1,3', timeZone: 'UTC' }, en['schedules.repeat.weekly']],
      [{ kind: 'cron', expression: '0 9 5 * *', timeZone: 'UTC' }, en['schedules.repeat.monthly']],
      [
        { kind: 'cron', expression: '*/15 * * * *', timeZone: 'UTC' },
        en['schedules.repeat.minutes'],
      ],
      [{ kind: 'cron', expression: '0 */6 * * *', timeZone: 'UTC' }, en['schedules.repeat.hours']],
      [{ kind: 'once', at: '2026-09-07T01:00:00.000Z' }, en['schedules.repeat.once']],
      [
        { kind: 'interval', everyMs: 7 * 60_000, anchorAt: '2026-09-06T00:00:00.000Z' },
        en['schedules.repeat.minutes'],
      ],
    ];
    for (const [trigger, label] of cases) {
      open(trigger);
      expect(repeatValue()).toBe(label);
    }
  });

  it('shows a rule it cannot name read-only, and re-emits it byte for byte', () => {
    const trigger = {
      kind: 'cron',
      expression: '*/20 9-17 * * 1-5',
      timeZone: 'Asia/Shanghai',
    } as const;
    open(trigger);
    // No cron text box anywhere, and no picker either: only the summary and
    // a Replace action.
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.querySelector(`[aria-label="${en['schedules.repeat.label']}"]`)).toBeNull();
    expect(container.textContent).toContain('*/20 9-17 * * 1-5');
    expect(
      [...container.querySelectorAll('button')].some(
        (button) => button.textContent === en['schedules.repeat.replace']
      )
    ).toBe(true);
    submit();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0].trigger).toEqual(trigger);
  });

  it('replaces an unsupported rule with a named one only on request', () => {
    open({ kind: 'cron', expression: '*/20 9-17 * * 1-5', timeZone: 'Asia/Shanghai' });
    act(() => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === en['schedules.repeat.replace'])!
        .click();
    });
    expect(repeatValue()).toBe(en['schedules.repeat.daily']);
    submit();
    expect(onSave.mock.calls[0]![0].trigger).toEqual({
      kind: 'cron',
      expression: '0 9 * * *',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('opens a manual task without a time rule, and saves it as manual', () => {
    open({ kind: 'manual' });
    expect(container.querySelector(`[aria-label="${en['schedules.repeat.label']}"]`)).toBeNull();
    expect(container.textContent).toContain(en['schedules.trigger.manualHelp']);
    expect(container.textContent).not.toContain(en['schedules.nextRuns']);
    submit();
    expect(onSave.mock.calls[0]![0].trigger).toEqual({ kind: 'manual' });
  });

  it('switches between manual and timed without losing the time rule', () => {
    open({ kind: 'cron', expression: '30 7 * * 1-5', timeZone: 'Asia/Shanghai' });
    const tab = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
        (button) => button.textContent === name
      )!;
    act(() => tab(en['schedules.trigger.manual']).click());
    expect(container.textContent).toContain(en['schedules.trigger.manualHelp']);
    act(() => tab(en['schedules.trigger.timed']).click());
    expect(repeatValue()).toBe(en['schedules.repeat.weekdays']);
    submit();
    // Untouched, so the stored spelling comes back exactly.
    expect(onSave.mock.calls[0]![0].trigger).toEqual({
      kind: 'cron',
      expression: '30 7 * * 1-5',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('opens a day-of-month list as a monthly rule with those days pressed', () => {
    open({ kind: 'cron', expression: '0 9 1,15 * *', timeZone: 'Asia/Shanghai' });
    expect(repeatValue()).toBe(en['schedules.repeat.monthly']);
    const pressed = [...container.querySelectorAll('[aria-pressed="true"]')].map(
      (el) => el.textContent
    );
    expect(pressed).toEqual(['1', '15']);
    // Toggle the 28th on; only that field changes.
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Day 28"]')!.click());
    submit();
    expect(onSave.mock.calls[0]![0].trigger).toEqual({
      kind: 'cron',
      expression: '0 9 1,15,28 * *',
      timeZone: 'Asia/Shanghai',
    });
  });

  it('re-emits a named rule unchanged when the person only edited the prompt', () => {
    // `MON-FRI` is not how this editor spells the workweek, but re-saving an
    // untouched rule must not rewrite it and invalidate its fingerprint.
    const trigger = {
      kind: 'cron',
      expression: '0 9 * * MON-FRI',
      timeZone: 'Asia/Shanghai',
    } as const;
    open(trigger);
    act(() => {
      const prompt = container.querySelector<HTMLTextAreaElement>(
        `[aria-label="${en['schedules.prompt']}"]`
      )!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        prompt,
        'Different prompt.'
      );
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    });
    submit();
    expect(onSave.mock.calls[0]![0].trigger).toBe(trigger);
    expect(onSave.mock.calls[0]![0].prompt).toBe('Different prompt.');
  });

  it('shows the preview on the machine’s clock', () => {
    open(
      { kind: 'cron', expression: '0 9 * * *', timeZone: 'America/New_York' },
      'America/New_York'
    );
    const preview = container.querySelector('[aria-live="polite"]')!;
    expect(preview.textContent).toContain(en['schedules.nextRuns']);
    expect(preview.textContent).toContain('America/New_York');
  });
});
