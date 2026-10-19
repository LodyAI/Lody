import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import {
  FloatingPermissionRequest,
  type FloatingPermissionRequestProps,
} from '@/components/sessions/floating-permission-request';
import { runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import {
  getServerNow,
  type SessionId,
  type SessionDoc,
  type WorkspaceId,
  type PermissionOutcome,
  type MessageContent,
} from '@lody/shared';

// Stub runtime so usePermissionResponse reports isReady=true in stories;
// click handlers throw if exercised, but screenshots show the active design.
const stubRuntime = { withSessionStore: () => Promise.reject(new Error('stub')) };

const storyStore = createStore();
storyStore.set(runtimeAtom, stubRuntime as never);

const meta = {
  title: 'Sessions/FloatingPermissionRequest',
  component: FloatingPermissionRequest,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <Provider store={storyStore}>
        <div className="w-[min(500px,calc(100vw-16px))]">
          <Story />
        </div>
      </Provider>
    ),
  ],
} satisfies Meta<typeof FloatingPermissionRequest>;

export default meta;
type Story = StoryObj<typeof meta>;

const SESSION_ID = 'session-1' as SessionId;

const makeHistory = (
  options: { optionId: string; name: string; kind?: string }[],
  outcome?: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' },
  title?: string
): SessionDoc['history'] =>
  [
    {
      id: 'turn-1',
      $cid: 'turn-1',
      role: 'assistant',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tc-1',
          title: title ?? 'Write to file: src/index.ts',
          status: 'in_progress',
          kind: 'edit',
          permissionRequest: {
            requestId: 'req-1',
            options,
            ...(outcome ? { outcome } : {}),
          },
        },
      ],
      read: false,
      timestamp: new Date().toISOString(),
      fileDiff: [],
    },
  ] as unknown as SessionDoc['history'];

const ALLOW_DENY_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_session' },
  { optionId: 'deny', name: 'Deny', kind: 'deny' },
];

export const Default: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeHistory(ALLOW_DENY_OPTIONS),
  },
};

export const WithToolTitle: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeHistory(ALLOW_DENY_OPTIONS, undefined, 'Write to file: src/utils/auth.ts'),
  },
};

export const TwoOptions: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeHistory([
      { optionId: 'allow', name: 'Allow', kind: 'allow' },
      { optionId: 'deny', name: 'Deny', kind: 'deny' },
    ]),
  },
};

type AskQuestion = {
  question: string;
  header: string;
  options: { label: string; description?: string; preview?: string }[];
  multiSelect: boolean;
};

const makeAskHistory = (
  questions: AskQuestion[],
  allowCustomAnswer: boolean,
  autoResolveAt?: number
): SessionDoc['history'] =>
  [
    {
      id: 'turn-ask',
      $cid: 'turn-ask',
      role: 'assistant',
      items: [
        {
          type: 'tool_call',
          toolCallId: 'tc-ask',
          title: questions[0]?.question ?? 'Question',
          status: 'in_progress',
          kind: 'think',
          permissionRequest: {
            requestId: 'req-question',
            options: [
              { optionId: 'answer', name: 'Submit answers', kind: 'allow_once' },
              { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
            ],
            _meta:
              autoResolveAt === undefined
                ? {
                    claudeCode: {
                      requestType: 'askUserQuestion',
                      askUserQuestion: {
                        version: 1,
                        allowCustomAnswer,
                        questions,
                      },
                    },
                  }
                : {
                    codex: {
                      requestUserInput: {
                        autoResolveAt,
                        questions: questions.map((question, index) => ({
                          ...question,
                          id: `question-${index + 1}`,
                          isOther: allowCustomAnswer,
                        })),
                      },
                    },
                  },
          },
        },
      ],
      read: false,
      timestamp: new Date().toISOString(),
      fileDiff: [],
    },
  ] as unknown as SessionDoc['history'];

export const AskUserQuestion: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeAskHistory(
      [
        {
          question: 'Which database should we use?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'Strong relational guarantees' },
            { label: 'SQLite', description: 'Simple embedded storage' },
            { label: 'MySQL' },
          ],
          multiSelect: false,
        },
      ],
      true
    ),
  },
};

export const AskUserQuestionAutoContinue: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeAskHistory(
      [
        {
          question: 'Which migration strategy should Codex use?',
          header: 'Strategy',
          options: [
            { label: 'Phased rollout', description: 'Migrate one service at a time' },
            { label: 'Single cutover', description: 'Migrate all services together' },
          ],
          multiSelect: false,
        },
      ],
      true,
      getServerNow() + 60_000
    ),
  },
};

export const AskUserQuestionNoCustom: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeAskHistory(
      [
        {
          question: 'Should we proceed with the migration?',
          header: 'Confirm',
          options: [
            { label: 'Yes, run it now' },
            { label: 'Run a dry run first' },
            { label: 'No, abort' },
          ],
          multiSelect: false,
        },
      ],
      false
    ),
  },
};

