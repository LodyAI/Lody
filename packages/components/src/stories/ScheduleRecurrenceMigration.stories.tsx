import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { ScheduleRecurrence } from '@lody/shared';
import { ScheduleRecurrenceEditor } from '../components/schedules/schedule-recurrence-editor';
import { scheduleCardProps } from '../components/schedules/schedule-property-row';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  card: { width: 480, maxWidth: '100%' },
  large: { fontSize: 18 },
});
const meta = {
  title: 'Schedules/RecurrenceMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture({
  initial,
  disabled = false,
  large = false,
}: {
  initial: ScheduleRecurrence;
  disabled?: boolean;
  large?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div {...stylex.props(styles.canvas, large && styles.large)} data-settings-surface>
      <div {...scheduleCardProps(stylex.props(styles.card).className)}>
        <ScheduleRecurrenceEditor
          value={value}
          onChange={setValue}
          now={Date.parse('2026-10-22T09:00:00.000Z')}
          timeZone="Asia/Shanghai"
          disabled={disabled}
        />
      </div>
      <output aria-label="Current recurrence" hidden>
        {JSON.stringify(value)}
      </output>
    </div>
  );
}
const weekly: ScheduleRecurrence = {
  kind: 'weekly',
  weekdays: [1, 3, 5],
  hour: 9,
  minute: 30,
  timeZone: 'Asia/Shanghai',
};
const monthly: ScheduleRecurrence = {
  kind: 'monthly',
  days: [1, 15, 31],
  hour: 9,
  minute: 30,
  timeZone: 'Asia/Shanghai',
};
export const Weekly: Story = { render: () => <Fixture initial={weekly} /> };
export const Monthly: Story = { render: () => <Fixture initial={monthly} /> };
export const LargeMonthly: Story = { render: () => <Fixture initial={monthly} large /> };
export const DisabledWeekly: Story = { render: () => <Fixture initial={weekly} disabled /> };
export const DisabledMonthly: Story = { render: () => <Fixture initial={monthly} disabled /> };
export const Once: Story = {
  render: () => <Fixture initial={{ kind: 'once', at: '2026-10-23T01:30:00.000Z' }} />,
};
export const Unsupported: Story = {
  render: () => (
    <Fixture
      initial={{
        kind: 'unsupported',
        trigger: { kind: 'cron', expression: '0 9 L * *', timeZone: 'Asia/Shanghai' },
      }}
    />
  ),
};
export const DisabledUnsupported: Story = {
  render: () => (
    <Fixture
      initial={{
        kind: 'unsupported',
        trigger: { kind: 'cron', expression: '0 9 L * *', timeZone: 'Asia/Shanghai' },
      }}
      disabled
    />
  ),
};
