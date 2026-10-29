import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { GitHubMergeMethod } from '@lody/shared';
import { PrMergeButton } from '@/components/sessions/pr-merge-button';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 16,
    minHeight: 180,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  result: { display: 'block', marginTop: 16, fontSize: 12, color: themeColors.mutedForeground },
});

function MergeFixture({
  tone = 'ready',
  disabled = false,
  isMerging = false,
  missingHandlers = false,
}: {
  tone?: 'ready' | 'conflict' | 'neutral';
  disabled?: boolean;
  isMerging?: boolean;
  missingHandlers?: boolean;
}) {
  const [method, setMethod] = useState<GitHubMergeMethod>('merge');
  const [mergeCount, setMergeCount] = useState(0);
  const [selectedCount, setSelectedCount] = useState(0);
  const [lastMerge, setLastMerge] = useState('none');
  return (
    <div
      {...stylex.props(styles.frame)}
      data-owned-merge-fixture
      data-owned-merge-count={mergeCount}
      data-owned-merge-selected-count={selectedCount}
      data-owned-merge-last-method={lastMerge}
      data-owned-merge-method={method}
    >
      <PrMergeButton
        compact
        method={method}
        tone={tone}
        disabled={disabled}
        isMerging={isMerging}
        onMerge={
          missingHandlers
            ? undefined
            : (next) => {
                setMergeCount((count) => count + 1);
                setLastMerge(next);
              }
        }
        onSelectMethod={
          missingHandlers
            ? undefined
            : (next) => {
                setMethod(next);
                setSelectedCount((count) => count + 1);
              }
        }
      />
      <output {...stylex.props(styles.result)}>
        Method {method}; selected {selectedCount}; merge {lastMerge}; calls {mergeCount}
      </output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedMergeControl',
  component: MergeFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof MergeFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Conflict: Story = { args: { tone: 'conflict' } };
export const Neutral: Story = { args: { tone: 'neutral' } };
export const Disabled: Story = { args: { disabled: true } };
export const Merging: Story = { args: { isMerging: true } };
export const MissingHandlers: Story = { args: { missingHandlers: true } };
