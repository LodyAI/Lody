import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';
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
 *   (mirrors `session-chat-interface.tsx`). Reading-review file clicks use the
 *   real desktop side-panel layout or the mobile diff drawer.
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
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fn, userEvent, within } from 'storybook/test';
import {
  collectConversationMessages,
  getAgentConfigRoomId,
  getLodySessionPresenceKey,
  getMachineRoomId,
  getServerNow,
  getSessionRoomId,
  SESSION_GOAL_COMMANDS,
  type AgentConfigId,
  type AgentConfigMeta,
  type ConversationMessage,
  type LodyPresenceInstanceId,
  type LocalProjectId,
  type MachineId,
  type MachineViewMeta,
  type MessageContent,
  type MessageQueueItem,
  type SessionDoc,
  type SessionHistoryParsed,
  type SessionId,
  type SessionMeta,
  type SessionPullRequestMeta,
  type WorkspaceId,
} from '@lody/shared';
import { MessageQueueDisplay } from '@/components/sessions/message-queue';

import {
  conversationWideModeAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  userAtom,
} from '@/atoms';
import {
  agentConfigMetaCacheAtom,
  machineMetaCacheAtom,
  sessionMetaCacheAtom,
} from '@/atoms/doc-meta';
import { lodyPresenceStatesAtom } from '@/atoms/presence';
import { authTokenAtom, runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import { MessageRowView, SessionChatStreamView } from '@/components/ai-gui/view';
import {
  MessageSelectionContext,
  MessageSelectionToolbar,
  useMessageSelection,
} from '@/components/ai-gui/message-selection';
import { ChatShareImageDialog } from '@/components/sessions/chat-share-image-dialog';
import {
  FloatingPermissionRequest,
  hasPendingPermissionRequest,
} from '@/components/sessions/floating-permission-request';
import { SessionHeaderMenu } from '@/components/sessions/session-chat-interface';
import { SessionAccessControl } from '@/components/session-sharing';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import type { SessionMachineInfo } from '@/components/sessions/session-machine-info';
import {
  SessionConversationPage,
  SessionConversationPageBody,
} from '@/components/sessions/session-conversation-page';
import { SessionChatInputArea } from '@/components/sessions/session-chat-input-area';
import {
  Archive,
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
import {
  GlassIconButton,
  MobileSessionHeaderBackButton,
} from '@/components/mobile/glass-icon-button';
import {
  buildAcpSelectorOptions,
  type AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import { StableSessionContext } from '@/hooks/useStableSession';
import type { LodyAuthClient } from '@/lib/auth';
import type { SessionSharingState } from '@/lib/session-sharing';
import { cn } from '@/lib/utils';
import { AuthProvider } from '@/providers/convex-provider';
import readingPreviewImage from '@/assets/onboarding/intro/continuous-scroll.png';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { SessionConversationDiffPanel } from '@/components/sessions/session-conversation-diff-panel';
import {
  SessionMobileDiffDrawer,
  type MobileDiffView,
} from '@/components/sessions/session-mobile-diff-drawer';
import { SessionSidePanelTabBar } from '@/components/sessions/session-side-panel-tab-bar';
import { SessionBrowserPanelView } from '@/components/sessions/session-browser-panel-view';
import { ManagedPreviewSurface } from '@/components/sessions/managed-preview-surface';
import { createFakeSessionFileProvider } from '@/lib/session-file-provider';
import type { MinimalVisualAnnotationAnchor } from '@lody/shared/visual-annotation-types';
import type { PreviewVisualComment } from '@lody/shared/preview-comment-types';
import type { PreviewVisualCommentDocState, PreviewVisualCommentDocStore } from '@/atoms/runtime';

const STORY_WORKSPACE_ID = 'workspace-storybook-session-page' as WorkspaceId;
const STORY_WORKSPACE_SLUG = 'storybook';
const STORY_MACHINE_ID = 'machine-storybook-session-page' as MachineId;
const STORY_AGENT_CONFIG_ID = 'agent-storybook-session-page' as AgentConfigId;
const STORY_LOCAL_PROJECT_ID = 'local:lody' as LocalProjectId;
const STORY_AUTH_TOKEN = 'storybook-token';
const STORY_USER_ID = 'user-storybook-session-page';
const STORY_COLLABORATOR_ID = 'user-storybook-collaborator';

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

type PageState =
  | 'idle'
  | 'working'
  | 'permission'
  | 'question'
  | 'plan'
  | 'reading'
  | 'reading-working'
  | 'reading-permission'
  | 'reading-question';

const isReadingState = (state: PageState) => state.startsWith('reading');
const isWorkingState = (state: PageState) => state === 'working' || state === 'reading-working';

/** A finished conversation whose history is the point, not a pending state. */
const isSettledState = (state: PageState) =>
  state === 'idle' || state === 'plan' || state === 'reading';
type DeviceFrame = 'desktop' | 'mobile';

const action = fn();
const STREAM_INTERVAL_MS = 60;
const STREAM_CHUNK_TOTAL = 180;
const STREAM_CHUNKS = Array.from({ length: STREAM_CHUNK_TOTAL }, (_, index) => {
  const item = index + 1;
  if (item % 12 === 0) {
    return [
      `### Render checkpoint ${item / 12}`,
      '| Surface | Observation |',
      '| --- | --- |',
      `| Message stream | chunk ${item} appended |`,
      '| Working status | indicator remains active |',
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
  [STORY_COLLABORATOR_ID]: {
    name: 'Maya Chen',
    image: null,
    email: 'maya.chen@example.com',
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
const readingSelectorOptions = buildAcpSelectorOptions({
  configId: STORY_AGENT_CONFIG_ID,
  cliType: 'builtin',
  agentType: 'deepseek',
});

const buildSessionId = (state: PageState, frame: DeviceFrame): SessionId =>
  `session-storybook-${state}-${frame}` as SessionId;

const buildSession = (state: PageState, frame: DeviceFrame): SessionMeta => {
  const sessionId = buildSessionId(state, frame);
  const status =
    // `plan` is a FINISHED plan-mode turn, so the session is idle like any
    // other completed turn — it is the history that is interesting, not a
    // pending state.
    isSettledState(state)
      ? ({ type: 'idle' } as const)
      : isWorkingState(state)
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
    agentType: isReadingState(state) ? 'deepseek' : 'codex',
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
  // `endedAt` drives the worked header's duration and `fileDiff` the footer's
  // edited-files card. Dropping them here silently rendered every finished turn
  // as "Finished working" with no diff summary.
  endedAt: input.endedAt,
  fileDiff: input.fileDiff,
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
          '- `SessionTabBar` owns the thread tabs.',
          '- `SessionChatStreamView` renders the conversation.',
          '- `SessionChatInputArea` owns the composer and mode/model controls.',
          'I will keep the story wired to those components instead of making a separate mock page.',
        ].join('\n'),
      },
    ],
  }),
];

const collaborativeMessages = (): SessionHistoryParsed[] => [
  buildMessage({
    id: 'collaborative-user-zixuan',
    role: 'user',
    userId: STORY_USER_ID,
    timestamp: '2026-07-09T09:31:00.000Z',
    items: [
      {
        type: 'text',
        text: 'Could you keep the sender visible next to the timestamp in shared conversations?',
      },
    ],
  }),
  buildMessage({
    id: 'collaborative-assistant',
    role: 'assistant',
    timestamp: '2026-07-09T09:31:20.000Z',
    finished: true,
    modelInfo: { modelId: 'gpt-5', name: 'GPT-5', description: null, _meta: null },
    items: [
      {
        type: 'text',
        text: 'Yes. Each user message now keeps its sender name in the metadata row.',
      },
    ],
  }),
  buildMessage({
    id: 'collaborative-user-maya',
    role: 'user',
    userId: STORY_COLLABORATOR_ID,
    timestamp: '2026-07-09T09:33:00.000Z',
    items: [
      {
        type: 'text',
        text: 'And clicking my avatar on desktop should show my contact card.',
      },
    ],
  }),
];

const buildShareHistory = (): SessionHistoryParsed[] => {
  const turns: [string, string][] = [
    [
      'Why does searching the product list rerender every row?',
      'The filter runs on every render and creates a new array. Keep the query as state and derive the visible products with `useMemo`.\n\n```tsx\nconst visibleProducts = useMemo(\n  () => products.filter(product => product.name.includes(query)),\n  [products, query],\n);\n```',
    ],
    [
      'What about the row components?',
      'Wrap `ProductRow` in `memo` and keep its props stable. Use the product ID as the key, and pass a stable selection callback.',
    ],
    [
      'Will that also help when I select a product?',
      'Only rows whose selected state changes should rerender. Pass a boolean to each row instead of the entire selection set.\n\n```tsx\n<ProductRow\n  key={product.id}\n  product={product}\n  selected={selectedIds.has(product.id)}\n  onSelect={onSelect}\n/>\n```',
    ],
    [
      'How should we verify the change?',
      'Record the same search interaction in the React Profiler before and after the change.\n\n| Interaction | Expected result |\n| --- | --- |\n| Update search | Filter recomputes |\n| Select a product | Changed rows render |\n| Open a toolbar menu | Product rows stay stable |',
    ],
    [
      'Are there any tradeoffs?',
      'Memoization retains the previous result and compares dependencies. Keep the optimization where profiling shows a benefit; do not add custom equality functions without measuring them.',
    ],
    [
      'Give me the final checklist.',
      '1. Keep the original products unchanged.\n2. Derive filtered products from `products` and `query`.\n3. Memoize rows with stable props.\n4. Compare profiler recordings for the same interactions.',
    ],
  ];
  return turns.flatMap(([question, answer], index) => [
    buildMessage({
      id: `share-user-${index}`,
      role: 'user',
      userId: STORY_USER_ID,
      items: [{ type: 'text', text: question }],
    }),
    buildMessage({
      id: `share-assistant-${index}`,
      finished: true,
      modelInfo: { modelId: 'gpt-5', name: 'GPT-5', description: null, _meta: null },
      items: [
        {
          type: 'thought',
          text: 'Inspect the product list and compare the props passed to each row.',
        },
        {
          type: 'tool_call',
          toolCallId: `share-read-${index}`,
          title: 'Read src/ProductList.tsx',
          kind: 'read',
          status: 'completed',
          rawInput: { path: 'src/ProductList.tsx' },
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'const visibleProducts = products.filter(product => product.name.includes(query));',
              },
            },
          ],
        },
        { type: 'text', text: answer },
      ],
    }),
  ]);
};

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

