import { colors as uiColors } from '@lody/ui/tokens/colors.stylex';
import { corner as uiCorner, radius as uiRadius, text as uiText } from '@lody/ui/tokens/scales.stylex';
import * as stylex from '@stylexjs/stylex';
import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import type { SessionAutoDelivery } from '@lody/shared';
import type { AutoDeliverOptions } from '@lody/shared/automations';
import {
  AutoDeliveryDialog,
  DEFAULT_AUTO_DELIVER_OPTIONS,
  SessionAutoDeliveryNote,
} from '@/components/sessions/session-auto-delivery';
import {
  SessionContinuationTweaks,
  type SessionContinuationTweaksValue,
} from '@/components/sessions/session-continuation-tweaks';
import { SessionRowStatusIndicator } from '@/components/sidebar-row-shared';
import { ConversationColumn } from '@/components/shared/conversation-column';

/**
 * Auto delivery across its three surfaces: the Info Bar dialog, the fourth switch
 * under More > Automation, and the in-conversation status line. The sidebar mark
 * shows only when delivery stalled and needs the person.
 */
const meta = {
  title: 'Sessions/SessionAutoDelivery',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Popover({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        width: 340,
        padding: 14,
        borderRadius: 12,
        background: 'var(--popover)',
        color: 'var(--popover-foreground)',
        boxShadow: 'var(--shadow-popover)',
      }}
    >
      {children}
    </div>
  );
}

/** Info Bar → Auto delivery: pick the steps, then start. Merge starts off. */
export const StartDialog: Story = {
  render: () => <AutoDeliveryDialog open onOpenChange={fn()} onStart={fn()} />,
};

function Tweaks({ on }: { on: boolean }) {
  const [value, setValue] = useState<SessionContinuationTweaksValue>({
    recoverCapacity: false,
    archiveAfterMerge: true,
    compactWhenIdle: false,
    autoDeliver: on,
  });
  const [options, setOptions] = useState<AutoDeliverOptions>({
    ...DEFAULT_AUTO_DELIVER_OPTIONS,
    merge: true,
  });
  return (
    <Popover>
      <SessionContinuationTweaks
        value={value}
        onChange={(key, checked) => setValue((current) => ({ ...current, [key]: checked }))}
        autoDeliverOptions={options}
        onAutoDeliverOptionsChange={setOptions}
      />
    </Popover>
  );
}

/** More → Automation, with Auto delivery off. */
export const AutomationMenuOff: Story = { render: () => <Tweaks on={false} /> };

/** More → Automation, with Auto delivery on and its steps shown under the switch. */
export const AutomationMenuOn: Story = { render: () => <Tweaks on /> };

const STATES: SessionAutoDelivery[] = (
  [
    { state: 'pr' },
    { state: 'ci' },
    { state: 'fix', attempt: 2 },
    { state: 'conflict', attempt: 1 },
    { state: 'merge' },
    { state: 'ready' },
    { state: 'merged' },
    { state: 'stalled', reason: 'ci_limit' },
    { state: 'stalled', reason: 'merge_blocked' },
    { state: 'stalled', reason: 'no_new_commit' },
  ] as const
).map((status) => ({ ...status, updatedAt: 0 }));

/** The in-conversation line for every state: Turn off follows the text; a merge can be dismissed. */
export const ConversationStatusLine: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div {...stylex.props(themeStyles.glyph)}>
      <ConversationColumn>
        {STATES.map((status) => (
          <SessionAutoDeliveryNote
            key={`${status.state}-${status.reason ?? ''}`}
            status={status}
            onTurnOff={fn()}
            onDismiss={fn()}
          />
        ))}
      </ConversationColumn>
    </div>
  ),
};

/** The sidebar mark: stalled delivery outranks unread, but not working or permission. */
export const SidebarMarks: Story = {
  render: () => (
    <div {...stylex.props(themeStyles.column)}>
      {(
        [
          ['Stalled, needs you', { needsAttention: true }],
          ['Stalled while working', { needsAttention: true, isWorking: true }],
          ['Stalled and unread', { needsAttention: true, hasUnreadMessages: true }],
          ['Unread', { hasUnreadMessages: true }],
          ['Waiting for permission', { isWaitingPermission: true }],
        ] as const
      ).map(([label, flags]) => (
        <div key={label} {...stylex.props(themeStyles.row)}>
          <span>{label}</span>
          <SessionRowStatusIndicator {...flags} />
        </div>
      ))}
    </div>
  ),
};

const themeStyles = stylex.create({
  glyph: { width: '720px', maxWidth: '100vw', backgroundColor: uiColors.background, paddingBlock: 'calc(var(--spacing) * 4)' },
  column: { display: 'flex', flexDirection: 'column', gap: 'calc(var(--spacing) * 2)', fontSize: uiText.subheadlineSize, lineHeight: uiText.subheadlineLeading },
  row: { display: 'flex', width: 'calc(var(--spacing) * 64)', alignItems: 'center', justifyContent: 'space-between', borderRadius: uiRadius.small, cornerShape: uiCorner.shape, paddingInline: 'calc(var(--spacing) * 2)', paddingBlock: 'calc(var(--spacing) * 1)' },
});
