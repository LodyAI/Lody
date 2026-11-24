import { colors as uiColors, shadow as uiShadow } from '@lody/ui/tokens/colors.stylex';
import { corner as uiCorner, radius as uiRadius, text as uiText } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import {
  E2eeMachineWindowPillView,
  E2eeOfflineSummaryText,
} from '@/components/e2ee-offline-window';

const HOUR = 3_600_000;

/** The machine group header as the sidebar draws it while the encrypted workspace works
 * from its outage window, with the hover sentence for the workspace's Offline mark. */
function Preview({ now }: { now: number }) {
  const window = { executionUntilMs: 4 * HOUR, offlineSinceMs: 0 };
  return (
    <div {...stylex.props(previewStyles.copy)}>
      <div {...stylex.props(themeStyles.row)}>
        <span {...stylex.props(themeStyles.glyph)}>MacBook Pro</span>
        <E2eeMachineWindowPillView window={window} now={now} />
      </div>
      <p {...stylex.props(previewStyles.copy2)}>
        <E2eeOfflineSummaryText window={window} now={now} />
      </p>
    </div>
  );
}

const meta = {
  title: 'Components/E2eeOfflineWindow',
  component: Preview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 48 minutes without the server: 3:12 of the 4-hour execution window left. */
export const MachineWorking: Story = { args: { now: 48 * 60_000 } };
/** Past the window: new work waits until the machine reaches the server again. */
export const MachinePaused: Story = { args: { now: 4 * HOUR + 60_000 } };

const themeStyles = stylex.create({
  row: { display: 'flex', alignItems: 'center', gap: 'calc(var(--spacing) * 1.5)', paddingInline: 'calc(var(--spacing) * 2)', paddingBlock: 'calc(var(--spacing) * 1)', fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, fontWeight: 500, color: uiColors.secondaryLabel },
  glyph: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

const previewStyles = stylex.create({
  copy: { width: '300px', backgroundColor: uiColors.secondaryBackground, padding: 'calc(var(--spacing) * 3)', fontSize: uiText.subheadlineSize, lineHeight: uiText.subheadlineLeading, color: uiColors.label },
  copy2: { marginTop: 'calc(var(--spacing) * 4)', borderRadius: uiRadius.small, cornerShape: uiCorner.shape, backgroundColor: uiColors.elevatedBackground, paddingInline: 'calc(var(--spacing) * 3)', paddingBlock: 'calc(var(--spacing) * 2)', fontSize: uiText.footnoteSize, lineHeight: uiText.footnoteLeading, color: uiColors.label, boxShadow: uiShadow.card },
});
