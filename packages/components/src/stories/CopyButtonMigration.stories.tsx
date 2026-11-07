import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { CopyButton } from '../ui/copy-button';
import {
  CollapsibleCard,
  CollapsibleCardHeader,
  CollapsibleCardTitle,
  CollapsibleCardContent,
} from '../ui/collapsible-card';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[6],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  column: {
    display: 'flex',
    width: 480,
    maxWidth: '100%',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: themeSpace[4],
  },
  value: { maxWidth: '100%', overflowWrap: 'anywhere' },
  output: { minHeight: 24 },
  consumer: { width: '100%' },
  consumerContent: { padding: themeSpace[3] },
});
const text = 'Synthetic clipboard fixture 中文 — first line\nsecond line';
const meta = {
  title: 'UI/CopyButtonMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Fixture({ empty = false, disabled = false, long = false }) {
  const [bubbles, setBubbles] = useState(0);
  const value = empty
    ? ''
    : long
      ? `${text} / very-long-value-preserves-button-geometry-${'cjk中文-'.repeat(12)}`
      : text;
  return (
    <div {...stylex.props(styles.canvas)}>
      <div
        {...stylex.props(styles.column)}
        data-copy-fixture
        onClick={() => setBubbles((current) => current + 1)}
      >
        <code {...stylex.props(styles.value)}>{empty ? '(empty value)' : value}</code>
        <CopyButton value={value} disabled={disabled} aria-label="Copy fixture value" />
        <output data-copy-events {...stylex.props(styles.output)}>
          Parent clicks: {bubbles}
        </output>
        <button type="button" data-copy-after>
          After copy button
        </button>
      </div>
    </div>
  );
}

export const Interactive: Story = { render: () => <Fixture /> };
export const EmptyValue: Story = { render: () => <Fixture empty /> };
export const Disabled: Story = { render: () => <Fixture disabled /> };
export const LongValue: Story = { render: () => <Fixture long /> };
export const ConsumerCard: Story = {
  render: () => (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)} data-copy-consumer>
        <CollapsibleCard defaultOpen className={stylex.props(styles.consumer).className}>
          <CollapsibleCardHeader position="relative">
            <CollapsibleCardTitle title="Synthetic consumer card title 中文">
              Synthetic consumer card title 中文
            </CollapsibleCardTitle>
          </CollapsibleCardHeader>
          <CollapsibleCardContent noInternalScroll>
            <p {...stylex.props(styles.consumerContent)}>
              The real consumer reveals its copy action on group hover.
            </p>
          </CollapsibleCardContent>
        </CollapsibleCard>
      </div>
    </div>
  ),
};
