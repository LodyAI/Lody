// @vitest-environment jsdom
import { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { ScheduleRegistryRow } from '@lody/shared';
import en from '../../../locales/en.json';
import { ScheduleListView } from '../src/components/schedules/schedule-view';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-09-06T09:12:00+08:00');
const base = {
  ownerId: 'owner',
  machineId: 'machine',
  enabled: true,
  activationId: 'a',
  activeFrom: 0,
  createdAt: 0,
  updatedAt: 0,
  destination: { kind: 'new_session' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: 'f',
} as unknown as ScheduleRegistryRow;
const manual = {
  ...base,
  scheduleId: 'm',
  title: 'Deploy checklist',
  trigger: { kind: 'manual' },
} as ScheduleRegistryRow;
const timed = {
  ...base,
  scheduleId: 't',
  title: 'Nightly review',
  trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'UTC' },
} as ScheduleRegistryRow;
const context = () => ({
  machine: 'MacBook Pro',
  agent: 'Code reviewer',
  project: null,
  presence: 'online' as const,
  canToggle: true,
  canRun: true,
  canDelete: true,
});

describe('schedule list rows', () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = {
    onOpen: vi.fn(),
    onNew: vi.fn(),
    onToggle: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
    onColumnWidthsChange: vi.fn(),
  };
  beforeAll(async () => {
    if (!i18next.isInitialized)
      await i18next.use(initReactI18next).init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  });
  beforeEach(() => {
    Object.values(handlers).forEach((fn) => fn.mockReset());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <ScheduleListView
          rows={[manual, timed]}
          runtimes={[]}
          ready
          now={NOW}
          contextForRow={context}
          {...handlers}
        />
      )
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const rowOf = (title: string) =>
    [...container.querySelectorAll('.group')].find((row) => row.textContent?.includes(title))!;
  const buttonIn = (row: Element, label: string) =>
    row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it('gives a manual task a Run button and a timed one a Pause button', () => {
    const manualRow = rowOf('Deploy checklist');
    expect(buttonIn(manualRow, en['schedules.pause'])).toBeNull();
    act(() => buttonIn(manualRow, en['schedules.runNow'])!.click());
    expect(handlers.onRun).toHaveBeenCalledWith(manual);
    const timedRow = rowOf('Nightly review');
    expect(buttonIn(timedRow, en['schedules.runNow'])).toBeNull();
    act(() => buttonIn(timedRow, en['schedules.pause'])!.click());
    expect(handlers.onToggle).toHaveBeenCalledWith(timed);
  });

  it('offers run, pause and delete from the row’s context menu', () => {
    act(() => {
      rowOf('Nightly review').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })
      );
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      en['schedules.open'],
      en['schedules.runNow'],
      en['schedules.pause'],
      en['schedules.delete'],
    ]);
    act(() => (items[3] as HTMLElement).click());
    expect(handlers.onDelete).toHaveBeenCalledWith(timed);
  });

  it('resizes a column from the header with the keyboard, within bounds', () => {
    const handle = container.querySelector<HTMLElement>(
      `[role="separator"][aria-label="Resize ${en['schedules.column.name']}"]`
    )!;
    act(() => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(handlers.onColumnWidthsChange).toHaveBeenLastCalledWith({
      name: 316,
      frequency: 150,
      next: 140,
    });
    for (let i = 0; i < 40; i += 1)
      act(() => {
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      });
    expect(handle.getAttribute('aria-valuenow')).toBe('72');
  });

  it('closes the open schedule on a blank click, but not from a row, a control or a popup', () => {
    const onBlankClick = vi.fn();
    const portal = document.createElement('div');
    document.body.append(portal);
    act(() =>
      root.render(
        <ScheduleListView
          rows={[manual, timed]}
          runtimes={[]}
          ready
          now={NOW}
          contextForRow={context}
          {...handlers}
          selectedId="t"
          onBlankClick={onBlankClick}
          renderBody={(table) => (
            <div data-testid="split">
              {table}
              <div data-schedule-detail="">
                <span data-testid="detail-text">Editor</span>
              </div>
              {/* A menu or select popup: portalled out, yet its clicks bubble here. */}
              {createPortal(<span data-testid="popup">Option</span>, portal)}
            </div>
          )}
        />
      )
    );
    const click = (element: Element) =>
      act(() => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    click(rowOf('Nightly review').querySelector('span')!);
    click(container.querySelector('input')!);
    click(container.querySelector('[data-testid="detail-text"]')!);
    click(portal.querySelector('[data-testid="popup"]')!);
    expect(onBlankClick).not.toHaveBeenCalled();
    click(container.querySelector('header')!);
    click(container.querySelector('[data-testid="split"]')!);
    expect(onBlankClick).toHaveBeenCalledTimes(2);
    portal.remove();
  });
});
