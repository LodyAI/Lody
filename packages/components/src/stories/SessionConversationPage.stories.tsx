/**
 * INTEGRATION HARNESS — not production, and NOT a place to change UI appearance.
 *
 * This story hand-composes the REAL leaf components (header, tab bar, message
 * stream, composer, permission/question surfaces) with mock data, because the
 * real page (`session-chat-interface.tsx` / `session-detail.tsx`) needs the full
 * workspace runtime / Convex / Machine-RPC and cannot render in Storybook.
 *
 * Rules (see `components/sessions/AGENTS.md` → "Storybook-fidelity invariant"):
 * - Any appearance change (color/spacing/border/sizing of a component) goes in
 *   the COMPONENT under `src/components/**`, never here — otherwise it never
 *   ships. To iterate on one component's look, use its dedicated `*.stories.tsx`.
 * - The composition below MUST mirror production and drifts silently. Keep in
 *   sync: mobile header = `BaseHeader` with the "..." menu top-right (mirrors
 *   `session-detail.tsx` `if (isMobile)`); desktop top bar = ONE merged
 *   `SessionTabBar` row (tabs + "…" toolbar in `rightSlot`, mirrors
 *   `session-detail.tsx` desktop) with the context strip above the composer
 *   (mirrors `session-chat-interface.tsx`). File/diff viewers live exclusively
 *   in the right-side `SessionSidePanelTabBar`, covered by its dedicated story.
 *   `useIsMobile()` reads `window.innerWidth`, so mobile stories resize the
 *   preview iframe (`withMobileViewport`) and render full-bleed — no fake bezel.
 * - After changing anything here, verify in the REAL app (mobile included);
 *   story preview chrome (backdrop/frame) is not production.
 */
import type { Decorator, Meta, StoryObj } from '@storybook/react';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { Provider, createStore } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fn } from 'storybook/test';
import {
  getAgentConfigRoomId,
  getLodySessionPresenceKey,
  getMachineRoomId,
  getServerNow,
  getSessionRoomId,
  SESSION_GOAL_COMMANDS,
  type AgentConfigId,
  type AgentConfigMeta,
  type LodyPresenceInstanceId,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
  type MessageContent,
  type SessionDoc,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestMeta,
  type WorkspaceId,
} from '@lody/shared';