export const AskUserQuestionMultiSelect: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeAskHistory(
      [
        {
          question: 'Which constraints matter?',
          header: 'Constraints',
          options: [
            { label: 'Docker', description: 'Must run in Docker' },
            { label: 'Offline', description: 'Must work without network access' },
            { label: 'Low memory' },
          ],
          multiSelect: true,
        },
      ],
      true
    ),
  },
};

export const AskUserQuestionMultiQuestion: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeAskHistory(
      [
        {
          question: 'Which database should we use?',
          header: 'Database',
          options: [
            { label: 'Postgres', description: 'Strong relational guarantees' },
            { label: 'SQLite', description: 'Simple embedded storage' },
          ],
          multiSelect: false,
        },
        {
          question: 'Which constraints matter?',
          header: 'Constraints',
          options: [
            { label: 'Docker', description: 'Must run in Docker' },
            { label: 'Offline', description: 'Must work without network access' },
          ],
          multiSelect: true,
        },
      ],
      true
    ),
  },
};

export const AskUserQuestionWithPreview: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeAskHistory(
      [
        {
          question: 'Pick the implementation strategy',
          header: 'Strategy',
          options: [
            {
              label: 'Use a Map',
              description: 'Best when keys are dynamic',
              preview: 'const cache = new Map<string, User>();\ncache.set(id, user);',
            },
            {
              label: 'Use a plain object',
              description: 'Best for fixed shapes',
              preview: 'const cache: Record<string, User> = {};\ncache[id] = user;',
            },
          ],
          multiSelect: false,
        },
      ],
      true
    ),
  },
};

export const HiddenWhenIdle: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'idle' },
    sessionHistory: makeHistory(ALLOW_DENY_OPTIONS),
  },
  render: (args: FloatingPermissionRequestProps) => (
    <div>
      <FloatingPermissionRequest {...args} />
      <p className="text-sm text-muted-foreground p-4 text-center">
        (Component returns null when session is not in requestPermission state)
      </p>
    </div>
  ),
};

export const LongOptionText: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeHistory([
      {
        optionId: 'allow_once',
        name: 'Allow this tool to write to the file system and modify existing files',
        kind: 'allow_once',
      },
      {
        optionId: 'allow_session',
        name: 'Allow for the entire session including all future tool calls of this type',
        kind: 'allow_session',
      },
      { optionId: 'deny', name: 'Deny this request permanently', kind: 'deny' },
    ]),
  },
  decorators: [
    (Story) => (
      <div className="w-[280px]">
        <Story />
      </div>
    ),
  ],
};

export const NarrowContainer: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: makeHistory(ALLOW_DENY_OPTIONS),
  },
  decorators: [
    (Story) => (
      <div className="w-[200px]">
        <Story />
      </div>
    ),
  ],
};

export const MultipleParallelRequests: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: [
      {
        id: 'turn-1',
        $cid: 'turn-1',
        role: 'assistant',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            title: 'Write to file: src/index.ts',
            status: 'in_progress',
            kind: 'edit',
            permissionRequest: {
              requestId: 'req-1',
              options: ALLOW_DENY_OPTIONS,
            },
          },
          {
            type: 'tool_call',
            toolCallId: 'tc-2',
            title: 'Execute: rm -rf node_modules',
            status: 'in_progress',
            kind: 'bash',
            permissionRequest: {
              requestId: 'req-2',
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow' },
                { optionId: 'deny', name: 'Deny', kind: 'deny' },
              ],
            },
          },
          {
            type: 'tool_call',
            toolCallId: 'tc-3',
            title: 'Read file: /etc/passwd',
            status: 'in_progress',
            kind: 'read',
            permissionRequest: {
              requestId: 'req-3',
              options: ALLOW_DENY_OPTIONS,
            },
          },
        ],
        read: false,
        timestamp: new Date().toISOString(),
        fileDiff: [],
      },
    ] as unknown as SessionDoc['history'],
  },
};

export const ManyParallelRequests: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: [
      {
        id: 'turn-1',
        $cid: 'turn-1',
        role: 'assistant',
        items: Array.from({ length: 10 }, (_, index) => ({
          type: 'tool_call' as const,
          toolCallId: `tc-${index + 1}`,
          title: `Permission request ${index + 1}: write to src/file-${index + 1}.ts`,
          status: 'in_progress' as const,
          kind: 'edit' as const,
          permissionRequest: {
            requestId: `req-${index + 1}`,
            options: ALLOW_DENY_OPTIONS,
          },
        })),
        read: false,
        timestamp: new Date().toISOString(),
        fileDiff: [],
      },
    ] as unknown as SessionDoc['history'],
  },
};