const PLAN_MARKDOWN = [
  '## Goal',
  'Give every framed block in a turn the same panel, and put every row on one left rail.',
  '## Steps',
  '1. Move the frame / header / body tokens into `conversation-panel.ts` so the',
  '   header always carries the raised fill and the body never does.',
  '2. Drop the per-shell horizontal pads (`ToolCallCard`, attachments, the',
  '   permission card) so top-level rows share the column edge.',
  '3. Collapse a settled permission to one line; keep the pending card actionable.',
  '## Risk',
  'The terminal paints its own VS Code surface, so its header has to step off',
  '**that** colour rather than the frame.',
].join('\n');

/**
 * A finished plan-mode turn, end to end: exploration, the plan-approval card
 * and its one-line outcome, the approved implementation, the answer, and the
 * artefacts the agent left behind. This is the shape the bundled adapters emit
 * (`switch_mode` carries the plan as a `content` text block), and the one place
 * to look at plan geometry inside the real page chrome.
 */
const buildPlanHistory = (): SessionHistoryParsed[] => [
  buildMessage({
    id: 'plan-user-1',
    role: 'user',
    userId: STORY_USER_ID,
    timestamp: '2026-07-09T09:31:00.000Z',
    items: [
      {
        type: 'text',
        text: 'The plan-approval card is styled unlike everything else in the turn. Plan a fix first, then implement it.',
      },
    ],
  }),
  buildMessage({
    id: 'plan-assistant-1',
    role: 'assistant',
    timestamp: '2026-07-09T09:31:20.000Z',
    finished: true,
    endedAt: Date.parse('2026-07-09T09:59:55.000Z'),
    modelInfo: { modelId: 'gpt-5', name: 'GPT-5', description: null, _meta: null },
    fileDiff: [
      { filePath: 'packages/components/src/components/ai-gui/view.tsx', add: 96, del: 74 },
      {
        filePath: 'packages/components/src/components/ai-gui/conversation-panel.ts',
        add: 34,
        del: 0,
      },
    ],
    items: [
      // Pre-plan exploration. Folds under "Finished working": an earlier region
      // never claims the duration.
      {
        type: 'thought',
        text: 'Read the conversation renderer first, then decide which layer owns the geometry.',
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-read-1',
        title: 'Read packages/components/src/components/ai-gui/view.tsx',
        kind: 'read',
        status: 'completed',
        locations: [{ path: 'packages/components/src/components/ai-gui/view.tsx' }],
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-search-1',
        title: 'rg "bg-muted/70|bg-secondary/55" packages/components/src',
        kind: 'search',
        status: 'completed',
      },
      // The plan-approval card. Codex titles it "Implement this plan?"; the
      // region cut keys on `kind: switch_mode`, never the title.
      // CODEX shape (this session's `agentType`), copied from
      // `CodexAcpServer.requestPlanImplementationPermission`: the plan travels
      // in `rawInput`, which the card does not render, and the readable plan is
      // the separate `proposed_plan` item below. Claude's `ExitPlanMode` is the
      // other shape — plan in `content`, no `proposed_plan` — and is covered by
      // `AssistantTurnAlignment.stories.tsx`. Do not merge the two: a card with
      // BOTH prints the plan twice, which no adapter actually does.
      {
        type: 'tool_call',
        toolCallId: 'plan-review:plan-1',
        title: 'Implement this plan?',
        kind: 'switch_mode',
        status: 'completed',
        rawInput: { plan: PLAN_MARKDOWN },
        permissionRequest: {
          requestId: 'plan-exit-permission-1',
          options: [
            { optionId: 'implement', name: 'Yes, implement this plan', kind: 'allow_once' },
            {
              optionId: 'revise',
              name: 'No, and tell Codex what to do differently',
              kind: 'reject_once',
            },
          ],
          outcome: { outcome: 'selected', optionId: 'implement' },
        },
      },
      // The approved implementation. Last region, so it owns the duration.
      {
        type: 'thought',
        text: 'Start with the shared panel tokens, then remove the shell pads one file at a time.',
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-edit-1',
        title: 'Edit packages/components/src/components/ai-gui/conversation-panel.ts',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: 'packages/components/src/components/ai-gui/conversation-panel.ts' }],
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-edit-2',
        title: 'Edit packages/components/src/components/ai-gui/view.tsx',
        kind: 'edit',
        status: 'completed',
        locations: [{ path: 'packages/components/src/components/ai-gui/view.tsx' }],
      },
      {
        type: 'tool_call',
        toolCallId: 'plan-exec-1',
        title: 'pnpm --filter @lody/components test',
        kind: 'execute',
        status: 'completed',
        content: [
          {
            type: 'terminal_command',
            command: '/bin/bash',
            args: ['-lc', 'pnpm --filter @lody/components test'],
            cwd: '/repo',
          },
          {
            type: 'terminal_output',
            output: [
              ' Test Files  401 passed (401)',
              '      Tests  2873 passed (2873)',
              '   Duration  38.99s',
            ].join('\n'),
          },
        ],
      },
      {
        type: 'text',
        text: [
          'Every framed block now uses one panel: the header carries the raised fill and the body sits on the frame.',
          'Measured against the column edge, all top-level rows start at 0 and the header step is +12 in dark / -13 in light.',
        ].join('\n'),
      },
      {
        type: 'proposed_plan',
        turnId: 'plan-turn-1',
        markdown: PLAN_MARKDOWN,
        status: 'completed',
        isLatest: true,
      },
      {
        type: 'file',
        fileId: 'plan-report-1',
        fileName: 'panel-geometry-report.md',
        mimeType: 'text/markdown',
        sizeBytes: 4096,
        sha256: 'c'.repeat(64),
        textPreview: true,
        uploadedAt: Date.parse('2026-07-09T09:59:50.000Z'),
        transport: 'r2',
      },
    ],
  }),
];

