// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import en from '../../../locales/en.json';
import zh from '../../../locales/zh_CN.json';
import { ScheduleForm, ScheduleListView } from '../src/components/schedules/schedule-view';
import {
  describeTrigger,
  formatInstant,
  formatTimeOfDay,
  formatUpcoming,
  weekdayNames,
} from '../src/components/schedules/schedule-format';
import type { ScheduleRegistryRow, ScheduleRuntimeRow } from '@lody/shared';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-09-06T09:12:00+08:00');

const row: ScheduleRegistryRow = {
  scheduleId: 'daily-review',
  title: '每天回顾',
  ownerId: 'owner',
  machineId: 'machine',
  enabled: true,
  activationId: 'activation',
  activeFrom: 0,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'cron', expression: '0 9 * * MON-FRI', timeZone: 'Asia/Shanghai' },
  destination: { kind: 'new_session' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: '0'.repeat(64),
  projectKind: 'github',
  projectKey: 'loro-dev/lody',
};

/**
 * The product language is `zh_CN`, which every `Intl` constructor rejects with a
 * RangeError. These render the real components under it, because the pure
 * formatters were already "correct" in isolation while the pages they back
 * crashed.
 */
describe('Chinese is a product language, not an Intl locale', () => {
  let container: HTMLDivElement;
  let root: Root;
  let instance: typeof i18next;
  beforeAll(async () => {
    instance = i18next.createInstance();
    await instance.use(initReactI18next).init({
      lng: 'zh_CN',
      resources: { zh_CN: { translation: zh }, en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (node: React.ReactNode) =>
    act(() => root.render(<I18nextProvider i18n={instance}>{node}</I18nextProvider>));

  it('formats every schedule surface under zh_CN without throwing', () => {
    for (const language of ['zh_CN', 'zh-CN', 'en', '', undefined]) {
      expect(() => weekdayNames(language, 'short')).not.toThrow();
      expect(() => formatTimeOfDay(9, 0, language)).not.toThrow();
      expect(() => formatInstant(NOW, 'Asia/Shanghai', language)).not.toThrow();
      expect(() => formatUpcoming(NOW + 86_400_000, 'Asia/Shanghai', NOW, language)).not.toThrow();
      expect(() => describeTrigger(row.trigger, instance.t, language)).not.toThrow();
      expect(() =>
        describeTrigger(
          { kind: 'cron', expression: '0 9 1,15 * *', timeZone: 'UTC' },
          instance.t,
          language
        )
      ).not.toThrow();
      expect(() => describeTrigger({ kind: 'manual' }, instance.t, language)).not.toThrow();
    }
  });

  it('renders the schedule list in Chinese', () => {
    const runtimes: ScheduleRuntimeRow[] = [
      {
        scheduleId: row.scheduleId,
        machineId: row.machineId,
        activationId: row.activationId,
        observedDefinitionFingerprint: row.definitionFingerprint,
        updatedAt: 0,
        nextScheduledAt: Date.parse('2026-09-07T09:00:00+08:00'),
      },
    ];
    render(
      <ScheduleListView
        rows={[
          row,
          {
            ...row,
            scheduleId: 'weekly',
            trigger: { kind: 'cron', expression: '0 17 * * 1,3', timeZone: 'Asia/Shanghai' },
          },
        ]}
        runtimes={runtimes}
        ready
        now={NOW}
        onOpen={() => {}}
        onNew={() => {}}
        contextForRow={() => ({
          machine: 'MacBook',
          agent: '代码审查员',
          project: 'loro-dev/lody',
          presence: 'online',
          canToggle: true,
        })}
      />
    );
    expect(container.textContent).toContain('每天回顾');
    // The frequency column is a real localized sentence, not a cron expression.
    expect(container.textContent).toContain(zh['schedules.column.frequency']);
    expect(container.textContent).not.toContain('* * MON-FRI');
  });

  it('renders the editor and its weekday pickers in Chinese', () => {
    render(
      <ScheduleForm
        now={NOW}
        saving={false}
        onSave={() => {}}
        initial={{
          title: '每天回顾',
          prompt: '回顾昨天的提交。',
          trigger: { kind: 'cron', expression: '0 17 * * 1,3,5', timeZone: 'Asia/Shanghai' },
          misfire: 'run_once',
          overlap: 'queue_one',
        }}
      />
    );
    expect(container.textContent).toContain(zh['schedules.repeat.label']);
    expect(container.textContent).toContain(zh['schedules.nextRuns']);
    // Weekday toggles carry localized accessible names.
    const monday = container.querySelector('[aria-pressed="true"]');
    expect(monday).not.toBeNull();
    expect(monday!.getAttribute('aria-label')).toBeTruthy();
  });

  it('renders the monthly day grid and a manual task in Chinese', () => {
    render(
      <ScheduleForm
        now={NOW}
        saving={false}
        onSave={() => {}}
        initial={{
          title: '月度提醒',
          prompt: '起草提醒。',
          trigger: { kind: 'cron', expression: '0 9 1,15 * *', timeZone: 'Asia/Shanghai' },
          misfire: 'skip',
          overlap: 'skip',
        }}
      />
    );
    expect(container.textContent).toContain(zh['schedules.repeat.onDays']);
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(2);
    // A fresh root: `initial` seeds uncontrolled editor state.
    act(() => root.unmount());
    container.replaceChildren();
    root = createRoot(container);
    render(
      <ScheduleForm
        now={NOW}
        saving={false}
        onSave={() => {}}
        initial={{
          title: '部署清单',
          prompt: '走一遍。',
          trigger: { kind: 'manual' },
          misfire: 'skip',
          overlap: 'skip',
        }}
      />
    );
    expect(container.textContent).toContain(zh['schedules.trigger.manualHelp']);
  });
});