import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom, userAtom } from '@/atoms';
import {
  agentConfigMetaCacheAtom,
  machineMetaCacheAtom,
  sessionMetaCacheAtom,
} from '@/atoms/doc-meta';
import { focusLayerAtom } from '@/atoms/focus-layer';
import { lodyPresenceStatesAtom } from '@/atoms/presence';
import { authTokenAtom, runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import {
  FloatingPermissionRequest,
  hasPendingPermissionRequest,
} from '@/components/sessions/floating-permission-request';
import { SessionHeaderMenu } from '@/components/sessions/session-chat-interface';
import { SessionAccessControl } from '@/components/session-sharing';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import {
  SessionConversationPage,
  SessionConversationPageBody,
} from '@/components/sessions/session-conversation-page';
import { SessionChatInputArea } from '@/components/sessions/session-chat-input-area';
import {
  Archive,
  ChevronLeft,
  Copy,
  Ellipsis,
  FileText,
  GitBranch,
  GitFork,
  Github,
  Link,
  Monitor,
  Pencil,
  Search,
} from 'lucide-react';
import { BaseHeader } from '@/components/page-headers/base-header';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import {
  MobileSessionTabButton,
  MobileSessionTabSheet,
  hasBackgroundUnread,
} from '@/components/mobile/mobile-session-tab-sheet';
import {
  MobileSessionMenuSheet,
  type MobileSessionMenuAction,
  type MobileSessionMenuInfoRow,
} from '@/components/mobile/mobile-session-menu-sheet';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import {
  buildAcpSelectorOptions,
  type AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { StableSessionContext } from '@/hooks/useStableSession';
import type { LodyAuthClient } from '@/lib/auth';
import type { SessionSharingState } from '@/lib/session-sharing';
import { cn } from '@/lib/utils';
import { AuthProvider } from '@/providers/convex-provider';

const STORY_WORKSPACE_ID = 'workspace-storybook-session-page' as WorkspaceId;
const STORY_WORKSPACE_SLUG = 'storybook';
const STORY_MACHINE_ID = 'machine-storybook-session-page' as MachineId;
const STORY_AGENT_CONFIG_ID = 'agent-storybook-session-page' as AgentConfigId;
const STORY_LOCAL_PROJECT_ID = 'local:lody' as LocalProjectId;
const STORY_AUTH_TOKEN = 'storybook-token';
const STORY_USER_ID = 'user-storybook-session-page';

const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: STORY_USER_ID, name: 'Zixuan' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      {
        id: STORY_WORKSPACE_ID,
        name: 'Storybook Workspace',
        slug: STORY_WORKSPACE_SLUG,
        role: 'owner',
      },
    ],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

type PageState = 'idle' | 'working' | 'permission' | 'question';
type DeviceFrame = 'desktop' | 'mobile';

const action = fn();
const STREAM_INTERVAL_MS = 60;
const STREAM_CHUNK_TOTAL = 180;
const STREAM_CHUNKS = Array.from({ length: STREAM_CHUNK_TOTAL }, (_, index) => {
  const item = index + 1;
  if (item % 12 === 0) {
    return [
      '',
      `### Render checkpoint ${item / 12}`,
      '',
      '| Surface | Observation |',
      '| --- | --- |',
      `| Message stream | chunk ${item} appended |`,
      '| Working status | indicator remains active |',
      '',
    ].join('\n');
  }
  if (item % 5 === 0) {
    return `\n- Inspecting the visible conversation tree at streaming chunk ${item}.`;
  }
  return ` The mock stream keeps extending the current assistant response (${item}).`;
});

const storySharing: SessionSharingState = {
  visibility: 'private',
  privateReason: 'project',
  canManage: true,
  machineId: STORY_MACHINE_ID,
  localProjectId: STORY_LOCAL_PROJECT_ID,
  machineName: 'Storybook Mac Studio',
  projectName: 'lody',
};

type StableSessionValue = NonNullable<
  ComponentProps<typeof StableSessionContext.Provider>['value']
>;

const storyRuntime = {
  workspaceId: STORY_WORKSPACE_ID,
  workspaceSlug: STORY_WORKSPACE_SLUG,
  withSessionStore: async () => Promise.reject(new Error('Story runtime does not persist changes')),
} as unknown as WorkspaceRuntime;

const machineMeta: MachineViewMeta = {
  id: STORY_MACHINE_ID,
  name: 'Storybook Mac Studio',
  os: 'macOS',
  cliVersion: '1.0.0',
  sessions: [],
  localProjects: {
    [STORY_LOCAL_PROJECT_ID]: {
      id: STORY_LOCAL_PROJECT_ID,
      name: 'lody',
      rootPath: '/Users/developer/Code/lody',
      createdAtMs: Date.parse('2026-07-09T00:00:00.000Z'),
    },
  },
  raceLimits: {},
};

const agentConfigMeta: AgentConfigMeta = {
  id: STORY_AGENT_CONFIG_ID,
  machineId: STORY_MACHINE_ID,
  name: 'Codex Primary',
  description: 'Storybook agent config',
  cliType: 'builtin',
  agentType: 'codex',
  env: {},
};

const usersById: Record<
  string,
  { name?: string | null; image?: string | null; email?: string | null }
> = {
  [STORY_USER_ID]: {
    name: 'Zixuan',
    image: null,
    email: 'zixuan@example.com',
  },
};

const storyAuthSession = {
  user: {
    id: STORY_USER_ID,
    name: 'Zixuan',
    email: 'zixuan@example.com',
    image: null,
  },
  session: {
    id: 'storybook-auth-session',
    userId: STORY_USER_ID,
    expiresAt: new Date('2026-07-10T00:00:00.000Z'),
    createdAt: new Date('2026-07-09T00:00:00.000Z'),
    updatedAt: new Date('2026-07-09T00:00:00.000Z'),
  },
};

const storyOrganization = {
  id: STORY_WORKSPACE_ID,
  name: 'Storybook Workspace',
  slug: STORY_WORKSPACE_SLUG,
  members: [
    {
      id: 'storybook-membership',
      userId: STORY_USER_ID,
      organizationId: STORY_WORKSPACE_ID,
      role: 'owner',
      createdAt: new Date('2026-07-09T00:00:00.000Z'),
    },
  ],
};

const storyAuthClient = {
  useSession: () => ({
    data: storyAuthSession,
    isPending: false,
    error: null,
    refetch: async () => ({ data: storyAuthSession, error: null }),
  }),
  useListOrganizations: () => ({
    data: [storyOrganization],
    isPending: false,
    error: null,
    refetch: async () => ({ data: [storyOrganization], error: null }),
  }),
  useActiveOrganization: () => ({
    data: storyOrganization,
    isPending: false,
    error: null,
    refetch: async () => ({ data: storyOrganization, error: null }),
  }),
  organization: {
    setActive: async () => ({ data: storyOrganization, error: null }),
    create: async () => ({ data: storyOrganization, error: null }),
    update: async () => ({ data: storyOrganization, error: null }),
    delete: async () => ({ data: storyOrganization, error: null }),
    leave: async () => ({ data: storyOrganization, error: null }),
  },
  signOut: async () => undefined,
} as unknown as LodyAuthClient;

const storyStableSessionValue = {
  data: storyAuthSession,
  rawData: storyAuthSession,
  bootstrapSnapshot: null,
  hasLocalToken: true,
  hasRawUser: true,
  isOptimistic: false,
  isPending: false,
  isRetrying: false,
  error: null,
  confirmedUnauthenticated: false,
  refetch: async () => ({ data: storyAuthSession, error: null }),
} as unknown as StableSessionValue;

const selectorOptions = buildAcpSelectorOptions({
  configId: STORY_AGENT_CONFIG_ID,
  cliType: 'builtin',
  agentType: 'codex',
});

const buildSessionId = (state: PageState, frame: DeviceFrame): SessionId =>
  `session-storybook-${state}-${frame}` as SessionId;

const buildSession = (state: PageState, frame: DeviceFrame): SessionMeta => {
  const sessionId = buildSessionId(state, frame);
  const status =
    state === 'idle'
      ? ({ type: 'idle' } as const)
      : state === 'working'
        ? ({ type: 'running' } as const)
        : ({ type: 'requestPermission' } as const);
  return {
    id: sessionId,
    machineId: STORY_MACHINE_ID,
    createdAt: '2026-07-09T09:30:00.000Z',
    title: 'Session conversation page',
    userId: STORY_USER_ID,
    status,
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: STORY_AGENT_CONFIG_ID,
    repoFullName: 'loro-dev/lody',
    project: {
      kind: 'local',
      localProjectId: STORY_LOCAL_PROJECT_ID,
      githubRepoFullName: 'loro-dev/lody',
      branch: 'main',
    },
    baseBranch: 'main',
    branchName: 'codex/session-page-story',
    lastMessageAt: Date.parse('2026-07-09T09:42:00.000Z'),
  };
};

// PR number derives from the URL (legacy `number` writes are deprecated).
const storyPullRequest: SessionPullRequestMeta = {
  url: 'https://github.com/loro-dev/lody/pull/2830',
  status: 'open',
};

const buildMessage = (
  input: Partial<SessionHistoryParsed> & Pick<SessionHistoryParsed, 'items'>
): SessionHistoryParsed => ({
  id: input.id ?? `history-${Math.random().toString(36).slice(2)}`,
  role: input.role ?? 'assistant',
  timestamp: input.timestamp ?? '2026-07-09T09:35:00.000Z',
  read: input.read ?? true,
  userId: input.userId,
  items: input.items,
  finished: input.finished,
  modelInfo: input.modelInfo,
});

const baseMessages = (): SessionHistoryParsed[] => [
  buildMessage({
    id: 'user-1',
    role: 'user',
    userId: STORY_USER_ID,
    timestamp: '2026-07-09T09:31:00.000Z',
    items: [
      {
        type: 'text',
        text: 'Create a shared Storybook surface for the session conversation page.',
      },
    ],
  }),
  buildMessage({
    id: 'assistant-1',
    role: 'assistant',
    timestamp: '2026-07-09T09:31:20.000Z',
    finished: true,
    modelInfo: { modelId: 'gpt-5', name: 'GPT-5', description: null, _meta: null },
    items: [
      {
        type: 'text',
        text: [
          'I found the production page pieces:',
          '',
          '- `SessionTabBar` owns the thread tabs.',
          '- `SessionChatStreamView` renders the conversation.',
          '- `SessionChatInputArea` owns the composer and mode/model controls.',
          '',
          'I will keep the story wired to those components instead of making a separate mock page.',
        ].join('\n'),
      },
    ],
  }),
];

const buildWorkingHistory = (streamChunkCount: number): SessionHistoryParsed[] => {
  const messages = baseMessages();
  for (let index = 0; index < 14; index += 1) {
    const turn = index + 1;
    messages.push(
      buildMessage({
        id: `working-user-${turn}`,
        role: 'user',
        userId: STORY_USER_ID,
        timestamp: `2026-07-09T09:${String(32 + index).padStart(2, '0')}:00.000Z`,
        items: [
          {
            type: 'text',
            text: `Continue the renderer investigation with synthetic checkpoint ${turn}.`,
          },
        ],
      }),
      buildMessage({
        id: `working-assistant-${turn}`,
        role: 'assistant',
        timestamp: `2026-07-09T09:${String(32 + index).padStart(2, '0')}:20.000Z`,
        finished: true,
        modelInfo: { modelId: 'gpt-5', name: 'GPT-5', description: null, _meta: null },
        items: [
          {
            type: 'text',
            text: [
              `Synthetic completed turn ${turn}.`,
              '',
              '- Read the current message projection.',
              '- Compared the virtual rows and sticky-scroll state.',
              '- Kept this fixture synthetic so it is safe to commit.',
            ].join('\n'),
          },
        ],
      })
    );
  }

  messages.push(
    buildMessage({
      id: 'working-user-current',
      role: 'user',
      userId: STORY_USER_ID,
      timestamp: '2026-07-09T09:48:00.000Z',
      items: [
        {
          type: 'text',
          text: 'Reproduce the rendering cost while the main conversation is streaming.',
        },
      ],
    }),
    buildMessage({
      id: 'working-assistant-current',
      role: 'assistant',
      timestamp: '2026-07-09T09:48:05.000Z',
      finished: false,
      modelInfo: { modelId: 'gpt-5', name: 'GPT-5', description: null, _meta: null },
      items: [
        {
          type: 'thought',
          text: 'Tracing the Storybook conversation surface while the response grows.',
        },
        {
          type: 'text',
          text: [
            'I am reproducing the streaming render workload in the complete conversation page.',
            '',
            'The Story keeps the real message list, composer, info bar, tab bar, and working indicator mounted.',
            ...STREAM_CHUNKS.slice(0, streamChunkCount),
          ].join('\n'),
        },
      ],
    })
  );
  return messages;
};

const permissionOptions = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  {
    optionId: 'allow_always',
    name: [
      'Always allow edits in this session for files under',
      'packages/components/src/components/sessions/',
      'including generated Storybook fixtures and follow-up visual polish changes',
    ].join(' '),
    kind: 'allow_always',
  },
  {
    optionId: 'reject_once',
    name: [
      'Deny this request because the proposed change touches',
      'packages/components/src/components/sessions/session-chat-interface.tsx',
      'and I want to review the exact diff before any write is applied',
    ].join(' '),
    kind: 'reject_once',
  },
] satisfies NonNullable<
  Extract<MessageContent, { type: 'tool_call' }>['permissionRequest']
