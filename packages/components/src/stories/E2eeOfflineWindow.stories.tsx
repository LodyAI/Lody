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
    <div className="w-[300px] bg-sidebar p-3 text-sm text-sidebar-foreground">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-sidebar-foreground-muted">
        <span className="min-w-0 truncate">MacBook Pro</span>
        <E2eeMachineWindowPillView window={window} now={now} />
      </div>
      <p className="mt-4 rounded-md bg-popover px-3 py-2 text-xs text-popover-foreground shadow">
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
