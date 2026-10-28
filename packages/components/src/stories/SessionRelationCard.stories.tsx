import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { CornerLeftUp } from 'lucide-react';

import type { ChatStreamItem, SessionChatStreamViewProps } from '@/components/ai-gui/view';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { SessionRelationCard } from '@/components/shared/session-relation-card';

const meta = {
  title: 'Sessions/SessionRelationCard',
  component: SessionRelationCard,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof SessionRelationCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CreatedConversation: Story = {
  args: {
    relation: 'opened',
    label: 'Session created',
    sessionTitle: 'Audit the sidebar navigation state',
    actionLabel: 'View session',
    onAction: () => {},
    className: 'w-[640px] max-w-[calc(100vw-2rem)]',
  },
};

export const AutomaticallyCreatedBy: Story = {
  args: {
    relation: 'opened-by',
    label: 'This session was automatically created by',
    sessionTitle: 'Plan the MCP session relationship UI',
    actionLabel: 'Back to session',
    actionIcon: CornerLeftUp,
    onAction: () => {},
    className: 'w-[640px] max-w-[calc(100vw-2rem)]',
  },
};

export const ReadOnly: Story = {
  args: {
    relation: 'opened',
    label: 'Related session',
    sessionTitle: 'Audit the sidebar navigation state',
    actionLabel: 'View session',
    className: 'w-[640px] max-w-[calc(100vw-2rem)]',
  },
};

export const WithDetail: Story = {
  args: {
    relation: 'opened',
    label: 'Message sent to',
    sessionTitle: 'Audit the sidebar navigation state',
    actionLabel: 'View session',
    detail: 'The target machine is online and ready.',
    onAction: () => {},
    className: 'w-[640px] max-w-[calc(100vw-2rem)]',
  },
};

const operationSessionId = 'storybook-created-session' as SessionId;
const operationCompletion: SessionHistoryParsed = {
  id: 'storybook-create-completion',
  role: 'system',
  timestamp: '2026-08-14T12:00:00.000Z',
  read: true,
  items: [
    {
      type: 'operation_completion',
      deliveryId: 'operation:create-sidebar-audit:completion',
      operationId: 'create-sidebar-audit',
      operationKind: 'session_create',
      completion: {
        type: 'result',
        value: {
          items: [
            {
              status: 'succeeded',
              label: 'Audit the sidebar navigation state',
              target: { sessionId: operationSessionId, userTurnId: 'storybook-user-turn' },
              assistantTurnId: 'storybook-assistant-turn',
            },
          ],
        },
      },
    },
  ],
};

export const InCreateOperation: Story = {
  args: {
    relation: 'opened',
    label: '',
    sessionTitle: '',
    actionLabel: '',
    onAction: () => {},
  },
  render: () => (
    <div className="w-[720px] max-w-[calc(100vw-2rem)]">
      <MessageRowView
        message={operationCompletion}
        sessionId={'storybook-opener' as SessionId}
        onNavigateSession={() => {}}
      />
    </div>
  ),
};

const operationStoryArgs = {
  relation: 'opened',
  label: '',
  sessionTitle: '',
  actionLabel: '',
  onAction: () => {},
} as const;

const renderOperation = (message: SessionHistoryParsed) => (
  <div className="w-[720px] max-w-[calc(100vw-2rem)]">
    <MessageRowView
      message={message}
      sessionId={'storybook-opener' as SessionId}
      onNavigateSession={() => {}}
    />
  </div>
);

/** A message Operation names the Session it reached and previews the reply. */
export const MessageOperationCompleted: Story = {
  args: operationStoryArgs,
  render: () =>
    renderOperation({
      ...operationCompletion,
      id: 'storybook-chat-completion',
      items: [
        {
          type: 'operation_completion',
          deliveryId: 'operation:pr789:completion',
          operationId: 'pr789-fix-regression-test-portal-selection-20260917',
          operationKind: 'session_chat',
          completion: {
            type: 'result',
            value: {
              items: [
                {
                  status: 'succeeded',
                  label: 'Fix the portal selection regression test',
                  target: { sessionId: operationSessionId, userTurnId: 'storybook-user-turn' },
                  assistantTurnId: 'storybook-assistant-turn',
                  output: {
                    text: [
                      '我会先读取本次失败的完整 Tests 日志并复核测试的 portal 选择逻辑，确认它只是残留根菜单被选中后再做精确修复；不会放宽断言。',
                      '',
                      '## 排查',
                      '',
                      '- 失败来自 `review-page` 的 portal 定位：测试在菜单挂载前就读取了 `[role=menu]`，拿到的是上一轮残留的根菜单。',
                      '- 本地用同样的 fixture 复现了两次，都是在第一次打开 Fork 菜单时发生。',
                      '',
                      '## 修复',
                      '',
                      '- 断言前等待目标 portal 带上 `data-state="open"`，并按 `aria-label` 精确匹配，而不是取第一个菜单。',
                      '- 没有放宽任何断言，也没有增加 sleep。',
                      '',
                      '结论：已修复并推送到 PR #789，Static checks、Tests、Desktop E2E 全部通过。',
                    ].join('\n'),
                  },
                },
              ],
            },
          },
        },
      ],
    }),
};

/** A whole-Operation failure has no Session to show; it reads as one rounded status. */
export const OperationFailed: Story = {
  args: operationStoryArgs,
  render: () =>
    renderOperation({
      ...operationCompletion,
      id: 'storybook-failed-completion',
      items: [
        {
          type: 'operation_completion',
          deliveryId: 'operation:failed:completion',
          operationId: 'storybook-failed-operation',
          operationKind: 'session_chat',
          completion: {
            type: 'error',
            error: {
              code: 'TARGET_UNAVAILABLE',
              message: 'The target machine is offline.',
              retryable: true,
            },
          },
        },
      ],
    }),
};

const openedSessionId = 'storybook-opened-session' as SessionId;
const openedConversationItems: ChatStreamItem[] = [
  {
    type: 'message',
    sessionId: openedSessionId,
    turnIndex: 0,
    message: {
      id: 'storybook-opened-user-turn',
      role: 'user',
      timestamp: '2026-08-14T12:00:01.000Z',
      read: true,
      items: [{ type: 'text', text: 'Please audit the sidebar navigation state.' }],
    },
  },
];
const renderOpenedConversationMessage: SessionChatStreamViewProps['renderMessageRow'] = ({
  message,
  sessionId,
}) => <MessageRowView message={message} sessionId={sessionId} />;

export const AtConversationStart: Story = {
  args: {
    relation: 'opened-by',
    label: '',
    sessionTitle: '',
    actionLabel: '',
    onAction: () => {},
  },
  render: () => (
    <div className="h-[520px] w-[720px] max-w-[100vw] bg-background">
      <SessionChatStreamView
        sessionId={openedSessionId}
        items={openedConversationItems}
        renderMessageRow={renderOpenedConversationMessage}
        leadingContent={
          <ConversationColumn className="py-2 sm:py-3">
            <SessionRelationCard
              relation="opened-by"
              label="This session was automatically created by"
              sessionTitle="Plan the MCP session relationship UI"
              actionLabel="Back to session"
              actionIcon={CornerLeftUp}
              onAction={() => {}}
            />
          </ConversationColumn>
        }
      />
    </div>
  ),
};

const progressMessage = (
  status: 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled'
): SessionHistoryParsed => ({
  id: 'storybook-create-progress',
  role: 'system',
  timestamp: '2026-08-14T12:00:00.000Z',
  read: true,
  items: [
    {
      type: 'operation_progress',
      operationId: 'create-sidebar-audit',
      operationKind: 'session_create',
      items: [
        {
          status,
          label: 'Audit the sidebar navigation state',
          target: { sessionId: operationSessionId, userTurnId: 'storybook-user-turn' },
        },
      ],
    },
  ],
});

function ProgressPreview({
  status,
}: {
  status: 'created' | 'running' | 'succeeded' | 'failed' | 'cancelled';
}) {
  return (
    <div className="w-[720px] max-w-[calc(100vw-2rem)] bg-background p-5">
      <MessageRowView
        message={progressMessage(status)}
        sessionId={'storybook-opener' as SessionId}
        onNavigateSession={() => {}}
      />
    </div>
  );
}

export const Created: Story = {
  args: CreatedConversation.args,
  render: () => <ProgressPreview status="created" />,
};
export const Running: Story = {
  args: CreatedConversation.args,
  render: () => <ProgressPreview status="running" />,
};
export const Succeeded: Story = {
  args: CreatedConversation.args,
  render: () => <ProgressPreview status="succeeded" />,
};
export const Failed: Story = {
  args: CreatedConversation.args,
  render: () => <ProgressPreview status="failed" />,
};
export const Cancelled: Story = {
  args: CreatedConversation.args,
  render: () => <ProgressPreview status="cancelled" />,
};
export const AllCreationStates: Story = {
  args: CreatedConversation.args,
  render: () => (
    <div className="flex flex-col bg-background">
      {(['created', 'running', 'succeeded', 'failed', 'cancelled'] as const).map((status) => (
        <ProgressPreview key={status} status={status} />
      ))}
    </div>
  ),
};

/** Separate MCP create calls must share the same bounded list. */
export const ManyCreatedSessions: Story = {
  args: operationStoryArgs,
  render: function ManyCreatedSessions() {
    const [range, setRange] = useState<{ from: number; to: number } | null>(null);
    const items: ChatStreamItem[] = Array.from({ length: 22 }, (_, index) => ({
      type: 'message',
      sessionId: 'storybook-opener' as SessionId,
      turnIndex: index,
      message: {
        ...progressMessage(index % 3 === 0 ? 'succeeded' : 'running'),
        id: `many-progress-${index}`,
        items: [
          {
            type: 'operation_progress',
            operationId: `create-${index}`,
            operationKind: 'session_create',
            items: [
              {
                status: index % 3 === 0 ? 'succeeded' : 'running',
                label: `评审任务 ${index + 1}`,
                target: {
                  sessionId: `storybook-child-${index}` as SessionId,
                  userTurnId: `turn-${index}`,
                },
              },
            ],
          },
        ],
      },
    }));
    return (
      <div
        data-visible-turn-range={range ? `${range.from}:${range.to}` : undefined}
        style={{ width: 'min(720px, calc(100vw - 32px))', height: 680 }}
      >
        <SessionChatStreamView
          sessionId={'storybook-opener' as SessionId}
          items={items}
          onVisibleTurnRangeChange={setRange}
          renderMessageRow={({ message, sessionId }) => (
            <MessageRowView message={message} sessionId={sessionId} onNavigateSession={() => {}} />
          )}
        />
      </div>
    );
  },
};

export const FailedAndMixedBatchResults: Story = {
  args: operationStoryArgs,
  render: () => (
    <div className="w-[720px] max-w-[calc(100vw-2rem)] flex flex-col gap-6">
      {[false, true].map((mixed) => (
        <MessageRowView
          key={String(mixed)}
          sessionId={'storybook-opener' as SessionId}
          message={{
            id: `batch-failure-${mixed}`,
            role: 'system',
            timestamp: '2026-10-28T09:00:00.000Z',
            read: true,
            items: [
              {
                type: 'operation_completion',
                operationId: `batch-failure-${mixed}`,
                deliveryId: `batch-failure-${mixed}`,
                operationKind: 'session_create_many',
                completion: {
                  type: 'result',
                  value: {
                    items: [
                      ...(mixed
                        ? [
                            {
                              status: 'succeeded' as const,
                              label: 'Completed review',
                              assistantTurnId: 'assistant-turn',
                              target: {
                                sessionId: 'storybook-success' as SessionId,
                                userTurnId: 'turn',
                              },
                            },
                          ]
                        : []),
                      {
                        status: 'failed',
                        label: 'Unavailable catalog',
                        error: {
                          code: 'INVALID_ITEM',
                          message: 'Synthetic catalog failure',
                          retryable: false,
                        },
                      },
                    ],
                  },
                },
              },
            ],
          }}
          onNavigateSession={() => {}}
        />
      ))}
    </div>
  ),
};

export const CompletedWorkBatch: Story = {
  args: operationStoryArgs,
  render: () => (
    <div className="w-[720px] max-w-[calc(100vw-2rem)]">
      <MessageRowView
        sessionId={'storybook-opener' as SessionId}
        message={{
          ...operationCompletion,
          id: 'storybook-batch',
          items: [
            {
              type: 'operation_completion_batch',
              batchId: '00000000-0000-4000-8000-000000000001',
              memberCount: 8,
              deliveryStatus: 'unknown',
              members: operationCompletion.items?.filter(
                (item) => item.type === 'operation_completion'
              ),
            },
          ],
        }}
        onNavigateSession={() => {}}
      />
    </div>
  ),
};

/**
 * A reply card between two finished turns is a surface: it keeps the prose-side
 * pad above and reserves the surface gap below, so the next turn's header does
 * not crowd the bordered card.
 */
export const OperationReplyInStream: Story = {
  args: operationStoryArgs,
  render: () => {
    const openerId = 'storybook-opener' as SessionId;
    const messages: SessionHistoryParsed[] = [
      {
        id: 'op-stream-assistant-1',
        role: 'assistant',
        timestamp: '2026-10-13T09:00:00.000Z',
        endedAt: Date.parse('2026-10-13T09:07:41.000Z'),
        read: true,
        finished: true,
        items: [
          {
            type: 'tool_call',
            toolCallId: 'op-stream-verify',
            kind: 'execute',
            title: 'pnpm test e2ee-core',
            status: 'completed',
          },
          {
            type: 'text',
            text: [
              '复核完成，剩余工作已下发，任务已启动。',
              '',
              '三个回归项都可以关闭：',
              '',
              '- 原有用例 6/6 通过。',
              '- 新增回归 15/15 通过。',
              '- 基线日志确认两个目标包通过。',
              '',
              '我在独立的干净副本上复现了同样的锁文件不一致，确认属于基线问题。接下来只做最小修复，然后完成安装、全仓检查、构建和冒烟验收，不会自动合入。',
            ].join('\n'),
          },
        ],
      },
      {
        id: 'op-stream-system',
        role: 'system',
        timestamp: '2026-10-13T09:08:00.000Z',
        read: true,
        items: [
          {
            type: 'operation_completion_batch',
            batchId: '00000000-0000-4000-8000-0000000000aa',
            memberCount: 1,
            members: [
              {
                type: 'operation_completion',
                deliveryId: 'operation:reply-card:completion',
                operationId: 'reply-card-demo',
                operationKind: 'session_chat',
                completion: {
                  type: 'result',
                  value: {
                    items: [
                      {
                        status: 'succeeded',
                        label: '制定并实施迁移 Stack',
                        target: {
                          sessionId: operationSessionId,
                          userTurnId: 'storybook-user-turn',
                        },
                        assistantTurnId: 'storybook-assistant-turn',
                        output: {
                          text: '通知对应的三个问题已修复并同步回原栈。我先核对了版本和证据，避免重复改动，随后检查组合验收结果。',
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
        ],
      },
      {
        id: 'op-stream-assistant-2',
        role: 'assistant',
        timestamp: '2026-10-13T09:09:00.000Z',
        endedAt: Date.parse('2026-10-13T09:16:30.000Z'),
        read: true,
        finished: true,
        items: [
          {
            type: 'tool_call',
            toolCallId: 'op-stream-recheck',
            kind: 'read',
            title: 'Read CHANGELOG.md',
            status: 'completed',
          },
          {
            type: 'text',
            text: '已复核，固定版本限定通过，未发现新增阻断。独立安装与所属测试全部通过，构建与冒烟也已核对。',
          },
        ],
      },
    ];
    const items: ChatStreamItem[] = messages.map((message, turnIndex) => ({
      type: 'message',
      sessionId: openerId,
      turnIndex,
      message,
    }));
    return (
      <div style={{ width: 'min(760px, calc(100vw - 32px))', height: 780 }}>
        <SessionChatStreamView
          sessionId={openerId}
          items={items}
          renderMessageRow={({ message, sessionId }) => (
            <MessageRowView message={message} sessionId={sessionId} onNavigateSession={() => {}} />
          )}
        />
      </div>
    );
  },
};