const READING_ANSWER = [
  '## 阅读样式审查结论',
  '',
  '这一轮把对话页的阅读栏调整到 `768px`，正文保持 **14px**，并统一了暖色调。长段中文在这个宽度下每行大约 54 个字，',
  '配合 1.75 的行高，连续阅读时不会显得拥挤。English prose mixed into the same paragraph keeps the same rhythm, and',
  'inline code such as `CONVERSATION_CONTENT_WIDTH_CLASS` stays readable without shouting.',
  '',
  '相关的 PR 和 Issue 会渲染成小标签：https://github.com/LodyAI/Lody/pull/954 已经合入，',
  '[#951](https://github.com/LodyAI/Lody/pull/951) 还在 review，跟进的问题记在',
  '[LodyAI/Lody#960](https://github.com/LodyAI/Lody/issues/960)。带描述文字的链接保持原样，比如',
  '[这次调整的背景](https://github.com/LodyAI/Lody/pull/917)。',
  '',
  '### 改动要点',
  '',
  '- 正文、选中项和激活标签使用同一个阅读色；界面文字低一档。',
  '- Git 状态图标在侧栏里降低饱和度，`Mergeable` 标签更醒目。',
  '- 宽表格和 Mermaid 图留在 768px 的阅读栏内：',
  '  - 表格在内部横向滚动；',
  '  - 图表可以点开全屏查看。',
  '',
  '> 引用块用于强调上下文，颜色比正文低一档，不会抢走注意力。',
  '',
  '| Surface | Before | After | Contrast | Font | Line height | Width | Notes |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  '| Conversation prose | #D5D5D5 | #EFEDEB | 15.9:1 | 14px PingFang SC | 1.75 | 768px | Warm hue, HSL lightness 93% |',
  '| Interface text | #FFFFFF | #DDD7CF | 13:1 | 14px | 1.5 | — | Menus, settings, buttons share one level |',
  '| Selected sidebar row | #F0EFED | #EFEDEB | 15.9:1 | 14px | 1.5 | — | Marked by its fill, not extra brightness |',
  '| Headings and bold | #EBEBEB | #FCF6ED | 17.3:1 | 17–19px | 1.4 | 768px | One step above prose |',
  '',
  '一张窄表格仍然贴合阅读栏：',
  '',
  '| 档位 | 字号 |',
  '| --- | --- |',
  '| 默认 | 14px |',
  '| 大 | 15px |',
  '',
  '```mermaid',
  'flowchart LR',
  '  theme[Vesper JSON] --> warm[Warm white point] --> alias[Lody aliases] --> ceiling[Brightness ceiling]',
  '  ceiling --> prose[Prose 14.2:1] --> view[Conversation view]',
  '  ceiling --> chrome[Interface 11.6:1] --> sidebar[Sidebar and menus]',
  '  ceiling --> strong[Headings 15:1] --> view',
  '  warm --> terminal[Terminal palette] --> shiki[Code highlighting] --> diff[Diff viewer]',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A[Setting] --> B[14px prose]',
  '  A --> C[14px chrome]',
  '```',
  '',
  '```ts',
  'export const CONVERSATION_FONT_SIZES = [12, 13, 14, 15, 16] as const;',
  'export const DEFAULT_CONVERSATION_FONT_SIZE = 14;',
  '```',
  '',
  '### 其他 Markdown 内容',
  '',
  '**中文加粗。**接着是 *斜体*、~~删除线~~和 [普通链接](https://example.com)。',
  '',
  '- [x] 检查完成后的排版',
  '- [ ] 检查流式输出和窄屏',
  '',
  '阅读栏宽度与字体大小的关系：',
  '',
  '$$',
  String.raw`\text{characters per line} \approx \frac{\text{column width}}{\text{font size}}`,
  '$$',
  '',
  `![会话滚动示意图](${readingPreviewImage})`,
  '',
  ':codex-file-citation{path="/tmp/exports/reading-report.pdf" purpose="output"}',
  '',
  '需要的话，我可以继续把 Linear 和 Figma 链接也做成同样的小标签。',
].join('\n');

const READING_FILE_DIFFS = [
  { filePath: 'packages/components/src/lib/conversation-layout.ts', add: 4, del: 3 },
  { filePath: 'packages/components/src/tailwind/index.css', add: 38, del: 2 },
  { filePath: 'packages/components/src/atoms/settings.ts', add: 6, del: 3 },
  { filePath: 'packages/components/src/components/ai-gui/markdown-table.tsx', add: 12, del: 4 },
  { filePath: 'docs/reading-guide.md', add: 8, del: 1 },
];

const READING_DIFF_TEXT: Record<string, { oldText: string; newText: string }> = {
  'packages/components/src/lib/conversation-layout.ts': {
    oldText: 'export const readingWidth = 640;\n',
    newText: 'export const readingWidth = 768;\n',
  },
  'packages/components/src/tailwind/index.css': {
    oldText: '.reading-column { max-width: 40rem; }\n',
    newText: '.reading-column { max-width: 48rem; }\n',
  },
  'packages/components/src/atoms/settings.ts': {
    oldText: 'export const defaultFontSize = 13;\n',
    newText: 'export const defaultFontSize = 14;\n',
  },
  'packages/components/src/components/ai-gui/markdown-table.tsx': {
    oldText: 'export const tableOverflow = "visible";\n',
    newText: 'export const tableOverflow = "auto";\n',
  },
  'docs/reading-guide.md': {
    oldText: '# Reading\n\nUse the narrow layout.\n',
    newText: '# Reading\n\nUse the responsive layout.\n',
  },
};

