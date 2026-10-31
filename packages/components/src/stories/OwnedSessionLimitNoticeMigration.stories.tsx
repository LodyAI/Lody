import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { SessionLimitNotice } from '@/components/chat/session-limit-notice';

const styles = stylex.create({
  frame: { padding: 16, maxWidth: 720 },
  result: { display: 'block', marginTop: 12, fontSize: 12 },
});

function NoticeFixture({
  withAction = true,
  message = 'This workspace has reached its free session limit of 10.',
  actionLabel = 'Upgrade plan',
}: {
  withAction?: boolean;
  message?: string;
  actionLabel?: string;
}) {
  const [upgrades, setUpgrades] = useState(0);
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    frame.current?.setAttribute('data-notice-ready', 'true');
  }, []);
  return (
    <div ref={frame} data-session-limit-fixture {...stylex.props(styles.frame)}>
      <SessionLimitNotice
        message={message}
        actionLabel={withAction ? actionLabel : undefined}
        onUpgrade={() => setUpgrades((count) => count + 1)}
      />
      <output data-upgrade-result {...stylex.props(styles.result)}>
        Upgrades {upgrades}
      </output>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedSessionLimitNotice',
  component: NoticeFixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof NoticeFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithAction: Story = {};
export const WithoutAction: Story = { args: { withAction: false } };
export const EmptyActionLabel: Story = { args: { actionLabel: '' } };
export const LongMessage: Story = {
  args: {
    message:
      'This workspace has reached its free session limit of 10. Upgrade your plan to keep all existing conversations and start another session without changing your current draft. 当前工作区已达到免费会话数量上限。',
  },
};
