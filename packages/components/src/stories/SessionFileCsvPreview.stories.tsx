import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { SessionFileCsvPreview } from '@/components/sessions/session-file-csv-preview';
import { DocumentSelectionSurface } from '@/components/sessions/document-selection-surface';
import type { DocumentSelection } from '@/lib/document-selection';

const styles = stylex.create({ frame: { width: 'min(100%, 960px)', height: '640px' } });

const meta = {
  title: 'Sessions/SessionFileCsvPreview',
  component: SessionFileCsvPreview,
  decorators: [
    (Story) => (
      <div {...stylex.props(styles.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionFileCsvPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CsvTable: Story = {
  args: {
    path: '/tmp/revenue.csv',
    active: true,
    text: 'Region,Quarter,Revenue\nNorth,Q1,125000\nSouth,Q1,98000\nEast,Q1,112000\nWest,Q1,105000\n',
  },
};

export const CsvSelection: Story = {
  args: { ...CsvTable.args },
  render: (args) => (
    <DocumentSelectionSurface
      path={args.path}
      source={args.text}
      active={args.active}
      onAdd={(selection) => {
        (window as Window & { documentSelection?: DocumentSelection }).documentSelection =
          selection;
        return true;
      }}
    >
      <SessionFileCsvPreview {...args} />
    </DocumentSelectionSurface>
  ),
};

export const TsvTable: Story = {
  args: {
    path: '/tmp/revenue.tsv',
    active: true,
    text: 'Region\tQuarter\tRevenue\nNorth\tQ1\t125000\nSouth\tQ1\t98000\n',
  },
};

export const InactiveCsvTable: Story = {
  args: { ...CsvTable.args, active: false },
};