const READING_ANNOTATION_ANCHOR: MinimalVisualAnnotationAnchor = {
  version: 1,
  page: {
    url: 'http://localhost:5173/preview',
    pathname: '/preview',
    viewport: { width: 960, height: 620, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
  },
  click: {
    clientX: 160,
    clientY: 120,
    pageX: 160,
    pageY: 120,
    viewportXRatio: 1 / 6,
    viewportYRatio: 120 / 620,
  },
  target: {
    tag: 'h1',
    attributes: {},
    text: '阅读样式',
    rect: { x: 80, y: 80, width: 320, height: 80 },
    rectRatio: { x: 1 / 12, y: 80 / 620, width: 1 / 3, height: 80 / 620 },
    selector: 'main h1',
  },
  context: { ancestors: [{ tag: 'main', selector: 'main' }], nearbyText: ['阅读样式'] },
};
const READING_ANNOTATION: PreviewVisualComment = {
  id: 'reading-visual-comment',
  turnId: 'reading-user-2',
  status: 'submitted',
  body: '这里的标题与正文之间可以再留一点空间。',
  authorId: 'reading-designer',
  authorName: 'Designer',
  createdAt: 1_800_000,
  updatedAt: 1_800_000,
  anchor: READING_ANNOTATION_ANCHOR,
};

const readingFileProvider = createFakeSessionFileProvider({
  supportsHistoricalDiffs: true,
  diffs: Object.fromEntries(
    READING_FILE_DIFFS.map(({ filePath }) => [
      filePath,
      {
        status: 'ready',
        path: filePath,
        oldSnapshot: { kind: 'text', text: READING_DIFF_TEXT[filePath]!.oldText },
        newSnapshot: { kind: 'text', text: READING_DIFF_TEXT[filePath]!.newText },
      },
    ])
  ),
});
readingFileProvider.getAllChangesDiff = async () => ({
  status: 'ready',
  base: 'synthetic-base',
  truncated: false,
  entries: READING_FILE_DIFFS.map(({ filePath }) => ({
    path: filePath,
    diff: { status: 'deferred' },
  })),
});

const readingCommand = (
  id: string,
  command: string,
  output: string,
  exitCode = 0
): MessageContent => ({
  type: 'tool_call',
  toolCallId: `reading-${id}`,
  title: command,
  kind: 'execute',
  status: exitCode === 0 ? 'completed' : 'failed',
  content: [
    { type: 'terminal_command', command: '/bin/bash', args: ['-lc', command], cwd: '/repo' },
    { type: 'terminal_output', stream: 'combined', output, exitStatus: { exitCode, signal: null } },
  ],
});

/**
 * Synthetic content for reviewing conversation surfaces in their real message
 * layout. Running and permission states extend the same history below.
 */
const buildReadingHistory = (): SessionHistoryParsed[] => [
  buildMessage({
    id: 'reading-user-1',
    role: 'user',
    userId: STORY_USER_ID,
    timestamp: '2026-07-09T09:31:00.000Z',
    items: [
      {
        type: 'text',
        text: '帮我审查一下对话页的阅读样式：字号、行宽、颜色，还有表格和图表在宽屏上的表现。',
      },
    ],
  }),
  buildMessage({
    id: 'reading-assistant-1',
    role: 'assistant',
    timestamp: '2026-07-09T09:31:20.000Z',
    finished: true,
    endedAt: Date.parse('2026-07-09T09:38:15.000Z'),
    modelInfo: { modelId: 'deepseek-chat', name: 'DeepSeek', description: null, _meta: null },
    fileDiff: READING_FILE_DIFFS,
    items: [
      { type: 'thought', text: '先确认阅读栏的宽度、正文间距和不同内容类型的渲染方式。' },
      { type: 'text', text: '先看一下当前的布局和字号设置。' },
      {
        type: 'tool_call',
        toolCallId: 'reading-read',
        title: 'Read packages/components/src/lib/conversation-layout.ts',
        kind: 'read',
        status: 'completed',
        locations: [{ path: 'packages/components/src/lib/conversation-layout.ts' }],
        content: [
          { type: 'content', content: { type: 'text', text: 'export const readingWidth = 640;' } },
        ],
      },
      {
        type: 'tool_call',
        toolCallId: 'reading-search',
        title: 'Search for reading width',
        kind: 'search',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Found 3 matching files.' } }],
      },
      {
        type: 'tool_call',
        toolCallId: 'reading-mcp',
        title: 'Inspect design tokens',
        kind: 'mcp',
        status: 'completed',
        rawInput: { token: 'conversation.width' },
        rawOutput: { value: '48rem' },
        content: [{ type: 'content', content: { type: 'text', text: '{"value":"48rem"}' } }],
      },
      {
        type: 'tool_call',
        toolCallId: 'reading-fetch',
        title: 'Fetch layout guidance',
        kind: 'fetch',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Keep long-form content readable on narrow screens.' },
          },
        ],
      },
      readingCommand(
        'cmd-1',
        'rg CONVERSATION_CONTENT_WIDTH_CLASS packages/components/src',
        'packages/components/src/lib/conversation-layout.ts: export const CONVERSATION_CONTENT_WIDTH_CLASS'
      ),
      readingCommand(
        'cmd-2',
        'pnpm --filter @lody/components test -- conversation-layout',
        'Expected width 768, received 640. Updating the layout token.',
        1
      ),
      {
        type: 'tool_call',
        toolCallId: 'reading-edit',
        title: 'Edit packages/components/src/lib/conversation-layout.ts',
        kind: 'edit',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'packages/components/src/lib/conversation-layout.ts',
            oldText: 'export const readingWidth = 640;\n',
            newText: 'export const readingWidth = 768;\n',
          },
        ],
      },
      {
        type: 'tool_call',
        toolCallId: 'reading-compaction',
        title: 'Compact context',
        kind: 'other',
        status: 'completed',
        activityKind: 'context_compaction',
      },
      readingCommand(
        'cmd-4',
        'pnpm --filter @lody/components test -- conversation-layout',
        '1 test passed.'
      ),
      readingCommand('cmd-5', 'pnpm run docs check', 'Documentation links checked.'),
      { type: 'text', text: READING_ANSWER },
    ],
  }),
  buildMessage({
    id: 'reading-user-2',
    role: 'user',
    userId: STORY_USER_ID,
    timestamp: '2026-07-09T09:40:00.000Z',
    items: [
      { type: 'text', text: '宽表格在窄窗口下会怎样？也看看这两条标注。' },
      {
        type: 'comment_reference',
        source: 'lody',
        path: 'packages/components/src/lib/conversation-layout.ts',
        lineNumber: 12,
        side: 'additions',
        commentBody: '窄屏也要保留足够的阅读边距。',
        authorName: 'Reviewer',
        threadId: 'reading-review-comment',
        turnId: 'reading-assistant-1',
        mode: 'conversation',
        replies: [{ authorName: 'Designer', body: '会一起检查移动端。' }],
      },
      {
        type: 'visual_annotation_reference',
        source: 'visual_annotation',
        commentId: READING_ANNOTATION.id,
        body: READING_ANNOTATION.body,
        authorName: READING_ANNOTATION.authorName,
        status: READING_ANNOTATION.status,
        anchor: READING_ANNOTATION_ANCHOR,
      },
    ],
  }),
  buildMessage({
    id: 'reading-assistant-2',
    role: 'assistant',
    timestamp: '2026-07-09T09:40:10.000Z',
    finished: true,
    endedAt: Date.parse('2026-07-09T09:40:40.000Z'),
    modelInfo: { modelId: 'deepseek-chat', name: 'DeepSeek', description: null, _meta: null },
    items: [
      {
        type: 'text',
        text: '窗口变窄时，表格和图表收回到阅读栏宽度，超出的部分在表格内部横向滚动，不会撑开整个页面。',
      },
    ],
  }),
];