export const NoHistory: Story = {
  args: {
    sessionId: SESSION_ID,
    sessionStatus: { type: 'requestPermission' },
    sessionHistory: [] as unknown as SessionDoc['history'],
  },
  render: (args: FloatingPermissionRequestProps) => (
    <div>
      <FloatingPermissionRequest {...args} />
      <p className="text-sm text-muted-foreground p-4 text-center">
        (Component returns null when no pending permission found in history)
      </p>
    </div>
  ),
};

const questionJourneyHistory: SessionDoc['history'] = [
  {
    id: 'turn-questions',
    $cid: 'turn-questions',
    role: 'assistant',
    timestamp: '2026-10-13T00:00:00Z',
    items: [
      ...['approach', 'constraints'].map((id) => ({
        type: 'tool_call',
        toolCallId: `tool-${id}`,
        status: 'in_progress',
        kind: 'think',
        permissionRequest: {
          requestId: `request-${id}`,
          options: [
            { optionId: 'answer', name: 'Submit answers', kind: 'allow_once' },
            { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
          ],
          _meta: {
            lody: {
              elicitation: {
                version: 1,
                questions: [
                  {
                    id,
                    header: id,
                    question:
                      id === 'approach'
                        ? 'Which approach should we use?'
                        : 'Which constraints matter?',
                    options:
                      id === 'approach'
                        ? [{ label: 'Small change' }, { label: 'Refactor' }]
                        : [{ label: 'Offline' }, { label: 'Compatibility' }],
                    multiSelect: id === 'constraints',
                    allowCustomAnswer: true,
                    note: { fieldId: `${id}_note`, title: 'Additional context' },
                  },
                ],
              },
            },
          },
        },
      })),
    ],
  },
] as unknown as SessionDoc['history'];

function QuestionJourney({
  failFirstAnswer = false,
  includePermission = false,
}: {
  failFirstAnswer?: boolean;
  includePermission?: boolean;
}) {
  const [history, setHistory] = useState(() =>
    includePermission
      ? ([
          {
            ...questionJourneyHistory[0],
            items: [
              questionJourneyHistory[0]!.items![0],
              makeHistory(ALLOW_DENY_OPTIONS)[0]!.items![0],
              questionJourneyHistory[0]!.items![1],
            ],
          },
        ] as SessionDoc['history'])
      : questionJourneyHistory
  );
  const [store] = useState(() => {
    const journeyStore = createStore();
    journeyStore.set(currentWorkspaceIdAtom, 'question-workspace' as WorkspaceId);
    journeyStore.set(currentWorkspaceSlugAtom, 'question-workspace');
    let shouldFail = failFirstAnswer;
    journeyStore.set(runtimeAtom, {
      workspaceId: 'question-workspace',
      workspaceSlug: 'question-workspace',
      writer: {
        respondSessionPermission: async (
          _sessionId: SessionId,
          requestId: string,
          outcome: PermissionOutcome
        ) => {
          if (shouldFail) {
            shouldFail = false;
            window.dispatchEvent(
              new CustomEvent('storybook:question-write', {
                detail: { requestId, accepted: false },
              })
            );
            throw new Error('Synthetic question write failure');
          }
          setHistory(
            (current) =>
              current.map((turn) => ({
                ...turn,
                items: ((turn.items ?? []) as MessageContent[]).map((item) =>
                  item.type === 'tool_call' && item.permissionRequest?.requestId === requestId
                    ? { ...item, permissionRequest: { ...item.permissionRequest, outcome } }
                    : item
                ),
              })) as SessionDoc['history']
          );
          window.dispatchEvent(
            new CustomEvent('storybook:question-write', {
              detail: { requestId, accepted: true, outcome },
            })
          );
        },
      },
    } as unknown as WorkspaceRuntime);
    return journeyStore;
  });
  return (
    <Provider store={store}>
      <FloatingPermissionRequest
        sessionId={SESSION_ID}
        sessionStatus={{ type: 'requestPermission' }}
        sessionHistory={history}
      />
    </Provider>
  );
}

/** Exercises the real response hook through a rejected write followed by acceptance. */
const questionJourneyArgs: FloatingPermissionRequestProps = {
  sessionId: SESSION_ID,
  sessionStatus: { type: 'requestPermission' },
  sessionHistory: questionJourneyHistory,
};

export const QuestionSendRecovery: Story = {
  args: questionJourneyArgs,
  render: () => <QuestionJourney failFirstAnswer />,
};

/** Independent pending requests, each with a choice, replacement answer, and optional note. */
export const ParallelQuestions: Story = {
  args: questionJourneyArgs,
  render: () => <QuestionJourney />,
};

/** Question drafts survive an ordinary permission request between them. */
export const MixedRequests: Story = {
  args: questionJourneyArgs,
  render: () => <QuestionJourney includePermission />,
};
