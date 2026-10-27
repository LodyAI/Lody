import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { ScheduleRecurrence } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { PropertyRow, scheduleCardProps } from '../components/schedules/schedule-property-row';
import { ScheduleRecurrenceEditor } from '../components/schedules/schedule-recurrence-editor';
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
  narrow: { width: 240 },
  large: { fontSize: 18 },
  value: { maxWidth: 220, overflowWrap: 'anywhere' },
});

const meta = {
  title: 'Schedules/Migration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function PropertyRowsFixture({ narrow = false, large = false }) {
  return (
    <div {...stylex.props(styles.canvas, large && styles.large)} data-settings-surface>
      <div {...scheduleCardProps(stylex.props(styles.card, narrow && styles.narrow).className)}>
        <PropertyRow label="Frequency">
          <Button>Every weekday</Button>
        </PropertyRow>
        <PropertyRow
          label="The previous run is still in progress"
          hint="The next run waits until the current run finishes."
        >
          <Button disabled>Queue one run</Button>
        </PropertyRow>
        <PropertyRow label="Dates" align="start">
          <span {...stylex.props(styles.value)}>
            1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31
          </span>
        </PropertyRow>
      </div>
    </div>
  );
}

function RecurrenceFixture({ once = false, disabled = false }) {
  const [value, setValue] = useState<ScheduleRecurrence>(
    once
      ? { kind: 'once', at: '2026-10-23T01:30:00.000Z' }
      : {
          kind: 'weekly',
          weekdays: [1, 3, 5],
          hour: 9,
          minute: 30,
          timeZone: 'Asia/Shanghai',
        }
  );
  return (
    <div {...stylex.props(styles.canvas)} data-settings-surface>
      <div {...scheduleCardProps(stylex.props(styles.card).className)}>
        <ScheduleRecurrenceEditor
          value={value}
          onChange={setValue}
          now={Date.parse('2026-10-22T09:00:00.000Z')}
          timeZone="Asia/Shanghai"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export const PropertyRows: Story = { render: () => <PropertyRowsFixture /> };
export const NarrowPropertyRows: Story = { render: () => <PropertyRowsFixture narrow /> };
export const LargePropertyRows: Story = { render: () => <PropertyRowsFixture large /> };
export const Weekly: Story = { render: () => <RecurrenceFixture /> };
export const Once: Story = { render: () => <RecurrenceFixture once /> };
export const Disabled: Story = { render: () => <RecurrenceFixture disabled /> };
