import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { useSetAtom } from 'jotai';
import * as stylex from '@stylexjs/stylex';
import type { SessionHistoryParsed } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { SessionPin } from '../components/sessions/session-pin';
import { conversationWideModeAtom } from '../atoms/settings';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  controls: { display: 'flex', alignItems: 'center', gap: themeSpace[3], padding: themeSpace[4] },
});
const text = 'Review the local change and keep the original UI.';
const longText =
  '请检查日程与终端的布局，保留特殊值和原有交互。 This is a long pinned message to verify clipping, CJK glyphs and shared conversation column alignment. '.repeat(
    5
  );
const entry = (message: string, role: 'user' | 'assistant' = 'user'): SessionHistoryParsed => ({
  id: 'migration-pinned-message',
  role,
  items: [{ type: 'text', text: message }],
  status: undefined,
  read: true,
  timestamp: '2026-10-22T09:00:00Z',
  endedAt: undefined,
  userId: 'fixture-user',
  modelInfo: undefined,
  fileDiff: undefined,
  finished: true,
  plan: undefined,
});
function Fixture({
  long = false,
  empty = false,
  invalid = false,
}: {
  long?: boolean;
  empty?: boolean;
  invalid?: boolean;
}) {
  const [pinned, setPinned] = useState(true);
  const [lastAction, setLastAction] = useState('Ready');
  const setWide = useSetAtom(conversationWideModeAtom);
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.controls)}>
        <Button onClick={() => setWide((value) => !value)}>Toggle wide mode</Button>
        <output aria-label="Pin action">{lastAction}</output>
      </div>
      <SessionPin
        pinnedHistoryId={pinned ? 'migration-pinned-message' : null}
        pinnedMessage={entry(
          empty ? '   ' : long ? longText : text,
          invalid ? 'assistant' : 'user'
        )}
        onUnpin={() => {
          setPinned(false);
          setLastAction('Unpinned');
        }}
        onScrollToMessage={(id) => setLastAction(`Scrolled to ${id}`)}
      />
    </div>
  );
}
const meta = {
  title: 'Sessions/PinMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = { render: () => <Fixture /> };
export const LongText: Story = { render: () => <Fixture long /> };
export const EmptyText: Story = { render: () => <Fixture empty /> };
export const InvalidRole: Story = { render: () => <Fixture invalid /> };
