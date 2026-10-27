import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@lody/ui/tooltip';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { SessionFileDiffNoticeCard } from '../components/sessions/session-file-diff-notice-card';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
  type SessionChatStreamViewProps,
} from '../components/ai-gui/view';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  noticeCanvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  output: { display: 'block', paddingBottom: themeSpace[3] },
  streamCanvas: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    minHeight: 0,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  streamOutput: { padding: themeSpace[3], flexShrink: 0 },
  stream: { position: 'relative', flex: '1 1 0%', minHeight: 0, minWidth: 0 },
});
const filePath = 'src/local/alpha-notice.ts';
const longPath = 'src/本地工作区/' + 'long-directory/'.repeat(7) + 'preserve-original-colour.ts';
function NoticeFixture({
  long = false,
  overrides = false,
}: {
  long?: boolean;
  overrides?: boolean;
}) {
  const [action, setAction] = useState('Ready');
  return (
    <div {...stylex.props(styles.noticeCanvas)} data-alpha-notice>
      <output {...stylex.props(styles.output)} aria-label="Notice action">
        {action}
      </output>
      <SessionFileDiffNoticeCard
        filePath={long ? longPath : filePath}
        message={
          long
            ? 'A long synthetic unavailable-file notice. Preserve the current wrapping, clipping and keyboard behavior. 原本文件不可用说明。'.repeat(
                3
              )
            : 'Synthetic file contents are unavailable. Preserve the original notice.'
        }
        className={
          overrides
            ? 'max-w-[620px] rounded-none border-2 border-primary/40 shadow-none'
            : undefined
        }
        onOpenFile={(path) => setAction(`Opened ${path}`)}
      />
    </div>
  );
}
const sessionId = 'alpha-surface-session' as SessionId;
const renderMessageRow: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId: id,
}) => <MessageRowView message={message} sessionId={id} />;
function ToolFixture({
  status = 'completed',
  kind = 'read',
}: {
  status?: 'completed' | 'failed' | 'in_progress';
  kind?: 'read' | 'execute';
}) {
  const [action, setAction] = useState('Ready');
  const items = useMemo<ChatStreamItem[]>(() => {
    const message: SessionHistoryParsed = {
      id: 'alpha-tool-turn',
      role: 'assistant',
      timestamp: '2026-10-22T09:00:00.000Z',
      read: true,
      finished: status !== 'in_progress',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'alpha-tool-call',
          kind,
          status,
          title: kind === 'read' ? 'Read src/local/alpha-source.ts' : 'Run local alpha check',
          ...(kind === 'read'
            ? { locations: [{ path: 'src/local/alpha-source.ts' }] }
            : {
                content: [
                  {
                    type: 'content',
                    content: { type: 'text', text: 'Synthetic local tool output.' },
                  },
                ],
              }),
        },
      ],
    };
    return [{ type: 'message', sessionId, message, turnIndex: 0 }];
  }, [status, kind]);
  return (
    <Tooltip.Provider>
      <div {...stylex.props(styles.streamCanvas)} data-alpha-tools>
        <output {...stylex.props(styles.streamOutput)} aria-label="Tool action">
          {action}
        </output>
        <div {...stylex.props(styles.stream)}>
          <SessionChatStreamView
            sessionId={sessionId}
            items={items}
            renderMessageRow={renderMessageRow}
            onFilePathClick={(path) => setAction(`Opened ${path}`)}
          />
        </div>
      </div>
    </Tooltip.Provider>
  );
}
const meta = {
  title: 'Migration/AlphaSurfaces',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Notice: Story = { render: () => <NoticeFixture /> };
export const LongNotice: Story = { render: () => <NoticeFixture long /> };
export const NoticeCallerOverrides: Story = { render: () => <NoticeFixture overrides /> };
export const ReadCompleted: Story = { render: () => <ToolFixture /> };
export const ReadFailed: Story = { render: () => <ToolFixture status="failed" /> };
export const ReadRunning: Story = { render: () => <ToolFixture status="in_progress" /> };
export const ExecuteCompleted: Story = { render: () => <ToolFixture kind="execute" /> };