const buildHistory = (
  state: PageState,
  streamChunkCount = 0,
  showCapacityRetry = false,
  readingLiveTimestamp = '2026-07-09T09:41:00.000Z'
): SessionHistoryParsed[] => {
  if (state === 'working') {
    return buildWorkingHistory(streamChunkCount);
  }
  if (state === 'plan') {
    return buildPlanHistory();
  }
  if (isReadingState(state)) {
    const messages = buildReadingHistory();
    if (state === 'reading-working') {
      messages.push(
        buildMessage({
          id: 'reading-user-working',
          role: 'user',
          userId: STORY_USER_ID,
          timestamp: readingLiveTimestamp,
          items: [{ type: 'text', text: '继续检查窄屏布局。' }],
        }),
        buildMessage({
          id: 'reading-assistant-working',
          role: 'assistant',
          timestamp: readingLiveTimestamp,
          finished: false,
          items: [
            { type: 'thought', text: '先比较手机宽度下的表格和代码块。' },
            {
              type: 'text',
              text: [
                '正在检查移动端的阅读布局。\n\n**表格**会保留内部横向滚动。',
                '\n\n| 内容 | 预期 |\n| --- | --- |\n| 表格 | 内部滚动 |',
                '\n\n```ts\nconst readingWidth = 768;\n```',
              ]
                .slice(0, Math.max(1, streamChunkCount))
                .join(''),
            },
            {
              type: 'tool_call',
              toolCallId: 'reading-running-command',
              title: 'pnpm --filter @lody/components test -- mobile-layout',
              kind: 'execute',
              status: 'in_progress',
              content: [
                {
                  type: 'terminal_command',
                  command: '/bin/bash',
                  args: ['-lc', 'pnpm --filter @lody/components test -- mobile-layout'],
                  cwd: '/repo',
                },
                { type: 'terminal_output', stream: 'combined', output: 'Checking mobile layout…' },
              ],
            },
          ],
        })
      );
    } else if (state === 'reading-permission' || state === 'reading-question') {
      messages.push(
        buildMessage({
          id: 'reading-user-pending',
          role: 'user',
          userId: STORY_USER_ID,
          timestamp: '2026-07-09T09:41:00.000Z',
          items: [{ type: 'text', text: '接下来请根据检查结果继续。' }],
        }),
        buildMessage({
          id: 'reading-assistant-pending',
          role: 'assistant',
          timestamp: '2026-07-09T09:41:05.000Z',
          items: [
            state === 'reading-permission' ? pendingPermissionToolCall() : questionToolCall(),
          ],
        })
      );
    }
    return messages;
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
  if (showCapacityRetry) {
    messages.push(
      buildMessage({
        id: 'capacity-user-turn',
        role: 'user',
        userId: STORY_USER_ID,
        timestamp: '2026-07-09T09:35:00.000Z',
        items: [{ type: 'text', text: 'Please continue with the implementation.' }],
      }),
      buildMessage({
        id: 'capacity-failure',
        role: 'system',
        timestamp: '2026-07-09T09:35:02.000Z',
        items: [
          {
            type: 'system_notice',
            name: 'chat_failed',
            meta: {
              reason: 'acp_provider_overloaded',
              message: 'Selected model is at capacity. Please try a different model.',
            },
          },
        ],
      })
    );
  }
  return messages;
};

const toStreamItems = (sessionId: SessionId, messages: SessionHistoryParsed[]) =>
  messages.map(
    (message, turnIndex) => ({ type: 'message', sessionId, message, turnIndex }) as const
  );

const renderMessageRow = (
  {
    message,
    sessionId,
  }: {
    message: SessionHistoryParsed;
    sessionId: SessionId;
  },
  showSenderIdentity = false
) => (
  <MessageRowView
    message={message}
    sessionId={sessionId}
    user={message.userId ? usersById[message.userId] : undefined}
    showSenderIdentity={showSenderIdentity}
    capacityRetry={
      message.id === 'capacity-failure'
        ? {
            noticeId: message.id,
            retryInSeconds: 4,
            retryRemainingRatio: 0.8,
            pending: false,
            canRetry: true,
            autoRetryEnabled: true,
            autoRetryExhausted: false,
            retry: action,
            stopAutoRetry: action,
          }
        : undefined
    }
  />
);

function createReadingRuntime(sessionId: SessionId): WorkspaceRuntime {
  let comments = [READING_ANNOTATION];
  const listeners = new Set<(state: PreviewVisualCommentDocState) => void>();
  const getPreviewState = () =>
    ({
      meta: { sessionId },
      turns: { 'reading-user-2': { turnId: 'reading-user-2', comments } },
    }) as unknown as PreviewVisualCommentDocState;
  const previewStore = {
    getState: getPreviewState,
    getSyncState: () => 'synced' as const,
    subscribeSyncState: () => () => {},
    subscribe: (listener: (state: PreviewVisualCommentDocState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    waitUntilSynced: async () => {},
  } as unknown as PreviewVisualCommentDocStore;
  const sessionStore = {
    doc: undefined,
    history: null,
    getState: () => ({ session: { id: sessionId }, mq: [], humanInputReceipts: {} }),
    getSyncState: () => 'synced' as const,
    subscribeSyncState: () => () => {},
    subscribe: () => () => {},
    acquireSync: () => () => {},
  };
  const mutatePreviewVisualComments: WorkspaceRuntime['writer']['mutatePreviewVisualComments'] =
    async (_sessionId, mutation) => {
      if (mutation.kind === 'resolve') {
        comments = comments.map((comment) =>
          comment.id === mutation.commentId
            ? { ...comment, resolvedAt: mutation.resolvedAt, resolvedBy: mutation.resolvedBy }
            : comment
        );
      } else if (mutation.kind === 'unresolve') {
        comments = comments.map((comment) => {
          if (comment.id !== mutation.commentId) return comment;
          const { resolvedAt: _resolvedAt, resolvedBy: _resolvedBy, ...remaining } = comment;
          return remaining;
        });
      }
      const nextState = getPreviewState();
      listeners.forEach((listener) => listener(nextState));
    };

  return {
    ...storyRuntime,
    acquireSessionStore: async () => sessionStore,
    releaseSessionStoreRef: () => {},
    acquirePreviewVisualCommentStore: async () => previewStore,
    releasePreviewVisualCommentStoreRef: () => {},
    withPreviewVisualCommentStore: async <T,>(
      _sessionId: SessionId,
      operation: (store: PreviewVisualCommentDocStore) => T | Promise<T>
    ): Promise<T> => operation(previewStore),
    writer: { mutatePreviewVisualComments },
  } as unknown as WorkspaceRuntime;
}

function createStoryStore(session: SessionMeta, state: PageState) {
  const store = createStore();
  store.set(currentWorkspaceIdAtom, STORY_WORKSPACE_ID);
  store.set(currentWorkspaceSlugAtom, STORY_WORKSPACE_SLUG);
  store.set(authTokenAtom, STORY_AUTH_TOKEN);
  store.set(runtimeAtom, isReadingState(state) ? createReadingRuntime(session.id) : storyRuntime);
  store.set(userAtom, {
    id: STORY_USER_ID,
    name: 'Zixuan',
    email: 'zixuan@example.com',
    image: null,
  });
  store.set(machineMetaCacheAtom, {
    [getMachineRoomId(STORY_MACHINE_ID)]: machineMeta,
  });
  store.set(agentConfigMetaCacheAtom, {
    [getAgentConfigRoomId(STORY_AGENT_CONFIG_ID)]: isReadingState(state)
      ? { ...agentConfigMeta, name: 'DeepSeek', agentType: 'deepseek' }
      : agentConfigMeta,
  });
  store.set(sessionMetaCacheAtom, {
    [getSessionRoomId(session.id)]: session,
  });
  if (!isSettledState(state)) {
    const instanceId = `storybook-${state}` as LodyPresenceInstanceId;
    const status = isWorkingState(state)
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

const STORY_QUEUED_TASKS = [
  'After the permission flow lands, tighten the mobile composer spacing.',
  'Then run the Storybook render budgets again.',
];

const storyQueueItems = (): MessageQueueItem[] =>
  STORY_QUEUED_TASKS.map((task, i) => ({
    $cid: `story-queue-${i}`,
    task,
    userId: 'user-1',
    userTurnId: `story-queued-turn-${i}`,
    timestamp: new Date(getServerNow() - i * 1000).toISOString(),
    acpSessionConfig: { prompt: task, cliType: 'claude-code', agentType: 'claude-code' },
  })) as unknown as MessageQueueItem[];

function StoryInfoBar({
  session,
  queued,
  reading = false,
  machine,
  machineOnly = false,
  mobile = false,
  onOpenAllChanges = action,
}: {
  session: SessionMeta;
  machine?: SessionMachineInfo | null;
  machineOnly?: boolean;
  mobile?: boolean;
  onOpenAllChanges?: () => void;
  /** Queued turns stacked on the bar, or on the composer when the bar is empty. */
  queued?: 'with-info-bar' | 'without-info-bar';
  /** The reading review: a merged PR with passing CI and the line totals. */
  reading?: boolean;
}) {
  if (machineOnly)
    return (
      <SessionInfoBar
        status={null}
        machine={machine}
        compactMachineInfo={mobile}
        protectFromEdgeBackZone={mobile}
      />
    );
  if (reading) {
    return (
      <SessionInfoBar
        status={null}
        machine={machine}
        compactMachineInfo={mobile}
        protectFromEdgeBackZone={mobile}
        projectName={session.repoFullName}
        branch={mobile ? null : session.branchName}
        pr={{ url: 'https://github.com/LodyAI/Lody/pull/3656', status: 'merged' }}
        onOpenPr={action}
        prCiRuns={[
          { name: 'Static checks', status: 'success', durationMs: 184_000 },
          { name: 'Tests', status: 'success', durationMs: 412_000 },
          { name: 'Desktop E2E (smoke)', status: 'success', durationMs: 655_000 },
        ]}
        onOpenPrCiRun={action}
        diffStat={{ add: 365, del: 102 }}
        onOpenAllChanges={onOpenAllChanges}
      />
    );
  }
  const withoutBar = queued === 'without-info-bar';
  const queue = queued ? (
    <MessageQueueDisplay
      sessionId={session.id}
      items={storyQueueItems()}
      onRemove={fn()}
      onReorder={fn()}
      onEditStart={fn()}
      onEditCancel={fn()}
      onEditSave={fn()}
      onSteer={fn()}
      showSteerAction
    />
  ) : undefined;
  if (withoutBar) return <SessionInfoBar status={null} queue={queue} />;
  return (
    <SessionInfoBar
      queue={queue}
      machine={machine}
      compactMachineInfo={mobile}
      protectFromEdgeBackZone={mobile}
      status={
        machine?.onlineStatus === 'offline'
          ? { kind: 'machine-offline', machineName: machine.name }
          : null
      }
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
      branch={mobile ? null : session.branchName}
      pr={storyPullRequest}
      onOpenPr={action}
      diffStat={{ add: 128, del: 42 }}
      onOpenAllChanges={action}
    />
  );
}

function StoryComposer({
  session,
  isAgentBusy,
  onSendMessage,
  initialInputText = 'Tighten the mobile spacing after the permission flow is stable.',
  modelLabel,
  claimNavigationFocus,
}: {
  session: SessionMeta;
  isAgentBusy: boolean;
  onSendMessage?: ComponentProps<typeof SessionChatInputArea>['onSendMessage'];
  initialInputText?: string;
  modelLabel?: string;
  claimNavigationFocus?: () => boolean;
}) {
  const baseOptions = session.agentType === 'deepseek' ? readingSelectorOptions : selectorOptions;
  const options = modelLabel
    ? {
        ...baseOptions,
        modelOptions: [{ value: modelLabel, label: modelLabel }],
        modeOptions: [{ value: 'auto', label: 'Auto' }],
        configOptionSelectors: [],
      }
    : baseOptions;
  const [mode, setMode] = useState<string | null>(options.modeOptions[0]?.value ?? null);
  const [model, setModel] = useState<string | null>(options.modelOptions[0]?.value ?? null);
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>(() =>
    Object.fromEntries(
      options.configOptionSelectors.map((selector) => [selector.configId, selector.currentValue])
    )
  );

  return (
    <SessionChatInputArea
      claimNavigationFocus={claimNavigationFocus}
      // The info bar above owns this gap, as on the session page.
      hideTopSpacer
      session={session}
      sessionLocalProjectRootPath="/Users/developer/Code/lody"
      isMachineRemoved={false}
      isAgentBusy={isAgentBusy}
      isDark
      isEmptyConversation={false}
      selectedModeId={mode}
      selectedModelId={model}
      modeOptions={options.modeOptions}
      modelOptions={options.modelOptions}
      configOptionSelectors={options.configOptionSelectors}
      configOptionValues={configValues}
      isRepoPublic
      availableCommands={[]}
      onModeChange={setMode}
      onModelChange={setModel}
      onConfigOptionChange={(configId, value) =>
        setConfigValues((prev) => ({ ...prev, [configId]: value }))
      }
      onSendMessage={onSendMessage ?? (async () => true)}
      onStop={action}
      onRemoveQueueItem={async () => undefined}
      initialInputText={initialInputText}
      disableImageUpload
    />
  );
}

type ReadingPanelSelection =
  | { kind: 'diff'; turnId: string; filePath?: string; mode?: 'base' | 'conversation' }
  | { kind: 'preview' };

const readingPreviewUrl = 'http://localhost:5173/preview';
const readingPreviewHtml = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:0;padding:48px;font:16px system-ui;background:#fff;color:#20242b}main{max-width:640px;margin:auto}h1{font-size:32px}p{line-height:1.7;color:#525b68}</style><main><h1>阅读样式</h1><p>这是一份用于展示视觉标注的合成预览页面。</p></main></html>`;
const readingPreviewToolbar: ComponentProps<typeof SessionBrowserPanelView>['toolbar'] = {
  address: readingPreviewUrl,
  canGoBack: false,
  canGoForward: false,
  loading: false,
  annotationEnabled: false,
  annotationAvailable: false,
  sharing: false,
  shareAvailable: false,
  hasShareUrl: false,
  busy: false,
  onAddressChange: action,
  onRestoreAddress: action,
  onNavigate: action,
  onBack: action,
  onForward: action,
  onReload: action,
  onStop: action,
  onToggleAnnotation: action,
  onShare: action,
  onStopSharing: action,
};

function ReadingReviewDiffLayout({
  enabled,
  frame,
  session,
  selection,
  onSelect,
  onClose,
  children,
}: {
  enabled: boolean;
  frame: DeviceFrame;
  session: SessionMeta;
  selection: ReadingPanelSelection | null;
  onSelect: (selection: ReadingPanelSelection) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [mobileView, setMobileView] = useState<MobileDiffView>('diff');
  useLayoutEffect(() => {
    if (selection) {
      setMobileView(
        selection.kind === 'diff' && selection.mode === 'base' && !selection.filePath
          ? 'files'
          : 'diff'
      );
    }
  }, [selection]);

  if (!enabled) return children;

  const diff =
    selection?.kind === 'diff' ? (
      <SessionConversationDiffPanel
        active={frame === 'desktop' || mobileView === 'diff'}
        sessionId={session.id}
        turnId={selection.turnId}
        mode={selection.mode}
        filePaths={READING_FILE_DIFFS.map((entry) => entry.filePath)}
        fileDiffs={READING_FILE_DIFFS}
        focusFilePath={selection.filePath}
        fileProvider={readingFileProvider}
      />
    ) : null;

  if (frame === 'mobile') {
    return (
      <>
        {children}
        <SessionMobileDiffDrawer
          open={selection !== null}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
          view={mobileView}
          onBackToFiles={() => setMobileView('files-with-diff')}
          changes={{
            ready: true,
            synced: true,
            changeEntries: READING_FILE_DIFFS,
            changeFilePaths: READING_FILE_DIFFS.map((entry) => entry.filePath),
            onOpenChangesDiff: (filePath) =>
              onSelect({
                kind: 'diff',
                turnId: selection?.kind === 'diff' ? selection.turnId : 'reading-assistant-1',
                mode: selection?.kind === 'diff' ? selection.mode : undefined,
                filePath,
              }),
          }}
        >
          {diff}
        </SessionMobileDiffDrawer>
      </>
    );
  }

  const isPreview = selection?.kind === 'preview';
  const label = isPreview
    ? t('sessions.sidebar.browser', 'Browser')
    : t('sessions.diffTab', 'Conversation Diff');
  const panel = isPreview ? (
    <SessionBrowserPanelView toolbar={readingPreviewToolbar} onDismissError={action}>
      <ManagedPreviewSurface
        session={session}
        viewerUrl={readingPreviewUrl}
        logicalUrl={readingPreviewUrl}
        documentHtml={readingPreviewHtml}
        annotationEnabled={false}
        onAnnotationAvailabilityChange={action}
        onRuntimeError={action}
        onLoadingChange={action}
        onBrowserStateChange={action}
        onNavigationRequest={action}
      />
    </SessionBrowserPanelView>
  ) : (
    diff
  );
  return (
    <DesktopSessionDetailLayout
      defaultSizes={{ main: selection ? 55 : 100, sidebar: 45 }}
      topBar={null}
      chatSurfaces={children}
      terminalDock={null}
      sidebarOpen={selection !== null}
      onSidebarCollapse={onClose}
      deleteConfirmDialog={null}
      secondaryPanel={
        <div className="flex h-full min-h-0 flex-col">
          <SessionSidePanelTabBar
            tabs={[
              { id: 'reading-panel', label, kind: isPreview ? 'browser' : 'diff', closeable: true },
            ]}
            activeTabId="reading-panel"
            onTabSelect={() => {}}
            onTabClose={onClose}
            closeTabLabel={(tabLabel) =>
              t('sessions.fileViewer.closeTab', 'Close {{fileName}}', { fileName: tabLabel })
            }
          />
          <div className="min-h-0 flex-1">{panel}</div>
        </div>
      }
    />
  );
}

export function SessionConversationStoryHarness({
  state,
  frame,
  embedded = false,
  sessionTitle,
  repoFullName,
  branchName,
  composerText,
  dropActive = false,
  showCapacityRetry = false,
  shareImage = false,
  showCollaborators = false,
  queued,
  wide = false,
  machineInfo,
  machineOnly = false,
  annotationPreview = false,
  firstUserMessage,
  onPresented,
  composerModelLabel,
  claimNavigationFocus,
}: {
  state: PageState;
  frame: DeviceFrame;
  embedded?: boolean;
  sessionTitle?: string;
  repoFullName?: string;
  branchName?: string;
  composerText?: string;
  dropActive?: boolean;
  showCapacityRetry?: boolean;
  shareImage?: boolean;
  showCollaborators?: boolean;
  queued?: 'with-info-bar' | 'without-info-bar';
  machineInfo?: SessionMachineInfo;
  machineOnly?: boolean;
  annotationPreview?: boolean;
  firstUserMessage?: string;
  onPresented?: () => void;
  composerModelLabel?: string;
  claimNavigationFocus?: () => boolean;
  /** Mirrors the Settings > Appearance "Full width" switch. */
  wide?: boolean;
}) {
  const { t } = useTranslation();
  useLayoutEffect(() => {
    onPresented?.();
  }, [onPresented]);
  const [streamChunkCount, setStreamChunkCount] = useState(0);
  const [readingLiveTimestamp] = useState(() => new Date(getServerNow() - 45_000).toISOString());
  const [readingPanel, setReadingPanel] = useState<ReadingPanelSelection | null>(
    annotationPreview ? { kind: 'preview' } : null
  );
  const openReadingDiff = useCallback((turnId: string, filePath: string) => {
    setReadingPanel({ kind: 'diff', turnId, filePath });
  }, []);
  const openReadingAllChanges = useCallback(() => {
    setReadingPanel({ kind: 'diff', turnId: 'all-changes', mode: 'base' });
  }, []);
  const closeReadingPanel = useCallback(() => setReadingPanel(null), []);
  const session = useMemo(() => {
    const baseSession = buildSession(state, frame);
    return {
      ...baseSession,
      ...(shareImage
        ? { title: 'Product list rendering performance' }
        : showCollaborators
          ? { title: 'Shared conversation' }
          : sessionTitle
            ? { title: sessionTitle }
            : {}),
      ...(repoFullName ? { repoFullName } : {}),
      ...(branchName ? { branchName } : {}),
    };
  }, [branchName, frame, repoFullName, sessionTitle, shareImage, showCollaborators, state]);
  useEffect(() => {
    setReadingPanel(annotationPreview ? { kind: 'preview' } : null);
  }, [annotationPreview, session.id]);
  const selection = useMessageSelection(session.id);
  const [preview, setPreview] = useState<ConversationMessage[] | null>(null);
  const [sentMessages, setSentMessages] = useState<SessionHistoryParsed[]>([]);
  const store = useMemo(() => createStoryStore(session, state), [session, state]);
  /* Wide mode is a persisted atom; seed it per story instead of leaking the
     previous story's localStorage pick into this one. */
  useEffect(() => {
    store.set(conversationWideModeAtom, wide);
  }, [store, wide]);
  useEffect(() => {
    setStreamChunkCount(0);
    if (!isWorkingState(state)) {
      return undefined;
    }
    const total = state === 'reading-working' ? 3 : STREAM_CHUNK_TOTAL;
    const interval = window.setInterval(
      () => {
        setStreamChunkCount((current) => {
          if (current >= total) {
            window.clearInterval(interval);
            return current;
          }
          return current + 1;
        });
      },
      state === 'reading-working' ? 600 : STREAM_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [state]);
  const history = useMemo(
    () =>
      firstUserMessage !== undefined
        ? [
            buildMessage({
              id: 'new-chat-first-turn',
              role: 'user',
              userId: STORY_USER_ID,
              timestamp: '2026-10-28T00:00:00.000Z',
              items: [{ type: 'text', text: firstUserMessage }],
            }),
          ]
        : shareImage
          ? [...buildShareHistory(), ...sentMessages]
          : showCollaborators
            ? collaborativeMessages()
            : buildHistory(state, streamChunkCount, showCapacityRetry, readingLiveTimestamp),
    [
      firstUserMessage,
      shareImage,
      sentMessages,
      showCapacityRetry,
      showCollaborators,
      state,
      streamChunkCount,
      readingLiveTimestamp,
    ]
  );
  const permissionHistory = history as unknown as SessionDoc['history'];
  const lastReadingAssistant = isReadingState(state)
    ? history.findLast((message) => message.role === 'assistant')?.id
    : undefined;
  const lastCompletedReadingAssistant = isReadingState(state)
    ? history.findLast((message) => message.role === 'assistant' && message.finished)?.id
    : undefined;
  const liveStatus =
    state === 'idle' || state === 'reading'
      ? undefined
      : isWorkingState(state)
        ? ({ type: 'running' } as const)
        : ({ type: 'requestPermission' } as const);
  const shouldShowPermissionSurface = hasPendingPermissionRequest(liveStatus, permissionHistory);
  const translate = (key: string, fallback: string) => String(t(key, fallback));
  const isWorking = isWorkingState(state);
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
      value: machineInfo?.name ?? machineMeta.name,
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
      machineName={machineInfo?.name ?? machineMeta.name}
      onCopyConversationHistory={action}
      onCopyUrl={action}
      sharing={storySharing}
      onShareWithTeam={action}
      onShareAsImage={
        shareImage
          ? () =>
              selection.start(
                collectConversationMessages(
                  history.map((message) => ({ ...message, fileDiff: message.fileDiff ?? [] }))
                ),
                setPreview
              )
          : undefined
      }
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
                embedded
                  ? 'h-full min-h-0 w-full bg-background'
                  : frame === 'mobile' || shareImage
                    ? 'h-dvh w-full bg-background'
                    : 'h-dvh bg-muted/35 p-4 sm:p-6'
              )}
            >
              <div
                className={cn(
                  'overflow-hidden bg-background',
                  embedded || shareImage ? 'h-full w-full' : frameClassName
                )}
                style={
                  frame === 'mobile'
                    ? ({ '--conversation-top-inset': '3rem' } as CSSProperties)
                    : undefined
                }
              >
                <ReadingReviewDiffLayout
                  enabled={isReadingState(state)}
                  frame={frame}
                  session={session}
                  selection={readingPanel}
                  onSelect={setReadingPanel}
                  onClose={closeReadingPanel}
                >
                  <SessionConversationPage
                    className="h-full"
                    dropActive={dropActive}
                    dropKind="session-mention"
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
                          leading={<MobileSessionHeaderBackButton onBack={action} />}
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
                          childSessions={shareImage ? [] : [childSession]}
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
                          <MessageSelectionContext.Provider value={selection.context}>
                            <SessionChatStreamView
                              sessionId={session.id}
                              items={toStreamItems(session.id, history)}
                              renderMessageRow={(row) => renderMessageRow(row, showCollaborators)}
                              onFileDiffClick={isReadingState(state) ? openReadingDiff : undefined}
                              lastAssistantMessageId={lastReadingAssistant}
                              lastCompletedAssistantMessageId={lastCompletedReadingAssistant}
                              className="h-full"
                              agentActivityLabel={
                                isWorking
                                  ? translate('sessions.statusIndicator.thinking', 'Thinking')
                                  : shouldShowPermissionSurface
                                    ? 'Waiting for your response'
                                    : null
                              }
                              agentActivityTone={
                                shouldShowPermissionSurface ? 'warning' : 'primary'
                              }
                            />
                          </MessageSelectionContext.Provider>
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
                              <div hidden={selection.active}>
                                {/* Mirrors the production info bar (cluster + stage)
                              glued above the composer — desktop AND mobile. */}
                                <StoryInfoBar
                                  session={session}
                                  queued={queued}
                                  reading={isReadingState(state)}
                                  onOpenAllChanges={
                                    isReadingState(state) ? openReadingAllChanges : undefined
                                  }
                                  machineOnly={machineOnly}
                                  mobile={frame === 'mobile'}
                                  machine={
                                    machineInfo ?? {
                                      machineId: STORY_MACHINE_ID,
                                      name: machineMeta.name,
                                      isOwn: true,
                                      isCurrent: frame === 'desktop' ? true : undefined,
                                      onlineStatus: 'online',
                                    }
                                  }
                                />
                                <StoryComposer
                                  claimNavigationFocus={claimNavigationFocus}
                                  session={session}
                                  isAgentBusy={isWorking}
                                  modelLabel={composerModelLabel}
                                  initialInputText={
                                    shareImage
                                      ? 'Can we compare the profiler results next?'
                                      : composerText
                                  }
                                  onSendMessage={
                                    shareImage
                                      ? async (blocks) => {
                                          const text = blocks
                                            .filter((block) => block.type === 'text')
                                            .map((block) => block.text)
                                            .join('\n');
                                          if (!text.trim()) return false;
                                          setSentMessages((current) => [
                                            ...current,
                                            buildMessage({
                                              id: `share-sent-${current.length}`,
                                              role: 'user',
                                              userId: STORY_USER_ID,
                                              items: [{ type: 'text', text }],
                                            }),
                                          ]);
                                          return true;
                                        }
                                      : undefined
                                  }
                                />
                              </div>
                              <MessageSelectionToolbar selection={selection} />
                            </>
                          )
                        }
                      />
                    }
                    trailingSlot={
                      shareImage ? (
                        <ChatShareImageDialog
                          open={preview !== null}
                          onOpenChange={(open) => {
                            if (!open) setPreview(null);
                          }}
                          session={session}
                          messages={preview ?? []}
                        />
                      ) : undefined
                    }
                  />
                </ReadingReviewDiffLayout>
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
    return <ForceMobileLayoutProvider force>{children}</ForceMobileLayoutProvider>;
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
    return <ForceMobileLayoutProvider force>{children}</ForceMobileLayoutProvider>;
  }
  return (
    <DesktopViewport>
      <Story />
    </DesktopViewport>
  );
};

const meta = {
  title: 'Sessions/SessionConversationPage',
  component: SessionConversationStoryHarness,
  excludeStories: ['SessionConversationStoryHarness'],
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  args: {
    state: 'idle',
    frame: 'desktop',
  },
} satisfies Meta<typeof SessionConversationStoryHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopIdle: Story = {
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopMachineOnly: Story = {
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
  args: {
    machineOnly: true,
    machineInfo: {
      machineId: STORY_MACHINE_ID,
      name: 'MacBook-Pro.local',
      ownerName: 'Maya Chen',
      isOwn: false,
      isCurrent: false,
      onlineStatus: 'online',
    },
  },
};

export const DesktopMachineDetails: Story = {
  globals: { theme: 'dark', locale: 'en' },
  decorators: [withDesktopViewport],
  args: {
    machineInfo: {
      machineId: STORY_MACHINE_ID,
      name: 'MacBook-Pro.local',
      ownerName: 'Maya Chen',
      isOwn: false,
      isCurrent: false,
      onlineStatus: 'online',
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', {
        name: 'Machine details: MacBook-Pro.local',
      })
    );
  },
};

export const DesktopMachineOffline: Story = {
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
  args: {
    machineInfo: {
      machineId: STORY_MACHINE_ID,
      name: 'Build-Server',
      ownerName: 'Maya Chen',
      isOwn: false,
      isCurrent: false,
      onlineStatus: 'offline',
    },
  },
};

/**
 * Reading review: every conversation reading surface in one finished turn —
 * prose at the default size, GitHub reference labels, wide and narrow tables
 * and diagrams in the 768px column, process rows, the edited-files card and
 * the info bar.
 */
export const DesktopReadingReview: Story = {
  args: { state: 'reading', sessionTitle: '对话页阅读样式审查', branchName: 'fix/reading-comfort' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopReadingReviewLight: Story = {
  args: { state: 'reading', sessionTitle: '对话页阅读样式审查', branchName: 'fix/reading-comfort' },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
};

/**
 * Full-width mode (Settings > Appearance): the conversation column drops its
 * ~48rem cap and spans the pane, keeping only the shared side gutter.
 */
export const DesktopReadingReviewWide: Story = {
  args: {
    state: 'reading',
    sessionTitle: '对话页阅读样式审查',
    branchName: 'fix/reading-comfort',
    wide: true,
  },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopReadingReviewWorking: Story = {
  args: { ...DesktopReadingReview.args, state: 'reading-working' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopReadingReviewAnnotations: Story = {
  args: { ...DesktopReadingReview.args, annotationPreview: true },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopReadingReviewPermission: Story = {
  args: { ...DesktopReadingReview.args, state: 'reading-permission' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopReadingReviewQuestion: Story = {
  args: { ...DesktopReadingReview.args, state: 'reading-question' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const MobileReadingReview: Story = {
  args: { ...DesktopReadingReview.args, frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const MobileReadingReviewWorking: Story = {
  args: { ...DesktopReadingReviewWorking.args, frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const MobileReadingReviewPermission: Story = {
  args: { ...DesktopReadingReviewPermission.args, frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const MobileReadingReviewQuestion: Story = {
  args: { ...DesktopReadingReviewQuestion.args, frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const DesktopMultipleSenders: Story = {
  args: { showCollaborators: true },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
};

export const DesktopSenderProfileCard: Story = {
  args: { showCollaborators: true },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole('button', { name: 'View profile for Maya Chen' })
    );
  },
};

export const DesktopShareImage: Story = {
  args: { shareImage: true },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
};

export const DesktopShareImageDark: Story = {
  args: { shareImage: true },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopSessionMentionDrop: Story = {
  args: { dropActive: true },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

/** Queued turns sit on the info bar as one attached stack. */
export const DesktopQueuedMessages: Story = {
  args: { state: 'working', queued: 'with-info-bar' },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
};

/** With nothing for the info bar to show, the queue sits on the composer. */
export const DesktopQueuedMessagesWithoutInfoBar: Story = {
  args: { state: 'working', queued: 'without-info-bar' },
  globals: { theme: 'light' },
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

/**
 * The whole plan-mode round inside the real page chrome: propose → approve →
 * implement → result. Use this to look at plan geometry rather than the
 * component stories, which show the pieces without the header, tab bar,
 * info bar, and composer around them.
 */
export const DesktopPlanFlow: Story = {
  args: { state: 'plan' },
  globals: { theme: 'dark' },
  decorators: [withDesktopViewport],
};

export const DesktopPlanFlowLight: Story = {
  args: { state: 'plan' },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
};

export const DesktopCapacityRetry: Story = {
  args: { showCapacityRetry: true },
  globals: { theme: 'light' },
  decorators: [withDesktopViewport],
};

export const DesktopCapacityRetryChinese: Story = {
  args: { showCapacityRetry: true },
  globals: { theme: 'light', locale: 'zh_CN' },
  decorators: [withDesktopViewport],
};

export const MobileIdle: Story = {
  args: { frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const MobileMachineOnly: Story = {
  args: { ...DesktopMachineOnly.args, frame: 'mobile' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};

export const MobileMachineDetails: Story = {
  args: { ...DesktopMachineDetails.args, frame: 'mobile' },
  globals: { theme: 'dark', locale: 'en' },
  decorators: [withMobileViewport],
  play: DesktopMachineDetails.play,
};

export const MobileMachineOffline: Story = {
  args: { ...DesktopMachineOffline.args, frame: 'mobile', state: 'working' },
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

export const MobilePlanFlow: Story = {
  args: { frame: 'mobile', state: 'plan' },
  globals: { theme: 'dark' },
  decorators: [withMobileViewport],
};