>['options'];

const approvedPermissionToolCall = (): MessageContent => ({
  type: 'tool_call',
  toolCallId: 'tool-permission-approved-story',
  title: 'Edit packages/components/src/components/sessions/floating-permission-request.tsx',
  status: 'completed',
  kind: 'edit',
  permissionRequest: {
    requestId: 'permission-approved-story',
    options: permissionOptions,
    outcome: { outcome: 'selected', optionId: 'allow_once' },
  },
});

const pendingPermissionToolCall = (): MessageContent => ({
  type: 'tool_call',
  toolCallId: 'tool-permission-pending-story',
  title: 'Edit packages/components/src/components/sessions/session-chat-interface.tsx',
  status: 'pending',
  kind: 'edit',
  permissionRequest: {
    requestId: 'permission-pending-story',
    options: permissionOptions,
  },
});

const questionToolCall = (): MessageContent => ({
  type: 'tool_call',
  toolCallId: 'tool-question-story',
  title: 'Which UI state should I optimize first?',
  status: 'in_progress',
  kind: 'think',
  permissionRequest: {
    requestId: 'question-story',
    options: [
      { optionId: 'answer', name: 'Submit answers', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
    ],
    _meta: {
      claudeCode: {
        requestType: 'askUserQuestion',
        askUserQuestion: {
          version: 1,
          allowCustomAnswer: true,
          questions: [
            {
              question: 'Which session page state should we iterate on first?',
              header: 'Next UI pass',
              options: [
                { label: 'Idle composer', description: 'Check normal writing and selector layout' },
                { label: 'Permission approval', description: 'Check the approval button surface' },
                { label: 'Agent question', description: 'Check multi-option answer flow' },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    },
  },
});

const buildHistory = (state: PageState, streamChunkCount = 0): SessionHistoryParsed[] => {
  if (state === 'working') {
    return buildWorkingHistory(streamChunkCount);
  }
  const messages = baseMessages();
  if (state === 'permission') {
    messages.push(
      buildMessage({
        id: 'assistant-permission-approved',
        role: 'assistant',
        timestamp: '2026-07-09T09:33:00.000Z',
        items: [approvedPermissionToolCall()],
      }),
      buildMessage({
        id: 'assistant-permission-pending',
        role: 'assistant',
        timestamp: '2026-07-09T09:33:20.000Z',
        items: [pendingPermissionToolCall()],
      })
    );
  }
  if (state === 'question') {
    messages.push(
      buildMessage({
        id: 'assistant-question',
        role: 'assistant',
        timestamp: '2026-07-09T09:34:00.000Z',
        items: [questionToolCall()],
      })
    );
  }
  return messages;
};

const toStreamItems = (sessionId: SessionId, messages: SessionHistoryParsed[]) =>
  messages.map((message) => ({ type: 'message', sessionId, message }) as const);

const renderMessageRow = ({
  message,
  sessionId,
}: {
  message: SessionHistoryParsed;
  sessionId: SessionId;
}) => (
  <MessageRowView
    message={message}
    sessionId={sessionId}
    user={message.userId ? usersById[message.userId] : undefined}
  />
);

function createStoryStore(session: SessionMeta, state: PageState) {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(currentWorkspaceSlugAtom, STORY_WORKSPACE_SLUG);
  store.set(authTokenAtom, STORY_AUTH_TOKEN);
  store.set(runtimeAtom, storyRuntime);
  store.set(userAtom, {
    id: STORY_USER_ID,
    name: 'Zixuan',
    email: 'zixuan@example.com',
    image: null,
  });
  store.set(focusLayerAtom, 'L3');
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(STORY_MACHINE_ID)]: machineMeta,
  });
  store.set(agentConfigMetaCacheAtom, {
    [getAgentConfigRoomId(STORY_AGENT_CONFIG_ID)]: agentConfigMeta,
  });
  store.set(sessionMetaCacheAtom, {
    [getSessionRoomId(session.id)]: session,
  });
  if (state !== 'idle') {
    const instanceId = `storybook-${state}` as LodyPresenceInstanceId;
    const status =
      state === 'working'
        ? ({ type: 'running' } as const)
        : ({ type: 'requestPermission' } as const);
    store.set(lodyPresenceStatesAtom, {
      [getLodySessionPresenceKey(session.id, instanceId)]: {
        kind: 'session',
        sessionId: session.id,
        machineId: STORY_MACHINE_ID,
        instanceId,
        status,
        updatedAt: getServerNow(),
      },
    });
  }
  return store;
}

function StoryInfoBar({ session }: { session: SessionMeta }) {
  return (
    <SessionInfoBar
      status={null}
      goal={{
        type: 'goal',
        threadId: 'story-goal',
        objective: 'Ship the session info bar and wire it into production.',
        status: 'active',
      }}
      goalCommands={SESSION_GOAL_COMMANDS}
      onGoalCommand={fn()}
      scheduledTasks={[
        {
          id: 'story-wakeup',
          kind: 'wakeup',
          createdAtMs: getServerNow(),
          scheduledForMs: getServerNow() + 12 * 60_000,
          summary: 'Check whether CI finished and continue.',
        },
      ]}
      projectName={session.repoFullName}
      branch={session.branchName}
      pr={storyPullRequest}
      onOpenPr={action}
      diffStat={{ add: 128, del: 42 }}
    />
  );
}

function StoryComposer({ session, isAgentBusy }: { session: SessionMeta; isAgentBusy: boolean }) {
  const [mode, setMode] = useState<string | null>(selectorOptions.modeOptions[0]?.value ?? null);
  const [model, setModel] = useState<string | null>(selectorOptions.modelOptions[0]?.value ?? null);
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>(() =>
    Object.fromEntries(
      selectorOptions.configOptionSelectors.map((selector) => [
        selector.configId,
        selector.currentValue,
      ])
    )
  );

  return (
    <SessionChatInputArea
      session={session}
      sessionLocalProjectRootPath="/Users/developer/Code/lody"
      isMachineRemoved={false}
      isAgentBusy={isAgentBusy}
      isDark
      isEmptyConversation={false}
      selectedModeId={mode}
      selectedModelId={model}
      modeOptions={selectorOptions.modeOptions}
      modelOptions={selectorOptions.modelOptions}
      configOptionSelectors={selectorOptions.configOptionSelectors}
      configOptionValues={configValues}
      isRepoPublic
      availableCommands={[]}
      onModeChange={setMode}
      onModelChange={setModel}
      onConfigOptionChange={(configId, value) =>
        setConfigValues((prev) => ({ ...prev, [configId]: value }))
      }
      onSendMessage={async () => true}
      onStop={action}
      onRemoveQueueItem={async () => undefined}
      initialInputText="Tighten the mobile spacing after the permission flow is stable."
      disableImageUpload
    />
  );
}

function StoryShell({ state, frame }: { state: PageState; frame: DeviceFrame }) {
  const { t } = useTranslation();
  const [streamChunkCount, setStreamChunkCount] = useState(0);
  const session = useMemo(() => buildSession(state, frame), [frame, state]);
  const store = useMemo(() => createStoryStore(session, state), [session, state]);
  useEffect(() => {
    setStreamChunkCount(0);
    if (state !== 'working') {
      return undefined;
    }
    const interval = window.setInterval(() => {
      setStreamChunkCount((current) => {
        if (current >= STREAM_CHUNK_TOTAL) {
          window.clearInterval(interval);
          return current;
        }
        return current + 1;
      });
    }, STREAM_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [state]);
  const history = useMemo(() => buildHistory(state, streamChunkCount), [state, streamChunkCount]);
  const permissionHistory = history as unknown as SessionDoc['history'];
  const liveStatus =
    state === 'idle'
      ? undefined
      : state === 'working'
        ? ({ type: 'running' } as const)
        : ({ type: 'requestPermission' } as const);
  const shouldShowPermissionSurface = hasPendingPermissionRequest(liveStatus, permissionHistory);
  const translate = (key: string, fallback: string) => String(t(key, fallback));
  const isWorking = state === 'working';
  const streamPhase =
    !isWorking || streamChunkCount === 0
      ? 'initializing'
      : streamChunkCount < STREAM_CHUNK_TOTAL
        ? 'streaming'
        : 'indicator-only';
  const childSession = {
    ...session,
    id: `${session.id}-child` as SessionId,
    title: 'Review mobile layout',
    parentSessionId: session.id,
    status: { type: 'idle' as const },
  };

  // Mobile header mirrors production `session-detail.tsx`: a 💬 tab-switcher
  // button + a "…" button, both opening bottom sheets (no dropdown, no tab
  // bar). Mock the sheet data the real wiring resolves from session state.
  const [tabSheetOpen, setTabSheetOpen] = useState(false);
  const [menuSheetOpen, setMenuSheetOpen] = useState(false);
  const mobileConversations = [
    {
      id: session.id as string,
      title: session.title ?? 'Session',
      active: true,
      main: true,
      running: false,
      unread: false,
      lastActivityAt: Date.now() - 45_000,
    },
    {
      id: childSession.id as string,
      title: childSession.title,
      active: false,
      running: true,
      unread: true,
      lastActivityAt: Date.now() - 6 * 60_000,
    },
  ];
  const mobileViewers = [
    { id: 'diff:story', label: 'Changes', kind: 'diff' as const, active: false },
  ];
  const mobileMenuInfoRows: MobileSessionMenuInfoRow[] = [
    {
      id: 'machine',
      icon: <Monitor className="h-3.5 w-3.5" />,
      label: 'Machine',
      value: machineMeta.name,
    },
    {
      id: 'base',
      icon: <GitBranch className="h-3.5 w-3.5" />,
      label: 'Base branch',
      value: 'main',
      onCopy: action,
    },
    {
      id: 'branch',
      icon: <GitBranch className="h-3.5 w-3.5" />,
      label: 'Current branch',
      value: 'lody/solve-merge-conflicts-a1b2c3',
      onCopy: action,
    },
  ];
  const mobileMenuActions: MobileSessionMenuAction[] = [
    {
      id: 'find',
      icon: <Search className="h-3.5 w-3.5" />,
      label: 'Find in session',
      onClick: action,
    },
    {
      id: 'fork',
      icon: <GitFork className="h-3.5 w-3.5" />,
      label: 'Fork session',
      onClick: action,
    },
    {
      id: 'rename',
      icon: <Pencil className="h-3.5 w-3.5" />,
      label: 'Rename Chat',
      onClick: action,
    },
    {
      id: 'copy-path',
      icon: <Copy className="h-3.5 w-3.5" />,
      label: 'Copy path',
      onClick: action,
      separatorBefore: true,
    },
    {
      id: 'copy-md',
      icon: <FileText className="h-3.5 w-3.5" />,
      label: 'Copy as Markdown',
      onClick: action,
    },
    { id: 'copy-url', icon: <Link className="h-3.5 w-3.5" />, label: 'Copy URL', onClick: action },
    {
      id: 'archive',
      icon: <Archive className="h-3.5 w-3.5" />,
      label: 'Archive session',
      onClick: action,
      separatorBefore: true,
    },
  ];
  // Mirrors production `MobileProjectInfo`: session title (primary) + repo /
  // project (muted subtitle).
  const mobileTitleNode = (
    <span className="flex min-w-0 flex-col justify-center leading-tight">
      <span className="truncate text-[0.95rem] font-semibold text-foreground">
        {session.title ?? 'Session'}
      </span>
      <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <Github className="h-3 w-3 shrink-0" />
        <span className="truncate">{session.repoFullName ?? ''}</span>
      </span>
    </span>
  );
  const mobileHeaderActions = (
    <>
      <MobileSessionTabButton
        hasUnread={hasBackgroundUnread(mobileConversations)}
        onOpen={() => setTabSheetOpen(true)}
      />
      <GlassIconButton
        label={translate('sessions.moreActions', 'More actions')}
        onClick={() => setMenuSheetOpen(true)}
      >
        <Ellipsis className="h-4 w-4" />
      </GlassIconButton>
    </>
  );
  // Mobile renders full-bleed (fills the phone-width viewport) to match how the
  // app actually looks on a phone — no fake bezel or gray padding that could
  // clip content or misrepresent spacing. Desktop keeps the framed preview.
  const frameClassName =
    frame === 'mobile'
      ? 'h-full w-full'
      : // Fill the preview viewport height instead of a fixed 760px box, so the
        // conversation area gets the real available height and doesn't clip.
        'mx-auto h-full w-full max-w-6xl border-x border-border/70 shadow-sm';

  const headerMenuNode = (
    <SessionHeaderMenu
      session={session}
      localProjectMeta={machineMeta.localProjects?.[STORY_LOCAL_PROJECT_ID]}
      workspacePath="/Users/developer/Code/lody"
      machineName={machineMeta.name}
      onCopyConversationHistory={action}
      onCopyUrl={action}
      sharing={storySharing}
      onShareWithTeam={action}
      onOpenSearch={action}
      onFork={action}
      onRename={action}
      t={translate}
    />
  );

  return (
    <PlatformContext.Provider value={storyPlatform}>
      <Provider store={store}>
        <AuthProvider authClient={storyAuthClient}>
          <StableSessionContext.Provider value={storyStableSessionValue}>
            <div
              data-testid="session-conversation-story"
              data-stream-chunk={streamChunkCount}
              data-stream-total={STREAM_CHUNK_TOTAL}
              data-stream-phase={streamPhase}
              className={cn(
                'text-foreground',
                // Desktop uses a definite h-dvh (not min-h-dvh) so the frame's
                // h-full resolves and the conversation fills the real height.
                frame === 'mobile' ? 'h-dvh w-full bg-background' : 'h-dvh bg-muted/35 p-4 sm:p-6'
              )}
            >
              <div
                className={cn('overflow-hidden bg-background', frameClassName)}
                style={
                  frame === 'mobile'
                    ? ({ '--conversation-top-inset': '3rem' } as CSSProperties)
                    : undefined
                }
              >
                <SessionConversationPage
                  className="h-full"
                  headerSlot={
                    frame !== 'mobile' ? null : (
                      // Mirrors the production mobile header (session-detail.tsx
                      // `if (isMobile)`): a FLOATING frosted BaseHeader (absolute,
                      // translucent + backdrop-blur, no border, 3rem tall) with
                      // glass buttons; the conversation scrolls under it via the
                      // `--conversation-top-inset` var set on the frame below.
                      <BaseHeader
                        hideMenuButton
                        className="absolute inset-x-0 top-0 z-30 border-b-0 bg-background/55 backdrop-blur-xl"
                        style={{ height: '3rem' }}
                        leading={
                          // Mirrors production `MobileSessionHeaderBackButton`.
                          <GlassIconButton
                            label={translate('common.back', 'Back')}
                            onClick={action}
                          >
                            <ChevronLeft className="h-5 w-5" />
                          </GlassIconButton>
                        }
                        title={mobileTitleNode}
                        actions={mobileHeaderActions}
                      />
                    )
                  }
                  subHeaderSlot={
                    // Mobile has no tab bar now (tabs live in the 💬 sheet); desktop keeps it.
                    frame === 'mobile' ? null : (
                      // Mirrors the production merged top row (session-detail
                      // desktop): tabs + right-side toolbar ("…" menu) in ONE bar;
                      // the old repo-title header row is gone.
                      <SessionTabBar
                        variant="session"
                        parentSession={session}
                        childSessions={[childSession]}
                        draftTabs={[]}
                        archivedChildSessions={[]}
                        activeTabSessionId={session.id}
                        onTabSelect={action}
                        onNewTab={action}
                        onTabRename={action}
                        onTabClose={action}
                        tabOrder={[childSession.id]}
                        rightSlot={
                          <div className="flex h-full shrink-0 items-center gap-1 pl-1 pr-2">
                            <SessionAccessControl state={storySharing} onShareWithTeam={action} />
                            {headerMenuNode}
                          </div>
                        }
                      />
                    )
                  }
                  bodySlot={
                    <SessionConversationPageBody
                      streamSlot={
                        <SessionChatStreamView
                          sessionId={session.id}
                          items={toStreamItems(session.id, history)}
                          renderMessageRow={renderMessageRow}
                          className="h-full"
                          agentActivityLabel={
                            isWorking
                              ? translate('sessions.statusIndicator.thinking', 'Thinking')
                              : shouldShowPermissionSurface
                                ? 'Waiting for your response'
                                : null
                          }
                          agentActivityTone={shouldShowPermissionSurface ? 'warning' : 'primary'}
                        />
                      }
                      permissionSlot={
                        <FloatingPermissionRequest
                          sessionId={session.id}
                          sessionStatus={liveStatus}
                          sessionHistory={permissionHistory}
                        />
                      }
                      composerSlot={
                        shouldShowPermissionSurface ? null : (
                          <>
                            {/* Mirrors the production info bar (cluster + stage)
                              glued above the composer — desktop AND mobile. */}
                            <StoryInfoBar session={session} />
                            <StoryComposer session={session} isAgentBusy={isWorking} />
                          </>
                        )
                      }
                    />
                  }
                />
                {frame === 'mobile' ? (
                  <>
                    <MobileSessionTabSheet
                      open={tabSheetOpen}
                      onOpenChange={setTabSheetOpen}
                      conversations={mobileConversations}
                      viewers={mobileViewers}
                      onSelectConversation={action}
                      onNewConversation={action}
                      onSelectViewer={action}
                    />
                    <MobileSessionMenuSheet
                      open={menuSheetOpen}
                      onOpenChange={setMenuSheetOpen}
                      infoRows={mobileMenuInfoRows}
                      actions={mobileMenuActions}
                    />
                  </>
                ) : null}
              </div>
            </div>
          </StableSessionContext.Provider>
        </AuthProvider>
      </Provider>
    </PlatformContext.Provider>
  );
}

/**
 * The composer (and other components) branch on `useIsMobile()`, which reads
 * `window.innerWidth` — NOT the CSS phone frame. So a fixed-width CSS "phone"
 * box still renders the DESKTOP layout at a wide manager width, which is why
 * the mobile stories previously leaked the desktop composer. To render the real
 * mobile layout, resize the Storybook preview iframe so the story window is
 * genuinely phone-sized (this is what the viewport addon does under the hood).
 *
 * Passing a `height` also lets us simulate short-body phones (e.g. iPhone SE):
 * the app fills `100dvh`, so a short iframe surfaces whether the fixed header /
 * tab bar / composer crowd out the scrollable message area. Only effective in
 * the Storybook manager (there is a real preview iframe); in `iframe.html` it is
 * a no-op, so resize the browser instead.
 */
// Every prop the mobile lock touches. Cleared explicitly (rather than restoring
// a snapshot of `style.cssText`) so a desktop story can deterministically undo
// whatever a previously-viewed mobile story left on the shared preview iframe.
const VIEWPORT_LOCK_PROPS = [
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'margin',
] as const;

function clearViewportLock(frame: HTMLElement) {
  for (const prop of VIEWPORT_LOCK_PROPS) frame.style.removeProperty(prop);
}

function makeMobileViewportDecorator(width: number, height?: number): Decorator {
  function MobileViewport({ children }: { children: ReactNode }) {
    useEffect(() => {
      const frame = window.frameElement as HTMLElement | null;
      if (!frame) return undefined;
      const lock = (prop: string, value: string) =>
        frame.style.setProperty(prop, value, 'important');
      lock('width', `${width}px`);
      lock('min-width', `${width}px`);
      lock('max-width', `${width}px`);
      if (height != null) {
        lock('height', `${height}px`);
        lock('min-height', `${height}px`);
        lock('max-height', `${height}px`);
      }
      lock('margin', '0 auto');
      window.dispatchEvent(new Event('resize'));
      return () => {
        clearViewportLock(frame);
        window.dispatchEvent(new Event('resize'));
      };
    }, []);
    return <>{children}</>;
  }
  return (Story) => (
    <MobileViewport>
      <Story />
    </MobileViewport>
  );
}

const withMobileViewport = makeMobileViewportDecorator(430);
// Short-body device (~iPhone SE minus browser chrome). Fixed header/tab bar +
// the 3-row composer leave little room for messages here — the simplification target.
const withShortMobileViewport = makeMobileViewportDecorator(375, 620);

// Desktop stories must forcibly release any mobile lock left on the shared
// preview iframe (Storybook reuses one iframe across stories, and the mobile
// cleanup can race a direct desktop→mobile→desktop navigation). Without this the
// desktop frame's `w-full` collapses to the leaked 430px.
const withDesktopViewport: Decorator = (Story) => {
  function DesktopViewport({ children }: { children: ReactNode }) {
    useEffect(() => {
      const frame = window.frameElement as HTMLElement | null;
      if (!frame) return;
      clearViewportLock(frame);
      window.dispatchEvent(new Event('resize'));
    }, []);
    return <>{children}</>;
  }
  return (
    <DesktopViewport>
      <Story />
    </DesktopViewport>
  );
};

const meta = {
  title: 'Sessions/SessionConversationPage',
  component: StoryShell,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    state: 'idle',
    frame: 'desktop',
  },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopIdle: Story = {
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopStreamingWorking: Story = {
  args: { state: 'working' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopPermissionApproval: Story = {
  args: { state: 'permission' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopAgentQuestion: Story = {
  args: { state: 'question' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const MobileIdle: Story = {
  args: { frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

// Short-body phone: shows how much the fixed header/tab bar/composer squeeze the
// scrollable message area. Use this when tuning mobile vertical density.
export const MobileIdleShortDevice: Story = {
  name: 'Mobile Idle (short device)',
  args: { frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withShortMobileViewport],
};

export const MobilePermissionApproval: Story = {
  args: { frame: 'mobile', state: 'permission' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const MobileAgentQuestion: Story = {
  args: { frame: 'mobile', state: 'question' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};
