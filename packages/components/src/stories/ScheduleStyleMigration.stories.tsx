import type { CSSProperties, ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { FieldIssueMark } from '../components/schedules/schedule-field-issue-mark';
import {
  PropertyRow,
  PropertyRowWide,
  scheduleCardProps,
} from '../components/schedules/schedule-property-row';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';
import { cn } from '../lib/utils';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  card: { maxWidth: '100%', width: 520 },
  narrow: { width: 240 },
  child: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  full: { width: '100%' },
  marks: { display: 'flex', flexDirection: 'column', gap: themeSpace[6], padding: themeSpace[4] },
  markRow: { display: 'flex', alignItems: 'center', gap: themeSpace[3] },
});

const meta = {
  title: 'Schedules/StyleMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ children, variables = false }: { children: ReactNode; variables?: boolean }) {
  const overrides = variables
    ? ({
        '--spacing': '0.375rem',
        '--status-warning': '280 70% 45%',
        '--muted-foreground': '185 50% 35%',
        fontSize: 18,
      } as CSSProperties)
    : undefined;
  return (
    <div {...stylex.props(styles.canvas)} style={overrides} data-settings-surface>
      <p>Schedule styles · Ready</p>
      {children}
    </div>
  );
}

function WideRows({ narrow = false }: { narrow?: boolean }) {
  return (
    <div
      {...scheduleCardProps(stylex.props(styles.card, narrow && styles.narrow).className)}
      data-schedule-style-rows
    >
      <PropertyRowWide label="Agent">
        <Button variant="ghost" size="small" className={stylex.props(styles.full).className}>
          <span {...stylex.props(styles.child)}>A coding agent with a long descriptive name</span>
        </Button>
      </PropertyRowWide>
      <PropertyRowWide label="The previous run is still in progress 上一次运行仍在进行时">
        <span {...stylex.props(styles.child)}>Repository / long-project-name / workspace</span>
      </PropertyRowWide>
      <PropertyRowWide label="Child constraints">
        <span className={cn(stylex.props(styles.child).className, 'min-w-[36rem] max-w-none')}>
          A child with conflicting minimum and maximum utility widths must still shrink
        </span>
      </PropertyRowWide>
      <PropertyRowWide label="Multiple controls">
        <Button variant="ghost" size="small">
          First choice
        </Button>
        <Button variant="ghost" size="small">
          Second choice
        </Button>
      </PropertyRowWide>
      <PropertyRow label="Existing row" hint="The wide row keeps the same trailing inset.">
        <Button size="small">Reference</Button>
      </PropertyRow>
    </div>
  );
}

const single = ['A machine is required.'];
const multiple = [
  'Select an agent on an available machine.',
  'The destination must belong to this workspace.',
  'A long unbroken detail: /workspace/project/schedules/a-very-long-destination-name',
];

function IssueMarks() {
  return (
    <div {...stylex.props(styles.marks)}>
      <div {...stylex.props(styles.markRow)} data-schedule-style-marker="empty">
        <span>No issue</span>
        <FieldIssueMark messages={[]} />
      </div>
      <div {...stylex.props(styles.markRow)} data-schedule-style-marker="single">
        <span>One issue</span>
        <FieldIssueMark messages={single} />
      </div>
      <div {...stylex.props(styles.markRow)} data-schedule-style-marker="multiple">
        <span>Multiple issues</span>
        <FieldIssueMark messages={multiple} />
      </div>
    </div>
  );
}

export const WideRowsDefault: Story = {
  render: () => (
    <Frame>
      <WideRows />
    </Frame>
  ),
};
export const WideRowsNarrow: Story = {
  render: () => (
    <Frame>
      <WideRows narrow />
    </Frame>
  ),
};
export const Issues: Story = {
  render: () => (
    <Frame>
      <IssueMarks />
    </Frame>
  ),
};
export const CallerOverrides: Story = {
  render: () => (
    <Frame>
      <div {...stylex.props(styles.marks)}>
        <div {...stylex.props(styles.markRow)} data-schedule-style-marker="caller">
          <span>Caller classes</span>
          <FieldIssueMark
            messages={single}
            className="block size-8 shrink rounded-none text-destructive"
          />
        </div>
        <div {...stylex.props(styles.markRow)} data-schedule-style-marker="caller-padding">
          <span>Caller padding and alignment</span>
          <FieldIssueMark
            messages={multiple}
            className="size-10 items-end justify-end p-1 text-primary"
          />
        </div>
      </div>
    </Frame>
  ),
};
export const ThemeVariables: Story = {
  render: () => (
    <Frame variables>
      <WideRows narrow />
      <IssueMarks />
    </Frame>
  ),
};
