'use client';

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { type LandingDemo, WORKTREE_DEMO_DURATION_MS } from './landing-demo-durations';
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  Ellipsis,
  Folder,
  GitMerge,
  Loader2,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Github,
  PanelRight,
  SquareTerminal,
} from 'lucide-react';
import { createInstance } from 'i18next';
import { Provider, createStore } from 'jotai';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { currentWorkspaceIdAtom } from '@/atoms';
import { authTokenAtom, runtimeAtom, type WorkspaceRuntime } from '@/atoms/runtime';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
  type SessionChatUser,
} from '@/components/ai-gui/view';
import { ChatComposer } from '@/components/chat/chat-composer';
import { MobileSessionRunConfig } from '@/components/mobile/mobile-session-run-config';
import { ForceDesktopLayoutProvider } from '@/hooks/use-mobile';
import type { VisualAnnotationReferenceChipItem } from '@/components/chat/visual-annotation-reference-chip';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import type { SessionContextType } from '@/components/chat/context-switch';
import {
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
  type UnifiedProjectSelection,
} from '@/components/chat/unified-project-selector';
import { BranchSelector, getModeIcon } from '@/components/chat/chat-landing-selectors';
import {
  MobileInlinePicker,
  MobileInlinePickerRowSlot,
} from '@/components/mobile/mobile-inline-picker';
import { WorktreeCheckboxPill } from '@/components/shared/workdir-mode-selector';
import { registerBuiltInCommands } from '@/lib/commands';
import { LoroSidebar, type LoroSidebarNavKey } from '@/components/loro-sidebar';
import { BaseHeader } from '@/components/page-headers/base-header';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { MobileSessionTabButton } from '@/components/mobile/mobile-session-tab-sheet';
import {
  type MobileConversationItem,
  type MobileHomeGitHubRepository,
  type MobileHomeLocalProject,
  type MobileHomeMachine,
  type MobileHomeScreenLabels,
} from '@/components/mobile/mobile-home-screen';
import {
  FloatingPermissionRequest,
  hasPendingAskUserQuestion,
} from '@/components/sessions/floating-permission-request';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import { SessionChangesSidebar } from '@/components/sessions/session-changes-sidebar';
import type { SessionDiffChangeEntry } from '@/components/sessions/session-diff-summary';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import {
  SessionSidePanelTabBar,
  type SessionSidePanelTabItem,
} from '@/components/sessions/session-side-panel-tab-bar';
import { SessionInfoBar } from '@/components/sessions/session-info-bar';
import { ConversationColumn } from '@/components/shared/conversation-column';
import {
  DesktopMachineMenu,
  DesktopPermissionModeButton,
  DesktopRunConfigMenu,
} from '@/components/sessions/desktop-run-config-menu';
import { agentConfigMetaCacheAtom } from '@/atoms/doc-meta';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
import type { AcpSessionSelectOption } from '@/components/shared/acp-session-select';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';
import type { OptionSelectorOption } from '@/components/shared/option-selector';
import {
  SessionList,
  type SessionListProps,
  type SessionListRepoMove,
  type SessionListRepoState,
  type SessionListRow,
} from '@/components/session-list';
import { Button } from '@/ui/button';
import { TooltipProvider } from '@/ui/tooltip';
import {
  CODEX_COLLABORATION_MODE_CONFIG_ID,
  CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
  CODEX_COLLABORATION_MODE_PLAN_VALUE,
  CODEX_FAST_MODE_CONFIG_ID,
} from '@/components/shared/acp-selector-options';
import type {
  AgentConfigMeta,
  MachineId,
  MachineViewMeta,
  PrStatus,
  SessionHistoryParsed,
  SessionId,
  SessionMeta,
  SessionStatus,
  VisualAnnotationReferencePayload,
  WorkspaceId,
} from '@lody/shared';

import { landingPreviewMachinesAtom } from './app-preview-shims/use-online-machines-shim';
import type { LandingLocale } from './landing';
import {
  INITIAL_LANDING_PREVIEW_STATE,
  LandingPreviewPanel,
  type LandingPreviewDemoState,
} from './landing-preview-panel';
import { LandingMobilePreview, type MobileDemoScreen } from './landing-mobile-preview';

const demoI18n = createInstance();

void demoI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  defaultNS: 'translation',
  ns: ['translation'],
  // Only keys the real components render via `t()` need entries here. The "Chats"
  // sidebar group header (SessionList → t('sessions.chats')) is the one such label.
  resources: {
    en: {
      translation: {
        'sessions.chats': 'Chats',
        'composer.promptPlaceholder.base': 'Message the agent...',
        'chat.fastModeTooltip': 'Use Codex fast mode',
        'sessions.askQuestion.answered': 'Answered',
        'sessions.askQuestion.next': 'Next',
        'sessions.askQuestion.prev': 'Prev',
        'sessions.customAnswerPlaceholder': 'Type a custom answer...',
        'sessions.toolActivity.editedFiles_one': 'Edited {{count}} file',
        'sessions.toolActivity.editedFiles_other': 'Edited {{count}} files',
      },
    },
    zh_CN: {
      translation: {
        'sessions.chats': '对话',
        'composer.promptPlaceholder.base': '给 Agent 发消息...',
        'chat.fastModeTooltip': '使用 Codex 快速模式',
        'sessions.askQuestion.answered': '已回答',
        'sessions.askQuestion.next': '下一题',
        'sessions.askQuestion.prev': '上一题',
        'sessions.customAnswerPlaceholder': '输入自定义答案...',
        'sessions.changes.title': '变更',
        'sessions.changes.view.types': '类型',
        'sessions.changes.view.files': '文件',
        'sessions.changes.loading': '正在加载变更…',
        'sessions.changes.syncing': '正在同步变更…',
        'sessions.changes.empty': '暂无变更。',
        'sessions.changes.category.code': '代码',
        'sessions.changes.category.doc': '文档',
        'sessions.changes.category.test': '测试',
        'sessions.changes.category.dev': '开发',
        'chat.workdir.local': '本地',
        'chat.workdir.worktree': 'Worktree',
        'chat.workdir.localDescription': '直接使用本地项目目录。',
        'chat.workdir.worktreeDescription': '为本次会话创建独立的 git worktree。',
        'sessions.toolActivity.editedFiles_one': '编辑了 {{count}} 个文件',
        'sessions.toolActivity.editedFiles_other': '编辑了 {{count}} 个文件',
        'chat.projectPicker.placeholder': '选择项目',
        'chat.projectPicker.searchPlaceholder': '搜索项目',
        'chat.projectPicker.clear': '不在项目中工作',
        'chat.projectPicker.emptyText': '没有找到项目',
        'chat.contextSwitch.addProject': '添加文件夹',
        'repos.connectMore': '连接更多 GitHub 项目',
      },
    },
  },
  keySeparator: false,
  interpolation: {
    escapeValue: false,
  },
  initImmediate: false,
  react: {
    useSuspense: false,
  },
});

const now = Date.now();

/* Workspace avatar for the sidebar / mobile-home workspace switcher. Without a
   logo `WorkspaceAvatar` falls back to the bare "L" initial, which reads as an
   unconfigured workspace; the demo workspace IS Lody, so it wears the mark. */
const WORKSPACE_LOGO = '/landing/icon-transparent.png';

/* Heavy images the LATER feature tabs need. The mobile tab is ~50s into the
   carousel but its 427KB device frame only started downloading when that tab
   mounted, so the phone materialised piece by piece in front of the viewer.
   Warm them from the preview's mount instead — but on IDLE time, so the 1.2MB
   never competes with the WebGL scene's first paint. */
const DEMO_IMAGE_WARMUP = [
  '/landing/iphone-17-pro-silver.png',
  '/landing/jellyfish.webp',
  WORKSPACE_LOGO,
];

function warmDemoImages(): () => void {
  const images: HTMLImageElement[] = [];
  const run = () => {
    for (const src of DEMO_IMAGE_WARMUP) {
      const image = new Image();
      // `decode()` also pays the decode cost up front, so the first paint of the
      // device frame is a straight blit. Failures are irrelevant — the <img> in
      // the tab still requests normally.
      image.src = src;
      void image.decode?.().catch(() => undefined);
      images.push(image);
    }
  };
  // Safari only shipped requestIdleCallback recently; fall back to a timeout.
  const hasIdle = typeof window.requestIdleCallback === 'function';
  const handle = hasIdle
    ? window.requestIdleCallback(run, { timeout: 4000 })
    : window.setTimeout(run, 1200);
  return () => {
    if (hasIdle) window.cancelIdleCallback(handle);
    else window.clearTimeout(handle);
    for (const image of images) image.src = '';
  };
}

type LabelDesc = readonly [label: string, description: string];
type PreviewProvider = 'codex' | 'claude';

const CLAUDE_PREVIEW_MODEL_INFO: NonNullable<SessionHistoryParsed['modelInfo']> = {
  name: 'Opus',
  modelId: 'opus',
  _meta: { lodyThoughtLevel: 'xhigh' },
};

const CODEX_PREVIEW_MODEL_INFO: NonNullable<SessionHistoryParsed['modelInfo']> = {
  name: '5.5',
  modelId: 'gpt-5.5',
  _meta: { lodyThoughtLevel: 'xhigh' },
};

function previewUserMessage(
  id: string,
  text: string,
  timestamp: string,
  status: string = 'handled'
): SessionHistoryParsed {
  return {
    id,
    role: 'user',
    timestamp,
    read: true,
    userId: 'preview-user',
    status,
    finished: true,
    items: [{ type: 'text', text }],
  } as SessionHistoryParsed;
}

function previewAssistantMessage(
  id: string,
  items: SessionHistoryParsed['items'],
  timestamp: string,
  options?: {
    modelInfo?: SessionHistoryParsed['modelInfo'];
    finished?: boolean;
  }
): SessionHistoryParsed {
  return {
    id,
    role: 'assistant',
    timestamp,
    read: true,
    userId: undefined,
    modelInfo: options?.modelInfo ?? CLAUDE_PREVIEW_MODEL_INFO,
    finished: options?.finished ?? true,
    items,
  } as SessionHistoryParsed;
}

function previewToolCall(
  kind: string,
  title: string,
  toolCallId: string,
  content?: unknown,
  status: 'pending' | 'in_progress' | 'completed' | 'failed' = 'completed',
  permissionRequest?: NonNullable<
    Extract<SessionHistoryParsed['items'][number], { type: 'tool_call' }>['permissionRequest']
  >
): SessionHistoryParsed['items'][number] {
  return {
    type: 'tool_call',
    kind,
    title,
    status,
    toolCallId,
    locations: undefined,
    content,
    permissionRequest,
  } as unknown as SessionHistoryParsed['items'][number];
}

function previewFontSizeScopeQuestion(
  locale: LandingLocale
): SessionHistoryParsed['items'][number] {
  const isZh = locale === 'zh';
  const questions = isZh
    ? [
        {
          id: 'scope',
          question: '字号配置应该影响对话里的哪些文本？',
          header: '范围',
          options: [
            {
              label: '正文内容 (Recommended)',
              description:
                '只调整用户消息、助手回复和 Markdown 正文，工具栏与结构化控件保持默认密度。',
            },
            {
              label: '整个对话区',
              description: '同时影响正文、工具输出、terminal、thinking block 和计划卡片。',
            },
            {
              label: '仅 Markdown',
              description: '只影响 MarkdownRenderer 渲染出来的正文。',
            },
          ],
          is_other: true,
        },
        {
          id: 'control',
          question: '字号配置应该使用哪种控制方式？',
          header: '控制',
          options: [
            {
              label: '离散档位 (Recommended)',
              description:
                'Small / Default / Large / Extra Large，便于 Tailwind class 和虚拟列表测量。',
            },
            {
              label: '连续滑杆',
              description: '更灵活，但更容易产生不稳定的行高和样式边界。',
            },
          ],
          is_other: true,
        },
      ]
    : [
        {
          id: 'scope',
          question: 'Which conversation text should the font-size setting affect?',
          header: 'Scope',
          options: [
            {
              label: 'Message body (Recommended)',
              description:
                'Adjust user messages, assistant replies, and Markdown body text while keeping chrome and controls at the default density.',
            },
            {
              label: 'Entire conversation area',
              description:
                'Also affect tool output, terminal output, thinking blocks, and plan cards.',
            },
            {
              label: 'Markdown only',
              description: 'Only affect content rendered through MarkdownRenderer.',
            },
          ],
          is_other: true,
        },
        {
          id: 'control',
          question: 'How should users choose the font size?',
          header: 'Control',
          options: [
            {
              label: 'Discrete sizes (Recommended)',
              description:
                'Small / Default / Large / Extra Large, easier to keep stable with Tailwind classes and virtual-list measurement.',
            },
            {
              label: 'Continuous slider',
              description:
                'More flexible, but more likely to create unstable row heights and styling edge cases.',
            },
          ],
          is_other: true,
        },
      ];
  return previewToolCall(
    'think',
    isZh
      ? '字号配置应该影响对话里的哪些文本？'
      : 'Which conversation text should the font-size setting affect?',
    'font-size-plan-ask-user-question',
    undefined,
    'in_progress',
    {
      requestId: 'font-size-plan-question',
      options: [
        { optionId: 'answer', name: isZh ? '提交答案' : 'Submit answers', kind: 'allow_once' },
        { optionId: 'cancel', name: isZh ? '取消' : 'Cancel', kind: 'reject_once' },
      ],
      _meta: {
        codex: {
          requestUserInput: {
            questions,
          },
        },
      },
    }
  );
}

function buildLodyPrHistory(locale: LandingLocale): SessionHistoryParsed[] {
  const isZh = locale === 'zh';
  const t1 = '2026-06-21T09:07:13.599Z';
  const t2 = '2026-06-21T09:11:44.000Z';
  const t3 = '2026-06-21T09:18:20.000Z';
  const t4 = '2026-06-21T09:22:40.000Z';
  const t5 = '2026-06-21T09:25:10.000Z';

  return [
    previewUserMessage(
      'lody-pr-user-investigate',
      isZh
        ? '选中对话或者项目的时候，高亮背景两边会被裁剪一点点。你研究一下是不是容器应该大一点？'
        : 'When a conversation or project is selected, the highlighted background is clipped slightly on both sides. Can you investigate whether the container needs more room?',
      t1
    ),
    previewAssistantMessage(
      'lody-pr-assistant-fix',
      [
        {
          type: 'text',
          text: isZh
            ? '我先定位侧边栏的渲染入口和选中态样式，再用一个最小复现验证是不是容器裁剪导致的。'
            : 'I will trace the sidebar rendering path and selected-state styling, then verify whether container clipping is the actual cause with a minimal repro.',
        },
        previewToolCall(
          'read',
          isZh ? '读取 context/hotspots.md' : 'Read context/hotspots.md',
          'landing-lody-pr-read-hotspots'
        ),
        previewToolCall(
          'read',
          isZh
            ? '读取 packages/components/src/components/loro-sidebar.tsx'
            : 'Read packages/components/src/components/loro-sidebar.tsx',
          'landing-lody-pr-read-sidebar'
        ),
        previewToolCall(
          'execute',
          isZh ? '复现 Radix ScrollArea 裁剪' : 'Reproduce Radix ScrollArea clipping',
          'landing-lody-pr-repro',
          [
            {
              type: 'text',
              text: isZh
                ? '当前结构会裁掉左右 outline；把横向 gutter 放到 viewport 后四边完整。'
                : 'The current structure clips the left and right outline; moving the horizontal gutter to the viewport renders all four sides cleanly.',
            },
          ]
        ),
        {
          type: 'text',
          text: isZh
            ? [
                '确认根因：选中态的 `outline` 画在盒子外侧，但横向留白在 `ScrollArea` root 上，内部 Radix viewport 是真正的裁剪边界，所以左右 1px 被削掉。',
                '',
                '修法是把横向 gutter 移到 viewport：列表行仍保持相同位置，滚动条位置不变，但 outline 有空间完整绘制。',
              ].join('\n')
            : [
                'Root cause confirmed: the selected-state `outline` is painted outside the row box, while the horizontal gutter lived on the `ScrollArea` root. The inner Radix viewport is the actual clipping boundary, so the left and right 1px outline was shaved off.',
                '',
                'The fix is to move the horizontal gutter to the viewport: rows keep the same visual position, the scrollbar position is unchanged, and the outline has room to render fully.',
              ].join('\n'),
        },
        previewToolCall(
          'edit',
          isZh
            ? '修改 packages/components/src/components/loro-sidebar.tsx'
            : 'Edit packages/components/src/components/loro-sidebar.tsx',
          'landing-lody-pr-edit-sidebar'
        ),
        {
          type: 'text',
          text: isZh
            ? '已经修好。这个改动覆盖聊天/PR 行、本地项目 session、本地项目文件夹和 Updated 模式行，因为它们都在同一个 sidebar ScrollArea 里。'
            : 'Fixed. This covers chat/PR rows, local project sessions, local project folders, and updated-mode rows because they all render inside the same sidebar ScrollArea.',
        },
      ],
      t2
    ),
    previewUserMessage(
      'lody-pr-user-create-pr',
      isZh ? '为当前分支创建 PR。' : 'Create a PR for the current branch.',
      t3
    ),
    previewAssistantMessage(
      'lody-pr-assistant-create-pr',
      [
        {
          type: 'text',
          text: isZh
            ? '我会检查当前分支和 diff，提交这个修复，然后推送并创建 PR。'
            : 'I will check the current branch and diff, commit this fix, then push and create the PR.',
        },
        previewToolCall(
          'execute',
          isZh ? '检查 git 状态和 diff' : 'Check git status and diff',
          'landing-lody-pr-git-status'
        ),
        previewToolCall(
          'execute',
          isZh
            ? '提交 fix: stop sidebar selection outline being clipped on the sides'
            : 'Commit fix: stop sidebar selection outline being clipped on the sides',
          'landing-lody-pr-commit'
        ),
        previewToolCall(
          'execute',
          isZh
            ? '推送 feat/selection-highlight-clipping'
            : 'Push feat/selection-highlight-clipping',
          'landing-lody-pr-push'
        ),
        previewToolCall(
          'execute',
          isZh ? '创建 GitHub PR #2564' : 'Create GitHub PR #2564',
          'landing-lody-pr-create-pr'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                'PR 已创建：**https://github.com/loro-dev/lody/pull/2564**',
                '',
                '- 分支：`feat/selection-highlight-clipping` -> `main`',
                '- 提交：`fix: stop sidebar selection outline being clipped on the sides`',
                '- 改动：只修改 `loro-sidebar.tsx`，把横向 gutter 移到 viewport，避免选中高亮左右被裁剪。',
              ].join('\n')
            : [
                'PR created: **https://github.com/loro-dev/lody/pull/2564**',
                '',
                '- Branch: `feat/selection-highlight-clipping` -> `main`',
                '- Commit: `fix: stop sidebar selection outline being clipped on the sides`',
                '- Change: only `loro-sidebar.tsx`, moving the horizontal gutter to the viewport so selected highlights are not clipped on the sides.',
              ].join('\n'),
        },
      ],
      t4
    ),
    previewAssistantMessage(
      'lody-pr-assistant-upstream',
      [
        {
          type: 'text',
          text: isZh
            ? [
                '远端状态也确认好了。提交 `119f8827` 已在 `origin/feat/selection-highlight-clipping` 上，PR #2564 就是基于这个提交创建的。',
                '',
                '之前看起来像没 push，是因为本地分支还在跟踪 `origin/main`。我已经把 upstream 设置到正确的远端分支，`git status` 现在显示本地和远端一致。',
                '',
                '没有剩余内容需要 push。',
              ].join('\n')
            : [
                'Remote state is confirmed. Commit `119f8827` is on `origin/feat/selection-highlight-clipping`, and PR #2564 was created from that commit.',
                '',
                'It only looked unpushed because the local branch was still tracking `origin/main`. I set the upstream to the correct remote branch, and `git status` now shows the branch is even with the remote.',
                '',
                'Nothing left to push.',
              ].join('\n'),
        },
      ],
      t5
    ),
  ];
}

function buildFontSizePlanHistory(locale: LandingLocale): SessionHistoryParsed[] {
  const isZh = locale === 'zh';
  const t1 = '2026-06-21T10:42:18.000Z';
  const t2 = '2026-06-21T10:46:52.000Z';

  return [
    previewUserMessage(
      'font-size-plan-user',
      isZh
        ? '怎么增加对话中字体大小的配置，给我一份计划'
        : 'How should we add a configurable font size for conversation messages? Give me a plan.',
      t1
    ),
    previewAssistantMessage(
      'font-size-plan-assistant',
      [
        {
          type: 'text',
          text: isZh
            ? '我会先定位对话 UI、设置持久化和字体样式入口，确认现有架构后再给计划；当前只做只读探索，不改文件。'
            : 'I will first locate the conversation UI, settings persistence, and font styling entry points, then give a plan after confirming the current architecture. This pass is read-only.',
        },
        previewToolCall(
          'read',
          isZh ? '读取 AGENTS.md 和 context/hotspots.md' : 'Read AGENTS.md and context/hotspots.md',
          'font-size-plan-read-context'
        ),
        previewToolCall(
          'search',
          isZh
            ? '搜索对话渲染、字号样式和设置偏好入口'
            : 'Search chat rendering, font styling, and settings preference entry points',
          'font-size-plan-search-entrypoints'
        ),
        {
          type: 'text',
          text: isZh
            ? '现有偏好基本用 Jotai `atomWithStorage` 存在 `packages/components/src/atoms/settings.ts`，所以字号配置适合做客户端本地偏好，不需要改后端 schema。'
            : 'Existing preferences are mostly stored with Jotai `atomWithStorage` in `packages/components/src/atoms/settings.ts`, so the font-size setting fits as a local client preference without a backend schema change.',
        },
        previewToolCall(
          'read',
          isZh
            ? '读取 packages/components/src/atoms/settings.ts'
            : 'Read packages/components/src/atoms/settings.ts',
          'font-size-plan-read-settings'
        ),
        previewToolCall(
          'read',
          isZh
            ? '读取 packages/components/src/components/ai-gui/view.tsx'
            : 'Read packages/components/src/components/ai-gui/view.tsx',
          'font-size-plan-read-ai-gui'
        ),
        {
          type: 'text',
          text: isZh
            ? '`ai-gui/view.tsx` 使用虚拟列表渲染消息；字号变化会影响行高测量，所以计划里要包含重新测量或重挂载消息列表，避免行高缓存导致内容重叠。'
            : '`ai-gui/view.tsx` renders messages with a virtual list. Font-size changes affect row measurement, so the plan must include remeasuring or remounting the message list to avoid stale-height overlap.',
        },
        previewToolCall(
          'read',
          isZh ? '读取桌面和移动设置入口' : 'Read desktop and mobile settings entry points',
          'font-size-plan-read-settings-ui'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                '计划已经收敛到 3 个落点：',
                '',
                '- 偏好状态：在 `packages/components/src/atoms/settings.ts` 增加 `chatFontSize` 档位，建议用 Small / Default / Large / Extra Large 这类离散值。',
                '- 设置入口：桌面 `general-setting.tsx` 和移动 `mobile-general-settings.tsx` 都接入同一组 i18n 文案和选项。',
                '- 渲染入口：从会话流把字号传到 Markdown、普通用户文本和工具内容；字号变化时触发虚拟列表重新测量。',
                '',
                '还需要你确认一个产品选择：字号配置应该只影响消息正文，还是同时影响工具输出、terminal 和 thinking block？',
              ].join('\n')
            : [
                'The plan narrows to 3 implementation points:',
                '',
                '- Preference state: add a `chatFontSize` setting in `packages/components/src/atoms/settings.ts`, preferably as discrete Small / Default / Large / Extra Large values.',
                '- Settings entry points: wire the same i18n labels and options into desktop `general-setting.tsx` and mobile `mobile-general-settings.tsx`.',
                '- Rendering entry point: pass the size from the session stream into Markdown, plain user text, and tool content; trigger virtual-list remeasurement when it changes.',
                '',
                'One product choice still needs confirmation: should the font-size setting affect only message body text, or should it also affect tool output, terminal output, and thinking blocks?',
              ].join('\n'),
        },
        previewFontSizeScopeQuestion(locale),
      ],
      t2,
      { modelInfo: CODEX_PREVIEW_MODEL_INFO, finished: false }
    ),
  ];
}

function buildLodyFeedbackHistory(locale: LandingLocale): SessionHistoryParsed[] {
  const isZh = locale === 'zh';
  const t1 = '2026-06-21T11:18:12.000Z';
  const t2 = '2026-06-21T11:29:46.000Z';
  const t3 = '2026-06-21T11:36:08.000Z';
  const t4 = '2026-06-21T11:42:30.000Z';
  const t5 = '2026-06-21T11:49:54.000Z';
  const t6 = '2026-06-21T11:57:18.000Z';
  const modelInfo = CODEX_PREVIEW_MODEL_INFO;

  return [
    previewUserMessage(
      'lody-feedback-user-bug',
      isZh
        ? 'roadmap 的更新时间都是一样的？研究一下这个 bug 并修复'
        : 'The roadmap update times are all the same. Investigate this bug and fix it.',
      t1
    ),
    previewAssistantMessage(
      'lody-feedback-assistant-fix',
      [
        {
          type: 'text',
          text: isZh
            ? '我会先定位 roadmap 数据来源、更新时间渲染和所有写入 `updatedAt` 的路径，再直接修复并跑检查。'
            : 'I will trace the roadmap data source, updated-time rendering, and every path that writes `updatedAt`, then fix it and run checks.',
        },
        previewToolCall(
          'search',
          isZh
            ? '搜索 roadmap updatedAt 写入和渲染路径'
            : 'Search roadmap updatedAt write and render paths',
          'lody-feedback-search-roadmap'
        ),
        previewToolCall(
          'read',
          isZh ? '读取 src/server/services/admin.ts' : 'Read src/server/services/admin.ts',
          'lody-feedback-read-admin'
        ),
        previewToolCall(
          'read',
          isZh ? '读取 src/features/admin/api.ts' : 'Read src/features/admin/api.ts',
          'lody-feedback-read-api'
        ),
        {
          type: 'text',
          text: isZh
            ? '根因确认：拖拽重排会把所有 roadmap item 的 `updatedAt` 一次性写成同一个 `Date.now()`，前端乐观更新也做了同样的事，所以重排后所有卡片更新时间会同步变成一样。'
            : 'Root cause confirmed: drag reorder wrote the same `Date.now()` into every roadmap item, and the optimistic frontend update did the same, so all cards showed the same updated time after a reorder.',
        },
        previewToolCall(
          'edit',
          isZh ? '修改 roadmap 重排更新时间语义' : 'Edit roadmap reorder timestamp semantics',
          'lody-feedback-edit-reorder'
        ),
        previewToolCall('execute', isZh ? '运行 pnpm lint' : 'Run pnpm lint', 'lody-feedback-lint'),
        previewToolCall(
          'execute',
          isZh ? '运行 pnpm exec tsc --noEmit' : 'Run pnpm exec tsc --noEmit',
          'lody-feedback-tsc'
        ),
        previewToolCall(
          'execute',
          isZh ? '运行 pnpm build' : 'Run pnpm build',
          'lody-feedback-build'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                '已修复第一版：',
                '',
                '- `src/server/services/admin.ts`：重排只改 `sortOrder`；只有跨状态列移动时才刷新 `updatedAt`。',
                '- `src/features/admin/api.ts`：乐观更新同步改为只在状态变化时更新本地 `updatedAt`。',
                '',
                '验证已通过：`pnpm lint`、`pnpm exec tsc --noEmit`、`pnpm build`。',
              ].join('\n')
            : [
                'First fix completed:',
                '',
                '- `src/server/services/admin.ts`: reorder now only changes `sortOrder`; `updatedAt` changes only when an item moves across status columns.',
                '- `src/features/admin/api.ts`: the optimistic update now mirrors that behavior and only changes local `updatedAt` on status changes.',
                '',
                'Checks passed: `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm build`.',
              ].join('\n'),
        },
      ],
      t2,
      { modelInfo }
    ),
    previewUserMessage(
      'lody-feedback-user-pr',
      isZh ? '为当前分支创建一个 PR。' : 'Create a PR for the current branch.',
      t3
    ),
    previewAssistantMessage(
      'lody-feedback-assistant-pr',
      [
        {
          type: 'text',
          text: isZh
            ? '我会确认当前改动范围和分支状态，提交 roadmap 更新时间修复，然后推送并创建 PR。'
            : 'I will confirm the current diff and branch state, commit the roadmap timestamp fix, then push and create a PR.',
        },
        previewToolCall(
          'execute',
          isZh ? '检查 git 状态和 diff' : 'Check git status and diff',
          'lody-feedback-pr-status'
        ),
        previewToolCall(
          'execute',
          isZh ? '提交 fix roadmap updated timestamps' : 'Commit fix roadmap updated timestamps',
          'lody-feedback-pr-commit'
        ),
        previewToolCall(
          'execute',
          isZh ? '推送 codex/fix-roadmap-updated-at' : 'Push codex/fix-roadmap-updated-at',
          'lody-feedback-pr-push'
        ),
        previewToolCall(
          'execute',
          isZh ? '创建 GitHub draft PR #64' : 'Create GitHub draft PR #64',
          'lody-feedback-pr-create'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                '已创建 draft PR：**https://github.com/loro-dev/lody-feedback/pull/64**',
                '',
                '- 分支：`codex/fix-roadmap-updated-at`',
                '- 提交：`7a830ad fix roadmap updated timestamps`',
                '- 验证：`pnpm lint`、`pnpm exec tsc --noEmit`、`pnpm build` 都已通过。',
              ].join('\n')
            : [
                'Draft PR created: **https://github.com/loro-dev/lody-feedback/pull/64**',
                '',
                '- Branch: `codex/fix-roadmap-updated-at`',
                '- Commit: `7a830ad fix roadmap updated timestamps`',
                '- Verification: `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm build` all passed.',
              ].join('\n'),
        },
      ],
      t4,
      { modelInfo }
    ),
    previewUserMessage(
      'lody-feedback-user-semantics',
      isZh
        ? '这个 updateAt 的语义希望是这个 issue 自身的，而不是 roadmap 的上面的，移动列也是更新了这个 issue 自身的 updateAt'
        : "The `updatedAt` semantics should come from the issue itself, not the roadmap item. Moving columns should update the issue's own `updatedAt` too.",
      t5
    ),
    previewAssistantMessage(
      'lody-feedback-assistant-semantics',
      [
        {
          type: 'text',
          text: isZh
            ? '我会按这个语义调整：roadmap 卡片展示关联 issue/post 自身的 `feedbackPosts.updatedAt`；跨列移动更新 issue 自身的 `updatedAt`，纯排序不改。'
            : "I will adjust the semantics: roadmap cards should display the linked issue/post's own `feedbackPosts.updatedAt`; moving across columns updates the issue's `updatedAt`, while pure ordering does not.",
        },
        previewToolCall(
          'read',
          isZh ? '确认 listRoadmapItems 映射' : 'Inspect listRoadmapItems mapping',
          'lody-feedback-semantics-read-list'
        ),
        previewToolCall(
          'edit',
          isZh ? '改为使用 feedback_posts.updated_at' : 'Switch to feedback_posts.updated_at',
          'lody-feedback-semantics-edit'
        ),
        previewToolCall(
          'execute',
          isZh ? '运行 pnpm lint' : 'Run pnpm lint',
          'lody-feedback-semantics-lint'
        ),
        previewToolCall(
          'execute',
          isZh ? '运行 pnpm exec tsc --noEmit' : 'Run pnpm exec tsc --noEmit',
          'lody-feedback-semantics-tsc'
        ),
        previewToolCall(
          'execute',
          isZh ? '运行 pnpm build' : 'Run pnpm build',
          'lody-feedback-semantics-build'
        ),
        previewToolCall(
          'execute',
          isZh ? '追加提交并推送到 PR 分支' : 'Amend with a new commit and push to the PR branch',
          'lody-feedback-semantics-push'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                '已按这个语义修正并推送到同一个 PR：**https://github.com/loro-dev/lody-feedback/pull/64**',
                '',
                '现在 roadmap 卡片的 `updatedAt` 来自关联 issue/post 的 `feedback_posts.updated_at`，不是 `roadmap_items.updated_at`。跨列移动会更新 issue 自身的 `updatedAt`；纯排序不会更新。',
                '',
                '追加提交：`3650547 use issue updated time for roadmap`。验证仍然通过：`pnpm lint`、`pnpm exec tsc --noEmit`、`pnpm build`。',
              ].join('\n')
            : [
                'Adjusted the semantics and pushed to the same PR: **https://github.com/loro-dev/lody-feedback/pull/64**',
                '',
                'Roadmap card `updatedAt` now comes from the linked issue/post `feedback_posts.updated_at`, not `roadmap_items.updated_at`. Moving across columns updates the issue itself; pure sorting does not.',
                '',
                'Follow-up commit: `3650547 use issue updated time for roadmap`. Checks still pass: `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm build`.',
              ].join('\n'),
        },
      ],
      t6,
      { modelInfo }
    ),
  ];
}

function buildMobileAcpKeyboardHistory(locale: LandingLocale): SessionHistoryParsed[] {
  const isZh = locale === 'zh';
  const t1 = '2026-06-21T08:36:20.000Z';
  const t2 = '2026-06-21T09:14:52.000Z';
  const modelInfo = CODEX_PREVIEW_MODEL_INFO;

  return [
    previewUserMessage(
      'mobile-acp-keyboard-user',
      isZh
        ? '移动端编辑 ACP provider 时候，自定义 prompt 和环境变量需要对输入法键盘进行优化。需要被键盘顶起。完成后创建 pr'
        : 'When editing an ACP provider on mobile, the custom prompt and environment variables need keyboard handling. They should lift above the input keyboard. Create a PR after finishing.',
      t1
    ),
    previewAssistantMessage(
      'mobile-acp-keyboard-assistant',
      [
        {
          type: 'text',
          text: isZh
            ? '我会先读取移动端键盘相关规则并定位 ACP provider 编辑界面，然后实现键盘避让、做移动视口验证，最后创建 PR。'
            : 'I will first read the mobile keyboard rules and locate the ACP provider editor, then implement keyboard avoidance, verify it in a mobile viewport, and create a PR.',
        },
        previewToolCall(
          'read',
          isZh ? '读取 context/mobile-keyboard.md' : 'Read context/mobile-keyboard.md',
          'mobile-acp-keyboard-read-mobile-keyboard'
        ),
        previewToolCall(
          'search',
          isZh
            ? '搜索 ACP provider custom prompt / env 表单'
            : 'Search ACP provider custom prompt / env form',
          'mobile-acp-keyboard-search-provider-form'
        ),
        previewToolCall(
          'read',
          isZh
            ? '读取 packages/components/src/components/settings/agent-config-dialog.tsx'
            : 'Read packages/components/src/components/settings/agent-config-dialog.tsx',
          'mobile-acp-keyboard-read-dialog'
        ),
        previewToolCall(
          'read',
          isZh
            ? '读取 packages/components/src/hooks/use-keyboard-aware-scroll-into-view.ts'
            : 'Read packages/components/src/hooks/use-keyboard-aware-scroll-into-view.ts',
          'mobile-acp-keyboard-read-hook'
        ),
        {
          type: 'text',
          text: isZh
            ? '定位结果：移动端 `AgentConfigDialog` 是全屏 Radix dialog，不在主布局里；iOS 键盘覆盖时需要自己按 `--native-keyboard-height` 缩短高度，并让内部表单滚动容器把 textarea 滚到可见区域。'
            : 'Finding: mobile `AgentConfigDialog` is a full-screen Radix dialog outside the main layout; when the iOS keyboard overlays the screen, the dialog must shrink by `--native-keyboard-height` and its internal form scroller must keep textareas visible.',
        },
        previewToolCall(
          'edit',
          isZh
            ? '修改 AgentConfigDialog 键盘避让布局'
            : 'Edit AgentConfigDialog keyboard avoidance layout',
          'mobile-acp-keyboard-edit-dialog'
        ),
        previewToolCall(
          'edit',
          isZh
            ? '修改 useKeyboardAwareScrollIntoView 容器滚动逻辑'
            : 'Edit useKeyboardAwareScrollIntoView container scrolling',
          'mobile-acp-keyboard-edit-hook'
        ),
        previewToolCall(
          'edit',
          isZh ? '更新 packages/components/AGENTS.md' : 'Update packages/components/AGENTS.md',
          'mobile-acp-keyboard-edit-agents'
        ),
        previewToolCall(
          'execute',
          isZh ? '运行 corepack pnpm check' : 'Run corepack pnpm check',
          'mobile-acp-keyboard-check'
        ),
        previewToolCall(
          'execute',
          isZh
            ? '运行 corepack pnpm --filter @lody/components typecheck'
            : 'Run corepack pnpm --filter @lody/components typecheck',
          'mobile-acp-keyboard-typecheck'
        ),
        previewToolCall(
          'execute',
          isZh
            ? 'Storybook MobileEdit + Playwright 模拟 320px 键盘'
            : 'Storybook MobileEdit + Playwright with a simulated 320px keyboard',
          'mobile-acp-keyboard-storybook'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                'Storybook 几何验证通过：dialog 底部停在键盘上方，footer 不重叠键盘，env textarea 完整落在滚动容器可见区域内。',
                '',
                '我还加了 `transition-none`，避免键盘高度变化时 dialog 高度过渡导致滚动测量拿到旧布局。',
              ].join('\n')
            : [
                'Storybook geometry verification passed: the dialog bottom stops above the keyboard, the footer does not overlap it, and the env textarea stays fully visible inside the scroller.',
                '',
                'I also added `transition-none` so keyboard-height changes do not animate the dialog height and break scroll measurement.',
              ].join('\n'),
        },
        previewToolCall(
          'execute',
          isZh
            ? '提交 fix mobile ACP provider keyboard'
            : 'Commit fix mobile ACP provider keyboard',
          'mobile-acp-keyboard-commit'
        ),
        previewToolCall(
          'execute',
          isZh ? '推送 fix/mobile-acp-provider-keyboard' : 'Push fix/mobile-acp-provider-keyboard',
          'mobile-acp-keyboard-push'
        ),
        previewToolCall(
          'execute',
          isZh ? '创建 GitHub PR #2520' : 'Create GitHub PR #2520',
          'mobile-acp-keyboard-create-pr'
        ),
        {
          type: 'text',
          text: isZh
            ? [
                '完成，PR 已创建：**https://github.com/loro-dev/lody/pull/2520**',
                '',
                '改动要点：',
                '- 移动端 `AgentConfigDialog` 按 `--native-keyboard-height` 缩短高度，底部停在键盘上方。',
                '- 自定义 prompt / env 表单滚动区接入 keyboard-aware scroll。',
                '- 修正共享 hook：直接滚动传入的容器，避免 textarea 被固定 footer 裁掉。',
                '- 把 ACP provider 配置入口补到 `packages/components/AGENTS.md`，后续定位更快。',
                '',
                '验证已跑：`corepack pnpm install`、`corepack pnpm check`、`corepack pnpm --filter @lody/components typecheck`，以及 Storybook `MobileEdit` + Playwright 模拟 320px 键盘高度。',
              ].join('\n')
            : [
                'Done, PR created: **https://github.com/loro-dev/lody/pull/2520**',
                '',
                'Changes:',
                '- Mobile `AgentConfigDialog` shrinks by `--native-keyboard-height` so its bottom stops above the keyboard.',
                '- Custom prompt / env form scrollers use keyboard-aware scroll.',
                '- The shared hook now scrolls the provided container directly, avoiding textarea clipping behind the fixed footer.',
                '- Added the ACP provider config entry to `packages/components/AGENTS.md` for faster future discovery.',
                '',
                'Verification: `corepack pnpm install`, `corepack pnpm check`, `corepack pnpm --filter @lody/components typecheck`, plus Storybook `MobileEdit` with Playwright simulating a 320px keyboard.',
              ].join('\n'),
        },
      ],
      t2,
      { modelInfo }
    ),
  ];
}

type PreviewSessionCopy = {
  status: string;
  user: string;
  intro: string;
  bullets: readonly string[];
  closing: string;
  newTab: string;
  childTabs?: readonly string[];
  history?: readonly SessionHistoryParsed[];
  image?: {
    imageId: string;
    mimeType: string;
    fileName: string;
    sizeBytes: number;
    width: number;
    height: number;
  };
};

type PreviewCopy = {
  workspaceName: string;
  userEmail: string;
  docsPath: string;
  sidebar: {
    home: string;
    docs: string;
    feedback: string;
    myChats: string;
    teamChats: string;
    onlyChats: string;
    switchWorkspace: string;
    createWorkspace: string;
    inviteMembers: string;
    connectGithubRepo: string;
    localProjects: string;
    githubRepos: string;
  };
  landing: { title: string; prompt: string; placeholder: string };
  mobile: {
    allChats: string;
    back: string;
    projects: string;
    searchConversations: string;
    search: string;
    clear: string;
    emptyChats: string;
    emptySearch: string;
    newChat: string;
    moreActions: string;
    sessionTabs: string;
    filterTeam: string;
    filterMine: string;
    filterGroupNone: string;
    filterGroupProject: string;
    filterFilters: string;
    filterRepository: string;
    filterProject: string;
    filterStatus: string;
    filterPr: string;
    filterMachine: string;
    filterWorking: string;
    filterWaiting: string;
    filterIdle: string;
    filterOffline: string;
    filterNoPr: string;
  };
  contextSwitch: { local: string; github: string; chat: string };
  selectors: { selectRepo: string; selectProject: string; machine: string; selectAgent: string };
  machines: Record<'mac-studio' | 'mbp', string>;
  agents: Record<PreviewProvider, string>;
  repos: Record<'loro-dev/lody', string>;
  localProjectNames: readonly string[];
  localSessionTitles: readonly string[];
  models: {
    codex: Record<'gpt-5.5' | 'gpt-5.4' | 'gpt-5.4-mini' | 'gpt-5.3-Codex-Spark', LabelDesc>;
    claude: Record<'opus' | 'sonnet' | 'haiku', LabelDesc>;
  };
  config: {
    thinkLevel: string;
    fastMode: string;
    planMode: string;
    think: {
      codex: Record<'low' | 'medium' | 'high' | 'xhigh', LabelDesc>;
      claude: Record<'low' | 'medium' | 'high' | 'xhigh' | 'max', LabelDesc>;
    };
  };
  tasks: Record<'task-1' | 'task-2' | 'task-3' | 'task-5', string>;
  sessions: {
    repo: PreviewSessionCopy;
    localFeedback: PreviewSessionCopy;
    fontSizePlan: PreviewSessionCopy;
    mobileAcpKeyboard: PreviewSessionCopy;
    jellyfish: PreviewSessionCopy;
  };
};

const copy: Record<LandingLocale, PreviewCopy> = {
  en: {
    workspaceName: 'Lody',
    userEmail: 'demo@lody.ai',
    docsPath: '/docs/',
    sidebar: {
      home: 'New chat',
      docs: 'Docs',
      feedback: 'Feedback',
      myChats: 'My Chats',
      teamChats: 'Team Chats',
      onlyChats: 'Chats',
      switchWorkspace: 'Switch workspace',
      createWorkspace: 'Create workspace',
      inviteMembers: 'Invite members',
      connectGithubRepo: 'Connect GitHub repo',
      localProjects: 'Local Projects',
      githubRepos: 'GitHub Worktrees',
    },
    landing: {
      // 1:1 with the app's rotating landing heading (`chat.heading2`).
      title: 'What should we work on?',
      prompt: 'Generate a photo of a jellyfish floating in deep blue water.',
      placeholder: "Press '/' for commands, '@' for mentions.",
    },
    mobile: {
      allChats: 'All chats',
      back: 'Back',
      projects: 'Projects',
      searchConversations: 'Search conversations',
      search: 'Search',
      clear: 'Clear',
      emptyChats: 'No conversations in this workspace',
      emptySearch: 'No matches',
      newChat: 'New chat',
      moreActions: 'More actions',
      sessionTabs: 'Session tabs',
      filterTeam: 'Team Tasks',
      filterMine: 'My Tasks',
      filterGroupNone: 'Group: None',
      filterGroupProject: 'Group: Project',
      filterFilters: 'Filters',
      filterRepository: 'Repository',
      filterProject: 'Project',
      filterStatus: 'Status',
      filterPr: 'PR',
      filterMachine: 'Machine',
      filterWorking: 'Working',
      filterWaiting: 'Waiting permission',
      filterIdle: 'Idle',
      filterOffline: 'Offline',
      filterNoPr: 'No PR',
    },
    contextSwitch: { local: 'Local', github: 'GitHub', chat: 'Chat' },
    selectors: {
      selectRepo: 'Select repo',
      selectProject: 'Select project',
      machine: 'Machine',
      selectAgent: 'ACP Provider',
    },
    machines: { 'mac-studio': 'Mac Studio', mbp: 'MacBook Pro' },
    agents: { codex: 'Codex', claude: 'Claude' },
    repos: {
      'loro-dev/lody': 'AI coding-agent workspace',
    },
    localProjectNames: ['lody-feedback'],
    localSessionTitles: ['Fix roadmap issue timestamps'],
    models: {
      codex: {
        'gpt-5.5': ['5.5', 'Best Codex model for complex coding work.'],
        'gpt-5.4': ['5.4', 'Frontier coding model.'],
        'gpt-5.4-mini': ['5.4 mini', 'Faster Codex model for smaller tasks.'],
        'gpt-5.3-Codex-Spark': ['5.3-Codex-Spark', 'Lightweight Codex coding model.'],
      },
      claude: {
        opus: ['Opus', 'Most capable Claude model.'],
        sonnet: ['Sonnet', 'Balanced reasoning and speed.'],
        haiku: ['Haiku', 'Fast Claude model for quick edits.'],
      },
    },
    config: {
      thinkLevel: 'Think level',
      fastMode: 'Fast Mode',
      planMode: 'Plan',
      think: {
        codex: {
          low: ['Low', 'Fast, minimal reasoning.'],
          medium: ['Medium', 'Balanced depth and speed.'],
          high: ['High', 'More deliberate reasoning.'],
          xhigh: ['Xhigh', 'Maximum Codex reasoning depth.'],
        },
        claude: {
          low: ['Low', 'Fast, minimal reasoning.'],
          medium: ['Medium', 'Balanced depth and speed.'],
          high: ['High', 'More deliberate reasoning.'],
          xhigh: ['Xhigh', 'Extra reasoning depth.'],
          max: ['Max', 'Maximum Claude thinking budget.'],
        },
      },
    },
    tasks: {
      'task-1': 'Create highlight clipping fix PR',
      'task-2': 'Plan chat font size setting',
      'task-3': 'Fix mobile ACP provider keyboard',
      'task-5': 'Generate jellyfish image',
    },
    sessions: {
      repo: {
        status: 'Finished working',
        user: 'Fix the selected sidebar row highlight so the left and right edges are not clipped.',
        intro:
          'Done. The sidebar selection highlight now renders cleanly on all sides, and the fix is in PR #2564.',
        bullets: [
          'Traced the clipping to the Radix ScrollArea viewport boundary.',
          'Moved the horizontal gutter to the viewport so row outlines have room to paint.',
          'Verified the branch and PR remote tracking state.',
        ],
        closing: 'Nothing left to push for PR #2564.',
        newTab: 'New chat',
        history: buildLodyPrHistory('en'),
      },
      localFeedback: {
        status: 'Finished working',
        user: 'The roadmap update times are all the same. Investigate this bug and fix it.',
        intro:
          'Done. The roadmap cards now use the linked issue timestamp semantics, and the fix is in PR #64.',
        bullets: [
          'Found reorder logic writing the same timestamp to multiple roadmap items.',
          'Changed roadmap cards to display the linked issue/post updated time.',
          'Updated cross-column moves to refresh the issue timestamp while pure sorting stays unchanged.',
        ],
        closing: 'PR #64 has the follow-up commit and passing checks.',
        newTab: 'New chat',
        history: buildLodyFeedbackHistory('en'),
      },
      fontSizePlan: {
        status: 'Waiting for permission',
        user: 'How should we add a configurable font size for conversation messages? Give me a plan.',
        intro:
          'I traced the chat renderer, settings persistence, and mobile/desktop settings surfaces.',
        bullets: [
          'Store the preference as a local Jotai setting.',
          'Expose the same options in desktop and mobile settings.',
          'Re-measure the virtualized chat list when the size changes.',
        ],
        closing:
          'Waiting for a product decision on which conversation blocks the setting should affect.',
        newTab: 'New chat',
        history: buildFontSizePlanHistory('en'),
      },
      mobileAcpKeyboard: {
        status: 'Merged PR',
        user: 'When editing an ACP provider on mobile, the custom prompt and environment variables need keyboard handling. They should lift above the input keyboard. Create a PR after finishing.',
        intro:
          'Done. Mobile ACP provider editing now lifts custom prompts and env fields above the keyboard, and the fix is in PR #2520.',
        bullets: [
          'Shrank the mobile AgentConfigDialog by the native keyboard height.',
          'Connected custom prompt and env form textareas to keyboard-aware scrolling.',
          'Verified the MobileEdit story with a simulated 320px keyboard.',
        ],
        closing: 'PR #2520 was created from fix/mobile-acp-provider-keyboard and is merged.',
        newTab: 'New chat',
        history: buildMobileAcpKeyboardHistory('en'),
      },
      jellyfish: {
        status: 'Finished working',
        user: 'Generate a photo of a translucent jellyfish floating in deep blue water.',
        intro: 'Generated the jellyfish image.',
        bullets: [],
        closing: '',
        newTab: 'New chat',
        image: {
          imageId: 'landing-jellyfish-placeholder',
          mimeType: 'image/png',
          fileName: 'jellyfish.png',
          sizeBytes: 767_234,
          width: 1024,
          height: 1536,
        },
      },
    },
  },
  zh: {
    workspaceName: 'Lody',
    userEmail: 'demo@lody.ai',
    docsPath: '/zh/docs/',
    sidebar: {
      home: '新对话',
      docs: '文档',
      feedback: '反馈',
      myChats: '我的对话',
      teamChats: '团队对话',
      onlyChats: '对话',
      switchWorkspace: '切换工作区',
      createWorkspace: '新建工作区',
      inviteMembers: '邀请成员',
      connectGithubRepo: '连接 GitHub 仓库',
      localProjects: '本地项目',
      githubRepos: 'GitHub Worktrees',
    },
    landing: {
      // 1:1 with the app's rotating landing heading (`chat.heading2`).
      title: '今天想做点什么？',
      prompt: '生成一张水母漂浮在深蓝色海水里的照片。',
      placeholder: "按 '/' 使用命令，'@' 添加提及。",
    },
    mobile: {
      allChats: '全部对话',
      back: '返回',
      projects: '项目',
      searchConversations: '搜索对话',
      search: '搜索',
      clear: '清空',
      emptyChats: '当前 workspace 还没有任何对话',
      emptySearch: '没有匹配的结果',
      newChat: '新建对话',
      moreActions: '更多操作',
      sessionTabs: '会话标签',
      filterTeam: '团队任务',
      filterMine: '我的任务',
      filterGroupNone: '分组：无',
      filterGroupProject: '分组：项目',
      filterFilters: '过滤',
      filterRepository: '仓库',
      filterProject: '项目',
      filterStatus: '状态',
      filterPr: 'PR',
      filterMachine: '机器',
      filterWorking: '运行中',
      filterWaiting: '等待权限',
      filterIdle: '空闲',
      filterOffline: '离线',
      filterNoPr: '无 PR',
    },
    contextSwitch: { local: '本地', github: 'GitHub', chat: '对话' },
    selectors: {
      selectRepo: '选择仓库',
      selectProject: '选择项目',
      machine: '机器',
      selectAgent: 'ACP Provider',
    },
    machines: { 'mac-studio': 'Mac Studio', mbp: 'MacBook Pro' },
    agents: { codex: 'Codex', claude: 'Claude' },
    repos: {
      'loro-dev/lody': 'AI 编码 Agent 工作区',
    },
    localProjectNames: ['lody-feedback'],
    localSessionTitles: ['修复 Roadmap Issue 更新时间'],
    models: {
      codex: {
        'gpt-5.5': ['5.5', '最适合复杂编码任务的 Codex 模型。'],
        'gpt-5.4': ['5.4', '前沿编码模型。'],
        'gpt-5.4-mini': ['5.4 mini', '更快的 Codex 小任务模型。'],
        'gpt-5.3-Codex-Spark': ['5.3-Codex-Spark', '轻量 Codex 编码模型。'],
      },
      claude: {
        opus: ['Opus', '最强 Claude 模型。'],
        sonnet: ['Sonnet', '推理与速度兼顾。'],
        haiku: ['Haiku', '适合快速修改的 Claude 模型。'],
      },
    },
    config: {
      thinkLevel: '思考强度',
      fastMode: '快速模式',
      planMode: 'Plan',
      think: {
        codex: {
          low: ['Low', '快速、最少推理。'],
          medium: ['Medium', '深度与速度均衡。'],
          high: ['High', '更深入的推理。'],
          xhigh: ['Xhigh', '最高 Codex 推理强度。'],
        },
        claude: {
          low: ['Low', '快速、最少推理。'],
          medium: ['Medium', '深度与速度均衡。'],
          high: ['High', '更深入的推理。'],
          xhigh: ['Xhigh', '额外推理深度。'],
          max: ['Max', '最高 Claude 思考预算。'],
        },
      },
    },
    tasks: {
      'task-1': '创建高亮裁剪修复 PR',
      'task-2': '规划对话字号设置',
      'task-3': '优化移动端 ACP Provider 键盘',
      'task-5': '生成水母图片',
    },
    sessions: {
      repo: {
        status: '已完成',
        user: '修复侧边栏选中高亮左右两侧被裁剪的问题。',
        intro: '已完成。侧边栏选中高亮现在四边都能完整显示，并已创建 PR #2564。',
        bullets: [
          '定位到 Radix ScrollArea viewport 的横向裁剪边界。',
          '把横向 gutter 移到 viewport，让选中行 outline 有空间完整绘制。',
          '确认远端分支和 PR 跟踪状态。',
        ],
        closing: 'PR #2564 已经没有剩余内容需要 push。',
        newTab: '新对话',
        history: buildLodyPrHistory('zh'),
      },
      localFeedback: {
        status: '已完成',
        user: 'roadmap 的更新时间都是一样的？研究一下这个 bug 并修复',
        intro: '已完成。Roadmap 卡片现在使用关联 issue 自身的更新时间语义，修复已在 PR #64。',
        bullets: [
          '定位到重排逻辑会把多个 roadmap item 写成同一个更新时间。',
          '改为展示关联 issue/post 的更新时间。',
          '跨列移动会更新 issue 自身更新时间，纯排序不会更新。',
        ],
        closing: 'PR #64 已包含追加修正提交，检查通过。',
        newTab: '新对话',
        history: buildLodyFeedbackHistory('zh'),
      },
      fontSizePlan: {
        status: '等待权限',
        user: '怎么增加对话中字体大小的配置，给我一份计划',
        intro: '我已经定位了对话渲染、设置持久化，以及桌面和移动设置入口。',
        bullets: [
          '把字号偏好作为本地 Jotai 设置保存。',
          '在桌面和移动设置里接入同一组选项。',
          '字号变化时重新测量虚拟化对话列表。',
        ],
        closing: '正在等待确认：这个设置应该影响哪些对话内容块。',
        newTab: '新对话',
        history: buildFontSizePlanHistory('zh'),
      },
      mobileAcpKeyboard: {
        status: 'PR 已合并',
        user: '移动端编辑 ACP provider 时候，自定义 prompt 和环境变量需要对输入法键盘进行优化。需要被键盘顶起。完成后创建 pr',
        intro:
          '已完成。移动端 ACP provider 编辑时，自定义 prompt 和环境变量输入区会被键盘顶起，修复已在 PR #2520。',
        bullets: [
          '移动端 AgentConfigDialog 会按原生键盘高度缩短。',
          '自定义 prompt 和 env 表单 textarea 接入 keyboard-aware scroll。',
          '用 MobileEdit story 模拟 320px 键盘高度完成验证。',
        ],
        closing: 'PR #2520 来自 fix/mobile-acp-provider-keyboard，当前已合并。',
        newTab: '新对话',
        history: buildMobileAcpKeyboardHistory('zh'),
      },
      jellyfish: {
        status: '已完成',
        user: '生成一张透明水母漂浮在深蓝色海水里的照片。',
        intro: '水母图片已生成。',
        bullets: [],
        closing: '',
        newTab: '新对话',
        image: {
          imageId: 'landing-jellyfish-placeholder',
          mimeType: 'image/png',
          fileName: 'jellyfish.png',
          sizeBytes: 767_234,
          width: 1024,
          height: 1536,
        },
      },
    },
  },
};

type SessionTaskSeed = {
  taskId: keyof PreviewCopy['tasks'];
  repoFullName: string | null;
  branchName: string;
  prUrl?: string;
  prNumber?: number;
  prStatus?: string;
  /** Compact CI verdict from the PR poller — drives the sidebar's CI badge. */
  prCiState?: 's' | 'f' | 'p' | 'e' | 'x';
  /** 'y' = proven mergeable; inactive rows swap their diffstat for the pill. */
  prReadiness?: 'y' | 'n';
  latestMessageAt: number;
  addedLines: number;
  deletedLines: number;
  isWorking: boolean;
  hasUnreadMessages: boolean;
  isOffline: boolean;
  isWaitingPermission: boolean;
};

const taskSeeds: SessionTaskSeed[] = [
  {
    taskId: 'task-1',
    repoFullName: 'loro-dev/lody',
    branchName: 'feat/selection-highlight-clipping',
    prUrl: 'https://github.com/loro-dev/lody/pull/2564',
    prNumber: 2564,
    prStatus: 'open',
    prCiState: 's',
    prReadiness: 'y',
    latestMessageAt: now - 8 * 60 * 1000,
    addedLines: 15,
    deletedLines: 2,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    taskId: 'task-2',
    repoFullName: 'loro-dev/lody',
    branchName: 'plan/chat-font-size-setting',
    latestMessageAt: now - 37 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: true,
    isOffline: false,
    isWaitingPermission: true,
  },
  {
    taskId: 'task-3',
    repoFullName: 'loro-dev/lody',
    branchName: 'fix/mobile-acp-provider-keyboard',
    prUrl: 'https://github.com/loro-dev/lody/pull/2520',
    prNumber: 2520,
    prStatus: 'merged',
    prCiState: 's',
    latestMessageAt: now - 3 * 60 * 60 * 1000,
    addedLines: 23,
    deletedLines: 9,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  },
  {
    taskId: 'task-5',
    repoFullName: null,
    branchName: '',
    latestMessageAt: now - 2 * 60 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: true,
    isOffline: false,
    isWaitingPermission: false,
  },
];

// Local-project sessions. The real app renders local projects in their own sidebar
// section (LocalProjectSessionItem in loro-app-sidebar), separate from the GitHub
// SessionList — so we mirror that with a dedicated section rather than a repo group.
type LocalSessionSeed = {
  taskId: string;
  project: string;
  branchName: string;
  ageLabel: string;
  addedLines: number;
  deletedLines: number;
};

const localSessionSeeds: LocalSessionSeed[] = [
  {
    taskId: 'local-1',
    project: 'lody-feedback',
    branchName: 'codex/fix-roadmap-updated-at',
    ageLabel: '1h',
    addedLines: 0,
    deletedLines: 0,
  },
];

const initialRepos: SessionListRepoState[] = [{ repoFullName: 'loro-dev/lody', collapsed: false }];

function buildTasks(t: PreviewCopy): SessionListRow[] {
  return taskSeeds.map((seed) => {
    const { taskId, ...rest } = seed;
    return {
      ...rest,
      sessionId: taskId,
      title: t.tasks[taskId],
      machineId: 'mac-studio' as SessionListRow['machineId'],
      machineName: 'Mac Studio',
      // GitHub sessions always run in an isolated worktree — the sidebar row
      // renders the worktree badge from this flag.
      isWorktree: Boolean(seed.repoFullName),
    };
  });
}

function buildLocalSessions(t: PreviewCopy): SessionListRow[] {
  return localSessionSeeds.map((seed, index) => ({
    sessionId: seed.taskId,
    title: t.localSessionTitles[index] ?? seed.taskId,
    repoFullName: seed.project,
    branchName: seed.branchName,
    latestMessageAt: now,
    addedLines: seed.addedLines,
    deletedLines: seed.deletedLines,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    machineId: 'mac-studio' as SessionListRow['machineId'],
    machineName: 'Mac Studio',
  }));
}

const PREVIEW_SESSION_ID = 'session-landing-preview' as SessionId;
const PREVIEW_MACHINE_ID = 'machine-landing-preview' as MachineId;

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

type PreviewPrStatus = NonNullable<MobileConversationItem['prStatus']>;

const PREVIEW_PR_BADGE_META: Record<
  PreviewPrStatus,
  { icon: typeof GitPullRequest; className: string; label: string }
> = {
  open: {
    icon: GitPullRequest,
    className: cn(
      'border-github-open/[0.18] bg-github-open/[0.08] text-github-open',
      'hover:border-github-open/[0.28] hover:bg-github-open/[0.12]'
    ),
    label: 'Open',
  },
  merged: {
    icon: GitMerge,
    className: cn(
      'border-github-merged/[0.18] bg-github-merged/[0.08] text-github-merged',
      'hover:border-github-merged/[0.28] hover:bg-github-merged/[0.12]'
    ),
    label: 'Merged',
  },
  closed: {
    icon: GitPullRequestClosed,
    className: cn(
      'border-github-closed/[0.18] bg-github-closed/[0.08] text-github-closed',
      'hover:border-github-closed/[0.28] hover:bg-github-closed/[0.12]'
    ),
    label: 'Closed',
  },
  draft: {
    icon: GitPullRequestDraft,
    className: cn(
      'border-github-draft/[0.18] bg-github-draft/[0.08] text-github-draft',
      'hover:border-github-draft/[0.28] hover:bg-github-draft/[0.12]'
    ),
    label: 'Draft',
  },
};

function getTaskTimestamp(value: SessionListRow['latestMessageAt']): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function formatPreviewMobileAgeLabel(value: SessionListRow['latestMessageAt']): string {
  const timestamp = getTaskTimestamp(value);
  if (!timestamp) return '';
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function getPreviewPrStatus(value: SessionListRow['prStatus']): PreviewPrStatus | null {
  return value === 'open' || value === 'merged' || value === 'closed' || value === 'draft'
    ? value
    : null;
}

function PreviewPrBadge({ task }: { task: SessionListRow }) {
  if (!task.prNumber) return null;
  const status = getPreviewPrStatus(task.prStatus) ?? 'open';
  const statusMeta = PREVIEW_PR_BADGE_META[status];
  const Icon = statusMeta.icon;

  return (
    <span
      aria-label={`${statusMeta.label} PR #${task.prNumber}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums transition-colors',
        statusMeta.className
      )}
    >
      <Icon className="h-3 w-3" strokeWidth={2.25} />
      <span>#{task.prNumber}</span>
    </span>
  );
}

function buildPreviewMobileConversation(task: SessionListRow): MobileConversationItem {
  const isLocal = task.sessionId.startsWith('local-');
  const isPlainChat = !task.repoFullName;
  const kind: MobileConversationItem['kind'] = isPlainChat ? 'chat' : isLocal ? 'local' : 'github';
  const projectKey = isPlainChat
    ? null
    : isLocal
      ? `mac-studio:${task.repoFullName ?? 'local'}`
      : (task.repoFullName ?? null);
  const projectLabel = isPlainChat ? null : (task.repoFullName ?? null);
  const ownerHandle = !isPlainChat && !isLocal ? task.repoFullName?.split('/')[0] : null;
  // GitHub sessions are always worktrees; the worktree demo's local session
  // also shows the marker so the mobile home row telegraphs "isolated worktree".
  const isWorktree = !isPlainChat && (!isLocal || task.sessionId === DEMO_TASK_ID);

  return {
    id: task.sessionId,
    title: task.title,
    kind,
    branchName: task.branchName || null,
    prNumber: task.prNumber ?? null,
    prStatus: getPreviewPrStatus(task.prStatus),
    addedLines: task.addedLines,
    deletedLines: task.deletedLines,
    latestMessageAt: getTaskTimestamp(task.latestMessageAt),
    ageLabel: formatPreviewMobileAgeLabel(task.latestMessageAt),
    isWorking: task.isWorking,
    isWaitingPermission: task.isWaitingPermission,
    isOffline: task.isOffline,
    hasUnreadMessages: task.hasUnreadMessages,
    isPinned: task.isPinned,
    isWorktree,
    machineId: 'mac-studio',
    projectKey,
    projectLabel,
    projectAvatarUrl: ownerHandle ? `https://github.com/${ownerHandle}.png?size=64` : null,
  };
}

function isStaticSidebarChromeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('button');
  if (!button) return false;

  const ariaLabel = button.getAttribute('aria-label');
  if (ariaLabel === 'Filter sidebar') return true;

  const label = button.textContent?.replace(/\s+/g, ' ').trim();
  if (label === 'Settings' || label === 'Help' || label === 'Archive') return true;

  // Workspace switch trigger in LoroSidebar's header. Keep the lower project rows
  // interactive even when their visible label is also "Lody".
  return button.classList.contains('grid') && button.classList.contains('h-9');
}

function preventStaticSidebarChrome(event: SyntheticEvent<HTMLElement>) {
  if (!isStaticSidebarChromeTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

function preventStaticSidebarChromeKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  preventStaticSidebarChrome(event);
}

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

/* Machine + agent-config seeds for the REAL `DesktopRunConfigMenu`. Machine and
   agent display names are the same in both locales (see `t.machines`/`t.agents`),
   so these can live outside the locale copy tables and be seeded once. */
const PREVIEW_MACHINES = [
  { id: 'mac-studio' as MachineId, name: 'Mac Studio' },
  { id: 'mbp' as MachineId, name: 'MacBook Pro' },
] as unknown as MachineViewMeta[];

function buildPreviewAgentConfigs(): Record<string, AgentConfigMeta> {
  const configs = [
    { id: 'codex', name: 'Codex', cliType: 'codex', agentType: 'codex' },
    { id: 'claude', name: 'Claude', cliType: 'claude', agentType: 'claude' },
  ];
  const byId: Record<string, AgentConfigMeta> = {};
  for (const config of configs) {
    byId[config.id] = {
      ...config,
      machineId: 'mac-studio',
      description: undefined,
      env: {},
    } as unknown as AgentConfigMeta;
  }
  return byId;
}

function createLandingPreviewRuntime(workspaceId: WorkspaceId): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceSlug: 'lody',
    getSessionStore: async () => ({
      setState: () => undefined,
    }),
  } as unknown as WorkspaceRuntime;
}

function getPreviewAgent(selectedAgent: string | null): Pick<SessionMeta, 'cliType' | 'agentType'> {
  return selectedAgent === 'claude'
    ? { cliType: 'builtin', agentType: 'claude' }
    : { cliType: 'builtin', agentType: 'codex' };
}

function buildPreviewSessionMeta({
  id,
  title,
  task,
  selectedAgent,
  parentSessionId,
  minutesAgo,
}: {
  id: SessionId;
  title: string;
  task: SessionListRow;
  selectedAgent: string | null;
  parentSessionId?: SessionId;
  minutesAgo: number;
}): SessionMeta {
  const agent = getPreviewAgent(selectedAgent);
  const activityAt = now - minutesAgo * 60 * 1000;
  return {
    id,
    machineId: PREVIEW_MACHINE_ID,
    createdAt: new Date(activityAt - 45 * 60 * 1000).toISOString(),
    lastMessageAt: activityAt,
    lastReadAt: activityAt + 1000,
    title,
    userId: 'preview-user',
    cliType: agent.cliType,
    agentType: agent.agentType,
    repoFullName: task.repoFullName ?? undefined,
    branchName: task.branchName || undefined,
    isWorktree: Boolean(task.repoFullName),
    parentSessionId,
  };
}

// Build a mock conversation in the real SessionHistoryParsed shape so the genuine
// ai-gui renderer (SessionChatStreamView + MessageRowView) draws it — same approach
// through the same production renderer, not a hand-built bubble layout.
function buildSessionMessages(
  session: PreviewSessionCopy,
  modelLabel: string,
  modelId: string
): SessionHistoryParsed[] {
  if (session.history?.length) {
    return [...session.history];
  }

  const ts = new Date(now).toISOString();
  const assistantMarkdown = [
    session.intro,
    session.bullets.length ? session.bullets.map((bullet) => `- ${bullet}`).join('\n') : '',
    session.closing,
  ]
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
  const assistantItems = [
    { type: 'text' as const, text: assistantMarkdown },
    ...(session.image
      ? [
          {
            type: 'image_group' as const,
            images: [session.image],
          },
        ]
      : []),
  ];

  return [
    {
      id: 'preview-user-1',
      role: 'user',
      timestamp: ts,
      read: true,
      userId: 'preview-user',
      items: [{ type: 'text', text: session.user }],
      finished: true,
    },
    {
      id: 'preview-assistant-1',
      role: 'assistant',
      timestamp: ts,
      read: true,
      userId: undefined,
      modelInfo: { name: modelLabel || '5.5', modelId: modelId || 'gpt-5.5' },
      items: assistantItems,
      finished: true,
    },
  ];
}

// Session surface: reuses the REAL ai-gui conversation renderer; the tab bar +
// repo/PR top bar are thin chrome mirroring the real workspace shell.
// ---- Changes review (REAL app components) ----------------------------------
// Renders the real `SessionChangesSidebar` (变更列表) + real `DiffViewer`
// (对话变更面板) from packages/components, driven by hand-mocked file diffs. Real
// per-turn / All-Changes data will replace buildMockChangeFiles later.

type MockChangeFile = {
  path: string;
  add: number;
  del: number;
  oldText: string;
  newText: string;
};

function buildMockChangeFiles(): MockChangeFile[] {
  return [
    {
      path: 'packages/components/src/components/ai-gui/view.tsx',
      add: 6,
      del: 1,
      oldText: `export function SessionChatStreamView(props: Props) {
  const listRef = useRef<VirtuosoHandle>(null);

  const clip = false;

  return <Virtuoso ref={listRef} data={props.items} />;
}
`,
      newText: `export function SessionChatStreamView(props: Props) {
  const listRef = useRef<VirtuosoHandle>(null);

  const clip = useSelectionHighlightClip(listRef);

  useEffect(() => {
    if (!clip) return;
    listRef.current?.autoscrollToBottom();
  }, [clip]);

  return <Virtuoso ref={listRef} data={props.items} />;
}
`,
    },
    {
      path: 'packages/components/src/ui/selection-highlight.ts',
      add: 5,
      del: 1,
      oldText: `export function useSelectionHighlightClip(ref: RefObject<HTMLElement>) {
  return false;
}
`,
      newText: `export function useSelectionHighlightClip(ref: RefObject<HTMLElement>) {
  const [clip, setClip] = useState(false);
  // clip the highlight to the visible viewport
  useLayoutEffect(() => observe(ref, setClip), [ref]);
  return clip;
}
`,
    },
  ];
}

// Scripted controls for feature-tab 2 (live diff review). When present, the
// session's secondary panel + viewer are driven by the demo timeline instead of
// being statically open: the ghost cursor opens the right panel, switches to the
// Changes tab, and clicks a file, which opens a diff tab IN that panel (skeleton
// first, then the real diff) — matching session-detail.tsx, where desktop file
// and diff viewers never split the conversation surface.
type DiffDemoControls = {
  secondaryOpen: boolean;
  panelTab: 'files' | 'changes' | 'pr';
  viewer: 'hidden' | 'skeleton' | 'shown';
  onToggleSecondary: () => void;
  onPanelTabChange: (tab: 'files' | 'changes' | 'pr') => void;
  onOpenFile: (path: string) => void;
};

// Scripted controls for feature-tab 3 (design mode / Lody Preview). The session
// info bar gains the app's emerald Browser action once the dev server reports a
// candidate; clicking it opens the right panel on its Browser tab (mirroring
// session-detail.tsx's conditional `kind: 'browser'` tab) with the
// LandingPreviewPanel inside.
type DesignDemoControls = {
  previewAvailable: boolean;
  previewOpen: boolean;
  onOpenPreview: () => void;
  previewNode: React.ReactNode;
};

/* The info bar's Browser ActionChip (session-info-bar.tsx) renders
   `aria-label={t('sessions.browser.title', 'Browser')}`; that key is not in
   `demoI18n`, so the English default is what the scripted cursor aims at. */
const PREVIEW_ACTION_SELECTOR = 'button[aria-label="Browser"]';
/* Annotation mode moved onto the real `SessionBrowserToolbar`. */
const ANNOTATE_ACTION_SELECTOR = 'button[aria-label="Annotate page"]';

// The resizable session layout persists via its `autoSaveId`; clear that so every
// demo loop starts from the default split and a demo's widened panel never leaks
// into the other feature tabs' layouts.
function clearPanelLayoutStorage() {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('react-resizable-panels')) window.localStorage.removeItem(key);
    }
  } catch {
    // storage unavailable — layout just persists, demo still works
  }
}

// All-Changes loading placeholder: a couple of pulsing cards shaped like the diff
// cards, shown for ~1s after a file is opened before the real diff renders.
function DiffViewerSkeleton() {
  return (
    <div className="h-full space-y-3 overflow-hidden bg-background p-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
            <div className="h-3.5 w-3.5 animate-pulse rounded bg-muted-foreground/20" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted-foreground/20" />
            <div className="ml-auto h-3 w-12 animate-pulse rounded bg-muted-foreground/15" />
          </div>
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 + i }).map((_, row) => (
              <div key={row} className="flex items-center gap-3">
                <div className="h-3 w-6 animate-pulse rounded bg-muted-foreground/10" />
                <div
                  className="h-3 animate-pulse rounded bg-muted-foreground/15"
                  style={{ width: `${45 + ((row * 13) % 45)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// The desktop session, laid out with the REAL DesktopSessionDetailLayout:
// ONE merged top row (session tabs + toolbar), the conversation with the info
// bar glued above its composer, and the floating right-panel card carrying the
// real SessionSidePanelTabBar over Files / All Changes / PR / Preview — 1:1 with
// session-detail.tsx, where file and diff viewers never split the conversation.
function DesktopSessionPreview({
  task,
  repoLabel,
  isLocalSession,
  newTabLabel,
  parentSession,
  childSessions,
  activeTabSessionId,
  onSelectTab,
  items,
  sessionStatus,
  sessionHistory,
  chatUser,
  composer,
  locale,
  isDark,
  hasChanges = true,
  diffDemo,
  designDemo,
}: {
  task: SessionListRow;
  repoLabel: string;
  isLocalSession: boolean;
  newTabLabel: string;
  parentSession: SessionMeta;
  childSessions: SessionMeta[];
  activeTabSessionId: SessionId;
  onSelectTab: (id: string) => void;
  items: ChatStreamItem[];
  sessionStatus?: SessionStatus;
  sessionHistory: readonly SessionHistoryParsed[];
  chatUser: SessionChatUser;
  composer: React.ReactNode;
  locale: LandingLocale;
  isDark: boolean;
  /** Sessions with a dirty worktree get the diffstat + GitHub actions. */
  hasChanges?: boolean;
  /** Feature-tab-2 scripted diff-review controls; undefined = user-toggled. */
  diffDemo?: DiffDemoControls;
  /** Feature-tab-3 scripted design-mode controls; undefined = no preview action. */
  designDemo?: DesignDemoControls;
}) {
  const isZh = locale === 'zh';
  // Design demo: no All-Changes diff tab; the right panel opens on Preview only
  // once the ghost cursor clicks the info bar's emerald preview chip.
  /* Production opens a session with the right panel CLOSED
     (`DEFAULT_SIDE_PANEL_STATE.open === false` in
     `lib/session-detail-initial-state.ts`) — the conversation gets the full
     width until you ask for Files / All Changes / Browser. */
  const [staticSecondaryOpen, setStaticSecondaryOpen] = useState(false);
  const [staticPanelTab, setStaticPanelTab] = useState('changes');
  const secondaryOpen = designDemo
    ? designDemo.previewOpen
    : diffDemo
      ? diffDemo.secondaryOpen
      : staticSecondaryOpen;
  const onToggleSecondary = () => setStaticSecondaryOpen((open) => !open);
  const viewerMode = designDemo ? 'hidden' : diffDemo ? diffDemo.viewer : 'hidden';
  const hasViewer = viewerMode !== 'hidden';
  const panelTab = diffDemo ? diffDemo.panelTab : staticPanelTab;
  const onSelectPanelTab = (tabId: string) => {
    if (!secondaryOpen) setStaticSecondaryOpen(true);
    if (diffDemo && (tabId === 'files' || tabId === 'changes' || tabId === 'pr')) {
      diffDemo.onPanelTabChange(tabId);
      return;
    }
    setStaticPanelTab(tabId);
  };
  const files = useMemo(() => buildMockChangeFiles(), []);
  // Force the diff's shiki theme to follow the app's dark/light (the embedded
  // app-theme context isn't mounted here, so DiffViewer's own resolution defaults
  // to light). Overrides the internal theme via the merged `options`.
  const diffOptions = {
    theme: isDark ? 'github-dark-default' : 'pierre-light',
    themeType: isDark ? ('dark' as const) : ('light' as const),
  };
  const changeEntries: SessionDiffChangeEntry[] = hasChanges
    ? files.map((file) => ({ filePath: file.path, add: file.add, del: file.del }))
    : [];
  const changeFilePaths = changeEntries.map((entry) => entry.filePath);
  const diffStat = {
    add: changeEntries.reduce((sum, entry) => sum + (entry.add ?? 0), 0),
    del: changeEntries.reduce((sum, entry) => sum + (entry.del ?? 0), 0),
  };
  // Info-bar PR + GitHub actions, derived from the same mock task the sidebar
  // row renders (session-chat-interface.tsx feeds the bar from SessionMeta).
  const infoBarPr = task.prUrl
    ? { url: task.prUrl, status: (task.prStatus ?? 'open') as PrStatus }
    : null;
  const infoBarActions = !hasChanges
    ? []
    : infoBarPr
      ? [
          {
            id: 'commit-and-push',
            label: isZh ? '提交并推送' : 'Commit & Push',
            onClick: () => undefined,
          },
        ]
      : [
          { id: 'create-pr', label: isZh ? '创建 PR' : 'Create PR', onClick: () => undefined },
          {
            id: 'commit-and-push',
            label: isZh ? '提交并推送' : 'Commit & Push',
            onClick: () => undefined,
          },
        ];
  const permissionHistory = sessionHistory as Parameters<
    typeof FloatingPermissionRequest
  >[0]['sessionHistory'];
  const shouldShowComposer = !hasPendingAskUserQuestion(sessionStatus, permissionHistory);

  // Right-panel toggle — 1:1 with session-detail.tsx's `sidebarToggleButton`.
  const sidebarToggleButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-demo="toggle-panel"
      onClick={diffDemo ? diffDemo.onToggleSecondary : onToggleSecondary}
      aria-label={
        secondaryOpen
          ? isZh
            ? '隐藏侧边栏'
            : 'Hide sidebar'
          : isZh
            ? '显示侧边栏'
            : 'Show sidebar'
      }
      className={cn('h-7 w-7 shrink-0 text-muted-foreground', !secondaryOpen && 'mr-[9px]')}
    >
      <PanelRight className="h-4 w-4" />
    </Button>
  );

  /* Compact toolbar for the merged desktop tab row — the same shape as
     `SessionChatInterface headerVariant="toolbar"`: right-side controls only,
     no title and no PR badge (the info bar above the composer owns identity
     and PR). See sessions/AGENTS.md "Desktop top bar is ONE merged row". */
  const headerToolbar = (
    <div className="flex h-full shrink-0 items-center gap-1 pl-1 pr-2">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground"
        aria-label={isZh ? '在编辑器中打开' : 'Open in editor'}
        onClick={() => undefined}
      >
        <SquareTerminal className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted-foreground"
        aria-label={isZh ? '更多操作' : 'More actions'}
        onClick={() => undefined}
      >
        <Ellipsis className="h-4 w-4" />
      </Button>
      {!secondaryOpen ? sidebarToggleButton : null}
    </div>
  );

  /* Single-row desktop top bar: [session tabs …] [toolbar]. The old repo-title
     header row is gone in production; `mt-0.5 h-11` keeps the h-8 pills on the
     same y=8 line as the sidebar and side-panel cards. */
  const topBar = (
    <SessionTabBar
      variant="session"
      parentSession={parentSession}
      childSessions={childSessions}
      draftTabs={[]}
      archivedChildSessions={[]}
      activeTabSessionId={activeTabSessionId}
      onTabSelect={onSelectTab}
      onNewTab={() => undefined}
      tabOrder={childSessions.map((session) => session.id)}
      rightSlot={
        <>
          <span className="sr-only">{newTabLabel}</span>
          {headerToolbar}
        </>
      }
      className="mt-0.5 h-11"
    />
  );

  const chatSurfaces = (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1">
        <SessionChatStreamView
          sessionId={PREVIEW_SESSION_ID}
          items={items}
          renderMessageRow={({ message, sessionId }) => (
            <MessageRowView message={message} sessionId={sessionId} user={chatUser} />
          )}
        />
      </div>
      <FloatingPermissionRequest
        sessionId={PREVIEW_SESSION_ID}
        sessionStatus={sessionStatus}
        sessionHistory={permissionHistory}
      />
      {shouldShowComposer ? (
        <>
          {/* Info bar glued above the composer: the canonical cluster + fixed
              stage row that owns repo/branch/PR identity, the ±diffstat, the
              GitHub actions, and the emerald Preview chip (which replaced the
              old header preview button). */}
          <SessionInfoBar
            projectName={repoLabel}
            branch={parentSession.branchName ?? null}
            workspaceLocation={isLocalSession ? { kind: 'worktree', path: null } : null}
            pr={infoBarPr}
            onOpenPr={() => onSelectPanelTab('pr')}
            contextActions={infoBarActions}
            onOpenAllChanges={() => onSelectPanelTab('changes')}
            onOpenBrowser={designDemo?.previewAvailable ? designDemo.onOpenPreview : undefined}
            diffStat={hasChanges ? diffStat : null}
          />
          {/* Full-bleed shell + ONE ConversationColumn — same as production
              SessionChatInputArea. Extra outer `px-3` would double the gutter
              and make the composer narrower than SessionInfoBar. */}
          <div className="relative shrink-0 bg-background pb-3 pt-0">
            <ConversationColumn>{composer}</ConversationColumn>
          </div>
        </>
      ) : null}
    </div>
  );

  const changesList = (viewMode?: 'files' | 'types') => (
    <SessionChangesSidebar
      key={viewMode ?? 'default'}
      ready
      synced
      changeEntries={changeEntries}
      changeFilePaths={changeFilePaths}
      initialViewMode={viewMode}
      onOpenChangesDiff={diffDemo ? (path) => diffDemo.onOpenFile(path) : () => undefined}
    />
  );

  // The diff surface now lives INSIDE the right panel (production never splits
  // the conversation with a viewer pane).
  const diffSurface =
    viewerMode === 'skeleton' ? (
      <DiffViewerSkeleton />
    ) : (
      <div className="h-full space-y-3 overflow-y-auto bg-background p-3">
        {files.map((file) => (
          <DiffViewer
            key={file.path}
            path={file.path}
            oldText={file.oldText}
            newText={file.newText}
            diffStyle="unified"
            options={diffOptions}
          />
        ))}
      </div>
    );

  const activePanelTab = designDemo ? 'browser' : hasViewer ? 'diff:all-changes' : panelTab;

  /* Fixed tabs mirror session-detail.tsx: Files, All Changes, then PR when the
     session has one and Preview once a dev server reports a candidate. A file
     opened from All Changes appends a closeable diff tab. */
  const sidePanelTabs: SessionSidePanelTabItem[] = [
    { id: 'files', label: isZh ? '文件' : 'Files', kind: 'files' },
    { id: 'changes', label: isZh ? '全部变更' : 'All Changes', kind: 'changes' },
    ...(infoBarPr ? [{ id: 'pr', label: 'PR', kind: 'pr' as const }] : []),
    ...(designDemo?.previewAvailable
      ? [{ id: 'browser', label: isZh ? '浏览器' : 'Browser', kind: 'browser' as const }]
      : []),
    ...(hasViewer
      ? [
          {
            id: 'diff:all-changes',
            label: isZh ? '全部变更' : 'All Changes',
            kind: 'diff' as const,
            closeable: true,
          },
        ]
      : []),
  ];

  const panelBody =
    activePanelTab === 'diff:all-changes' ? (
      diffSurface
    ) : activePanelTab === 'browser' ? (
      designDemo?.previewNode
    ) : activePanelTab === 'pr' ? (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        <PreviewPrBadge task={task} />
      </div>
    ) : activePanelTab === 'files' ? (
      changesList('files')
    ) : (
      changesList('types')
    );

  /* Floating card, 1:1 with session-detail.tsx's `desktopSecondaryPanel`. */
  const secondaryPanel = (
    <div className="mx-2 mb-2 mt-2 flex h-[calc(100%_-_1rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]">
      <SessionSidePanelTabBar
        tabs={sidePanelTabs}
        activeTabId={activePanelTab}
        // Landing preview keeps the core panels pinned open; nothing left to add.
        availablePanels={[]}
        onTabSelect={(tabId) => onSelectPanelTab(tabId)}
        onTabClose={() => onSelectPanelTab('changes')}
        onPanelOpen={() => undefined}
        addPanelLabel={isZh ? '添加面板' : 'Add panel'}
        closeTabLabel={(tabLabel) => (isZh ? `关闭 ${tabLabel}` : `Close ${tabLabel}`)}
        endSlot={sidebarToggleButton}
        className="h-11 border-b border-border/60"
      />
      <div className="min-h-0 flex-1 overflow-hidden">{panelBody}</div>
    </div>
  );

  return (
    <DesktopSessionDetailLayout
      defaultSizes={hasViewer ? { main: 60, sidebar: 40 } : { main: 75, sidebar: 25 }}
      topBar={topBar}
      chatSurfaces={chatSurfaces}
      terminalDock={null}
      secondaryPanel={secondaryPanel}
      sidebarOpen={secondaryOpen}
      onSidebarCollapse={diffDemo ? diffDemo.onToggleSecondary : onToggleSecondary}
      deleteConfirmDialog={null}
    />
  );
}

/* The phone session view, 1:1 with `session-detail.tsx`'s `if (isMobile)` shell.
   Desktop always goes through `DesktopSessionPreview`.

   Shape (all of it is drift the landing had to catch up on):
   - a FLOATING FROSTED header absolutely positioned over the conversation, so
     messages scroll UNDER it — the conversation reserves room through
     `--conversation-top-inset`, which the real ai-gui `VList` already reads;
   - glass chrome only: back chevron, session-tabs button, "…" — the mobile
     header's PR badge and preview button were both REMOVED upstream, and mobile
     never renders `SessionTabBar` (tabs live in `MobileSessionTabSheet`);
   - the same `SessionInfoBar` desktop uses, glued above the composer, minus the
     branch (mobile drops it) and lifted above the drawer's edge-back strip. */
const MOBILE_SESSION_HEADER_INSET = '3rem';

function MobileSessionView({
  task,
  repoLabel,
  isLocalSession,
  isPlainChatSession,
  items,
  sessionHistory,
  sessionStatus,
  chatUser,
  composer,
  hasChanges = false,
  mobileBackLabel,
  mobileMoreActionsLabel,
  mobileSessionTabsLabel,
  onMobileBack,
}: {
  task: SessionListRow;
  repoLabel: string;
  isLocalSession: boolean;
  isPlainChatSession: boolean;
  items: ChatStreamItem[];
  sessionHistory: readonly SessionHistoryParsed[];
  sessionStatus?: SessionStatus;
  chatUser: SessionChatUser;
  composer: React.ReactNode;
  /** Sessions with a dirty worktree get the diffstat + GitHub actions. */
  hasChanges?: boolean;
  mobileBackLabel?: string;
  mobileMoreActionsLabel?: string;
  mobileSessionTabsLabel?: string;
  onMobileBack?: () => void;
}) {
  const permissionHistory = sessionHistory as Parameters<
    typeof FloatingPermissionRequest
  >[0]['sessionHistory'];
  const shouldShowComposer = !hasPendingAskUserQuestion(sessionStatus, permissionHistory);
  const infoBarPr = task.prUrl
    ? { url: task.prUrl, status: (task.prStatus ?? 'open') as PrStatus }
    : null;
  const diffStat =
    hasChanges && (task.addedLines || task.deletedLines)
      ? { add: task.addedLines ?? 0, del: task.deletedLines ?? 0 }
      : null;

  return (
    <div
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-background"
      style={{ '--conversation-top-inset': MOBILE_SESSION_HEADER_INSET } as React.CSSProperties}
    >
      <BaseHeader
        truncateTitle={false}
        hideMenuButton
        className="absolute inset-x-0 top-0 z-30 border-b-0 bg-background/55 backdrop-blur-xl"
        style={{ height: MOBILE_SESSION_HEADER_INSET }}
        leading={
          onMobileBack ? (
            <GlassIconButton label={mobileBackLabel ?? 'Back'} onClick={onMobileBack}>
              <ChevronLeft className="h-5 w-5" />
            </GlassIconButton>
          ) : null
        }
        title={
          /* Replica of session-detail.tsx's `MobileProjectInfo` (not exported):
             session title on the headline, the project/repo identity as the
             muted subtitle beneath it. */
          <span className="flex min-w-0 flex-col justify-center leading-tight">
            <span className="truncate text-[0.95rem] font-semibold text-foreground">
              {task.title}
            </span>
            {isPlainChatSession ? null : (
              <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <span className="inline-flex shrink-0 items-center">
                  {isLocalSession ? <Folder className="h-3 w-3" /> : <Github className="h-3 w-3" />}
                </span>
                <span className="truncate">{repoLabel}</span>
              </span>
            )}
          </span>
        }
        actions={
          <>
            <MobileSessionTabButton
              hasUnread={false}
              onOpen={() => undefined}
              ariaLabel={mobileSessionTabsLabel}
            />
            <GlassIconButton label={mobileMoreActionsLabel ?? 'More actions'}>
              <Ellipsis className="h-4 w-4" />
            </GlassIconButton>
          </>
        }
      />

      {/* Conversation — the REAL ai-gui renderer driven by mock history. */}
      <div className="min-h-0 flex-1">
        <SessionChatStreamView
          sessionId={PREVIEW_SESSION_ID}
          items={items}
          renderMessageRow={({ message, sessionId }) => (
            <MessageRowView message={message} sessionId={sessionId} user={chatUser} />
          )}
        />
      </div>

      <FloatingPermissionRequest
        sessionId={PREVIEW_SESSION_ID}
        sessionStatus={sessionStatus}
        sessionHistory={permissionHistory}
      />

      {shouldShowComposer ? (
        <>
          {/* Mobile gets the same info bar as desktop, minus the branch.
              SessionInfoBar already wraps its pill in ConversationColumn. */}
          <SessionInfoBar
            projectName={isPlainChatSession ? null : repoLabel}
            branch={null}
            workspaceLocation={isLocalSession ? { kind: 'worktree', path: null } : null}
            pr={infoBarPr}
            diffStat={diffStat}
            protectFromEdgeBackZone
          />
          {/* Full-bleed shell + ONE ConversationColumn — same as production
              SessionChatInputArea and the desktop preview. Do NOT put px-* on
              this shell: that double-gutters against ConversationColumn and
              makes the composer narrower than SessionInfoBar (visible on
              phone viewports where the column is px-3 and an outer px-4 was
              used previously). Home-indicator inset is simulated inside the
              device PNG via `--landing-phone-safe-bottom`. */}
          <div
            className={cn(
              'relative z-40 shrink-0 bg-background pt-0',
              'pb-[calc(0.5rem+var(--landing-phone-safe-bottom,34px))]'
            )}
          >
            <ConversationColumn>{composer}</ConversationColumn>
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---- Worktree demo (feature tab 1) ------------------------------------------
// A scripted "ghost user": a simulated cursor clicks through the REAL landing
// composer — Local project `lody` → workdir Local→Worktree → base branch `main` →
// types a prompt → sends — then the sidebar gains the new project/session, the
// view jumps to the session page, and the assistant reply streams in.

// Tab durations + the demo id union live in `landing-demo-durations.ts` so
// `underwater-experience.tsx` can build `TAB_DURATIONS` at module scope without
// importing this (lazily loaded) module. Re-exported here for existing callers.
export {
  DESIGN_DEMO_DURATION_MS,
  DIFF_DEMO_DURATION_MS,
  MOBILE_DEMO_DURATION_MS,
  WORKTREE_DEMO_DURATION_MS,
} from './landing-demo-durations';
// Brief flash only — long skeleton made the tab read as "diff never loaded".
const DIFF_SKELETON_MS = 90;

/** Design canvas of the desktop demo shell (must match CSS --ld-design-*). */
const LD_DESIGN_W = 1120;
const LD_DESIGN_H = 760;

/** Ken-burns style phone focus for the scaled desktop shell. */
type DemoFocusState = {
  /** Extra zoom on top of the fit scale (1 = no zoom). */
  scale: number;
  /** Focus point in design-space pixels (origin top-left of the 1120×760 shell). */
  fx: number;
  fy: number;
};

const DEMO_FOCUS_REST: DemoFocusState = {
  scale: 1,
  fx: LD_DESIGN_W / 2,
  fy: LD_DESIGN_H / 2,
};

/** Reliable design-space anchors when a DOM target is missing or mid-transition. */
const DEMO_FOCUS_ANCHORS = {
  worktreePill: { fx: 640, fy: 655, scale: 1.85 },
  composer: { fx: 700, fy: 690, scale: 1.65 },
  /* Lower in the main pane — empty scroll chrome sits above the bubbles. */
  sessionChat: { fx: 680, fy: 520, scale: 1.4 },
  rightPanel: { fx: 960, fy: 380, scale: 1.65 },
  diffViewer: { fx: 960, fy: 400, scale: 1.7 },
  browserPreview: { fx: 960, fy: 360, scale: 1.65 },
  annotateLine: { fx: 960, fy: 300, scale: 1.75 },
} as const;

function isPhoneDemoViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

/**
 * Map focus (fx,fy) + zoom into a stage-space translate/scale, clamping so the
 * original design's left/right (and top/bottom) edges never slide into the
 * stage interior — i.e. no empty gutter on one side while the opposite edge
 * has already left the frame.
 *
 * With transform-origin top-left: design (0,0) → (tx, ty), design (W,H) →
 * (tx + W·s, ty + H·s). Constraints:
 *   tx ≤ 0,  tx + W·s ≥ fitW
 *   ty ≤ 0,  ty + H·s ≥ fitH
 */
function resolveClampedFocusTransform(
  fitW: number,
  fitH: number,
  fx: number,
  fy: number,
  focusScale: number
): { tx: number; ty: number; totalS: number } {
  // Contain: fit the full 1120×760 canvas inside the stage (no crop at rest).
  const baseS = Math.min(fitW / LD_DESIGN_W, fitH / LD_DESIGN_H);
  const totalS = baseS * Math.max(1, focusScale);
  const scaledW = LD_DESIGN_W * totalS;
  const scaledH = LD_DESIGN_H * totalS;
  // Ideal: put design (fx,fy) at stage center.
  let tx = fitW / 2 - fx * totalS;
  let ty = fitH / 2 - fy * totalS;
  // When the scaled shell is smaller than the stage (letterbox), center it.
  // When larger (zoomed), clamp so original canvas edges never enter the interior.
  if (scaledW >= fitW - 0.5) {
    const minTx = fitW - scaledW;
    const maxTx = 0;
    tx = Math.min(maxTx, Math.max(minTx, tx));
  } else {
    tx = (fitW - scaledW) / 2;
  }
  if (scaledH >= fitH - 0.5) {
    const minTy = fitH - scaledH;
    const maxTy = 0;
    ty = Math.min(maxTy, Math.max(minTy, ty));
  } else {
    ty = (fitH - scaledH) / 2;
  }
  return { tx, ty, totalS };
}

/**
 * Gate for ghost pointer work. When false (stage mostly off-screen), clicks /
 * drags skip DOM interaction so they cannot scroll the landing page back to
 * the demo. State fallbacks still run so the timeline can idle forward.
 */
const ghostGateRef = { current: true };

/**
 * While ghost demos run, swallow programmatic scrollIntoView and force
 * preventScroll on focus. User wheel/touch scroll is unaffected — only the
 * APIs that pull the viewport to a focused/clicked node are blocked.
 */
function installDemoScrollGuards(): () => void {
  const proto = Element.prototype;
  const origScrollIntoView = proto.scrollIntoView;
  proto.scrollIntoView = function scrollIntoViewNoop(this: Element) {
    // no-op: ghost clicks / Radix focus must not yank the landing page
  };

  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focusNoScroll(
    this: HTMLElement,
    options?: FocusOptions | boolean
  ) {
    if (typeof options === 'boolean') {
      return origFocus.call(this, { preventScroll: true });
    }
    return origFocus.call(this, { ...options, preventScroll: true });
  };

  return () => {
    proto.scrollIntoView = origScrollIntoView;
    HTMLElement.prototype.focus = origFocus;
  };
}

/**
 * Ghost demos never call real focus() — browsers scroll focused nodes into view
 * and that yanks the landing page mid-scroll.
 *
 * Prefer synthetic pointer + MouseEvent over `el.click()` (which focuses and
 * can schedule async scrollIntoView). Sync scroll restore is belt-and-suspenders
 * only — deferred restore is intentionally NOT used (it fights user scroll).
 */
function clickQuiet(el: HTMLElement | null, action?: () => void) {
  if (!ghostGateRef.current) {
    // Off-stage: apply state only, no DOM pointer work.
    action?.();
    return;
  }
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  try {
    if (el) {
      const init: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
      };
      el.dispatchEvent(new PointerEvent('pointerdown', init));
      el.dispatchEvent(new PointerEvent('pointerup', init));
      // Avoid HTMLElement.click() — it focuses and often scrollIntoViews.
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  } catch {
    // demo theater — state fallbacks keep the flow going
  }
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
    window.scrollTo(scrollX, scrollY);
  }
  action?.();
}

/** Ghost-composer typing: snappy so the feature, not keystrokes, is the point. */
const DEMO_TYPE_MS_EN = 20;
const DEMO_TYPE_MS_ZH = 30;
/** Long prompts type a few chars per tick so walls of text don't eat the budget. */
function demoTypeChunk(textLength: number): number {
  if (textLength > 48) return 3;
  if (textLength > 22) return 2;
  return 1;
}
function demoTypeStepMs(locale: LandingLocale, textLength: number): number {
  const base = locale === 'zh' ? DEMO_TYPE_MS_ZH : DEMO_TYPE_MS_EN;
  return textLength > 40 ? Math.max(14, base - 4) : base;
}
/** Schedule progressive text into `apply(slice)`. Returns the end timestamp (ms). */
function scheduleTypedText(
  at: (ms: number, fn: () => void) => void,
  startMs: number,
  text: string,
  locale: LandingLocale,
  apply: (slice: string) => void
): number {
  const step = demoTypeStepMs(locale, text.length);
  const chunk = demoTypeChunk(text.length);
  let i = 0;
  let tick = 0;
  while (i < text.length) {
    i = Math.min(text.length, i + chunk);
    const end = i;
    at(startMs + tick * step, () => apply(text.slice(0, end)));
    tick += 1;
  }
  return startMs + Math.max(1, tick) * step;
}

// The GitHub worktree session the diff demo drills into (see taskSeeds).
const DIFF_DEMO_TASK_ID = 'task-1';
const DEMO_PROJECT_NAME = 'lody';
// Starts with 'local-' so the existing local-session branches (repo label, header
// icon) treat it exactly like a real local-project session.
const DEMO_TASK_ID = 'local-demo-intro';

const DEMO_COPY: Record<LandingLocale, { promptText: string; reply: string; branchLabel: string }> =
  {
    en: {
      promptText: 'Introduce Lody',
      branchLabel: 'Branch',
      reply: [
        'Lody is a local-first workspace for running coding agents:',
        '',
        '- **Parallel agents** — every task gets its own isolated git worktree, so multiple agents build side by side without stepping on each other.',
        '- **Live everywhere** — conversations, diffs, and terminal output sync in real time to desktop, browser, and phone.',
        '- **One control plane** — start, review, and merge agent work from any device.',
        '',
        'This session is running in a fresh worktree created from `main`, so nothing I do here touches your working directory.',
      ].join('\n'),
    },
    zh: {
      promptText: '介绍一下 Lody',
      branchLabel: '分支',
      reply: [
        'Lody 是一个本地优先的 AI 编程协作工作台：',
        '',
        '- **并行 Agent** — 每个任务都在独立的 git worktree 里进行，多个 Agent 同时开发互不干扰。',
        '- **实时同步** — 对话、diff、终端输出实时同步到桌面、浏览器和手机。',
        '- **统一控制面** — 在任何设备上启动、审查、合并 Agent 的工作。',
        '',
        '当前会话就运行在从 `main` 创建的全新 worktree 里，我在这里做的任何改动都不会影响你的工作目录。',
      ].join('\n'),
    },
  };

function buildDemoTask(locale: LandingLocale, isWorking: boolean): SessionListRow {
  return {
    sessionId: DEMO_TASK_ID,
    title: DEMO_COPY[locale].promptText,
    repoFullName: DEMO_PROJECT_NAME,
    branchName: 'main',
    latestMessageAt: now,
    addedLines: 0,
    deletedLines: 0,
    isWorking,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
  };
}

function buildDemoIntroHistory(
  locale: LandingLocale,
  stream: { text: string; done: boolean } | null
): SessionHistoryParsed[] {
  const d = DEMO_COPY[locale];
  const messages: SessionHistoryParsed[] = [
    previewUserMessage(`${DEMO_TASK_ID}-user`, d.promptText, '2026-07-04T02:10:00.000Z'),
  ];
  if (stream) {
    messages.push(
      previewAssistantMessage(
        `${DEMO_TASK_ID}-reply`,
        [{ type: 'text', text: stream.text }],
        '2026-07-04T02:10:06.000Z',
        { modelInfo: CODEX_PREVIEW_MODEL_INFO, finished: stream.done }
      )
    );
  }
  return messages;
}

// ---- Design-mode demo (feature tab 3) copy + history -------------------------

const DESIGN_DEMO_COPY: Record<
  LandingLocale,
  {
    prompt: string;
    turn2Intro: string;
    turn2Text: string;
    comment: string;
    turn3Intro: string;
    turn3Text: string;
  }
> = {
  en: {
    prompt: 'Start the landing page dev server and open it in the Lody browser.',
    turn2Intro:
      "I'll start the landing page dev server and report it as this session's preview candidate.",
    turn2Text: [
      'The dev server is up:',
      '',
      '- Local: **http://127.0.0.1:3002/**',
      "- Reported as this session's preview candidate via `lody_report_preview_candidate`.",
      '',
      'Click the Browser action above the composer to open it in Lody.',
    ].join('\n'),
    comment: 'Remove "desktop, browser, or phone"',
    turn3Intro: 'On it — removing that trailing phrase from the hero lead.',
    turn3Text:
      'Done. The hero lead no longer ends with `— desktop, browser, or phone.` — hot reload has already applied it, so the preview on the right is showing the updated copy.',
  },
  zh: {
    prompt: '启动 Lody Landing Page 的开发服务器，在 Lody 浏览器里打开。',
    turn2Intro: '我来启动 landing page 的开发服务器，并把它上报为当前会话的预览候选。',
    turn2Text: [
      '开发服务器已经启动：',
      '',
      '- 本地地址：**http://127.0.0.1:3002/**',
      '- 已通过 `lody_report_preview_candidate` 上报为当前会话的预览候选。',
      '',
      '点击输入框上方信息栏的浏览器按钮，即可在 Lody 中打开。',
    ].join('\n'),
    comment: '删除 desktop, browser, or phone',
    turn3Intro: '好的，我来把 hero 文案里的这段尾巴删掉。',
    turn3Text:
      '已完成。hero lead 不再以 `— desktop, browser, or phone.` 结尾 — 热更新已经生效，右侧预览里已经是新文案。',
  },
};

// The visual-annotation reference payload for the demo comment — shared by the
// composer's pending chip AND the sent user message's in-conversation card
// (ai-gui renderUserContent → VisualAnnotationReferenceCard), exactly like the
// real send flow which carries the same reference from staging into history.
function buildDesignAnnotationReference(locale: LandingLocale): VisualAnnotationReferencePayload {
  return {
    source: 'visual_annotation',
    commentId: 'design-comment-1',
    body: DESIGN_DEMO_COPY[locale].comment,
    authorName: 'Leon',
    status: 'completed',
    anchor: {
      version: 1,
      page: {
        url: 'http://127.0.0.1:3002/',
        pathname: '/',
        viewport: { width: 1280, height: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 2 },
      },
      click: {
        clientX: 640,
        clientY: 420,
        pageX: 640,
        pageY: 420,
        viewportXRatio: 0.5,
        viewportYRatio: 0.52,
      },
      target: {
        tag: 'p',
        attributes: {},
        text: 'Conversations, diffs, and previews stay in sync — desktop, browser, or phone.',
        rect: { x: 320, y: 400, width: 640, height: 24 },
        rectRatio: { x: 0.25, y: 0.5, width: 0.5, height: 0.03 },
        selector: 'main > section.hero > p:nth-of-type(2)',
      },
      context: { ancestors: [] },
    },
  };
}

// Mobile demo (feature tab 4): the jellyfish conversation, streamed. Reuses the
// existing task-5 session copy (whose image resolves via the image-cache shim to
// /landing/jellyfish.png).
function buildMobileJellyfishHistory(
  session: PreviewSessionCopy,
  turn: { text: string; image: boolean; done: boolean } | null
): SessionHistoryParsed[] {
  const messages: SessionHistoryParsed[] = [
    previewUserMessage('mobile-jelly-user', session.user, '2026-07-04T02:20:00.000Z'),
  ];
  if (turn && (turn.text || turn.image)) {
    const items: SessionHistoryParsed['items'] = [];
    if (turn.text) items.push({ type: 'text', text: turn.text });
    if (turn.image && session.image) {
      items.push({
        type: 'image_group',
        images: [session.image],
      } as unknown as SessionHistoryParsed['items'][number]);
    }
    messages.push(
      previewAssistantMessage('mobile-jelly-reply', items, '2026-07-04T02:20:06.000Z', {
        modelInfo: CODEX_PREVIEW_MODEL_INFO,
        finished: turn.done,
      })
    );
  }
  return messages;
}

// Progress of the two scripted design-demo turns; drives buildDesignDemoHistory.
type DesignDemoTurns = {
  turn2User: boolean;
  turn2: { devDone: boolean; reportDone: boolean; text: string; done: boolean } | null;
  turn3User: boolean;
  turn3: { editDone: boolean; text: string; done: boolean } | null;
};

const INITIAL_DESIGN_TURNS: DesignDemoTurns = {
  turn2User: false,
  turn2: null,
  turn3User: false,
  turn3: null,
};

function buildDesignDemoHistory(
  locale: LandingLocale,
  turns: DesignDemoTurns
): SessionHistoryParsed[] {
  const d = DESIGN_DEMO_COPY[locale];
  // Starts from tab-1's completed intro conversation.
  const messages = buildDemoIntroHistory(locale, {
    text: DEMO_COPY[locale].reply,
    done: true,
  });
  if (turns.turn2User) {
    messages.push(
      previewUserMessage(`${DEMO_TASK_ID}-design-user`, d.prompt, '2026-07-04T02:14:00.000Z')
    );
  }
  if (turns.turn2) {
    const items: SessionHistoryParsed['items'] = [
      { type: 'text', text: d.turn2Intro },
      previewToolCall(
        'execute',
        'pnpm dev --filter @lody/landing',
        'design-dev-server',
        undefined,
        turns.turn2.devDone ? 'completed' : 'in_progress'
      ),
    ];
    if (turns.turn2.devDone) {
      // The real MCP tool the CLI exposes for this (lody-mcp-server.ts).
      items.push(
        previewToolCall(
          'other',
          'lody_report_preview_candidate (MCP)',
          'design-report-preview',
          undefined,
          turns.turn2.reportDone ? 'completed' : 'in_progress'
        )
      );
    }
    if (turns.turn2.text) {
      items.push({ type: 'text', text: turns.turn2.text });
    }
    messages.push(
      previewAssistantMessage(`${DEMO_TASK_ID}-design-reply`, items, '2026-07-04T02:14:06.000Z', {
        modelInfo: CODEX_PREVIEW_MODEL_INFO,
        finished: turns.turn2.done,
      })
    );
  }
  if (turns.turn3User) {
    // Sent from the staged chip: the user message carries the visual-annotation
    // reference block (rendered as the app's VisualAnnotationReferenceCard),
    // not plain prompt text — mirroring the real send flow.
    messages.push({
      id: `${DEMO_TASK_ID}-design-user-edit`,
      role: 'user',
      timestamp: '2026-07-04T02:15:30.000Z',
      read: true,
      userId: 'preview-user',
      status: 'handled',
      finished: true,
      items: [
        {
          type: 'visual_annotation_reference',
          ...buildDesignAnnotationReference(locale),
        },
      ],
    } as unknown as SessionHistoryParsed);
  }
  if (turns.turn3) {
    const items: SessionHistoryParsed['items'] = [
      { type: 'text', text: d.turn3Intro },
      previewToolCall(
        'edit',
        locale === 'zh'
          ? '修改 apps/landing/src/components/hero.tsx'
          : 'Edit apps/landing/src/components/hero.tsx',
        'design-edit-hero',
        undefined,
        turns.turn3.editDone ? 'completed' : 'in_progress'
      ),
    ];
    if (turns.turn3.text) {
      items.push({ type: 'text', text: turns.turn3.text });
    }
    messages.push(
      previewAssistantMessage(
        `${DEMO_TASK_ID}-design-reply-edit`,
        items,
        '2026-07-04T02:15:36.000Z',
        { modelInfo: CODEX_PREVIEW_MODEL_INFO, finished: turns.turn3.done }
      )
    );
  }
  return messages;
}

export function LandingAppPreview({
  locale,
  demo = null,
  ghostEnabled = true,
}: {
  locale: LandingLocale;
  /** Scripted scenario for the active feature tab; null = static open session. */
  demo?: LandingDemo;
  /**
   * When false, ghost cursor clicks/drags are suppressed (stage mostly off-screen).
   * Demo state may still advance via fallbacks; the page scroll is never yanked.
   */
  ghostEnabled?: boolean;
}) {
  const t = copy[locale];
  const isWorktreeDemo = demo === 'worktree';
  const isDiffDemo = demo === 'diff';
  const isDesignDemo = demo === 'design';
  const isMobileDemo = demo === 'mobile';
  const isDemo = isWorktreeDemo || isDiffDemo || isDesignDemo || isMobileDemo;
  // Module gate read by clickQuiet / drag helpers without prop-drilling timers.
  ghostGateRef.current = Boolean(ghostEnabled && isDemo);
  /* Each feature tab must open on production's DEFAULT split. The resizable
     layout only honours `defaultSizes` at MOUNT and otherwise restores its
     `autoSaveId` entry, so a tab that drags the handle (diff, design) would
     otherwise hand the next tab its widened panel — that is how the design
     demo ended up starting from the diff demo's ~40% split and squeezing the
     conversation into a column. Clear the stored layout during RENDER (before
     the layout below mounts and reads it) and remount via `layoutKey`; the
     demos' own cleanup calls stop a widened split from outliving the page. */
  const lastDemoRef = useRef<typeof demo | 'init'>('init');
  if (lastDemoRef.current !== demo) {
    lastDemoRef.current = demo;
    clearPanelLayoutStorage();
  }
  const layoutKey = demo ?? 'static';
  const [isMounted, setIsMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [activeNav, setActiveNav] = useState<LoroSidebarNavKey>('home');
  const workspaceId = 'workspace-lody';
  // Boot on the chat landing (Local mode, project lody) — the same frame tab-0's
  // worktree demo opens on — so the dot-filter reveal and the first demo start
  // from an identical screen instead of flashing from an open session.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeSessionTabId, setActiveSessionTabId] = useState<SessionId | null>(null);
  const [repos, setRepos] = useState<SessionListRepoState[]>(initialRepos);
  const [tasks, setTasks] = useState<SessionListRow[]>(() => buildTasks(copy[locale]));
  const [localSessions, setLocalSessions] = useState<SessionListRow[]>(() =>
    buildLocalSessions(copy[locale])
  );
  const [localProjectsSectionCollapsed, setLocalProjectsSectionCollapsed] = useState(false);
  const [localProjectCollapsed, setLocalProjectCollapsed] = useState(false);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [reply, setReply] = useState('');
  const [selectedMachine, setSelectedMachine] = useState<string | null>('mac-studio');
  const [selectedAgent, setSelectedAgent] = useState<string | null>('codex');
  const [selectedRepo, setSelectedRepo] = useState<string | null>('loro-dev/lody');
  const [selectedLocalProject, setSelectedLocalProject] = useState<string | null>(
    DEMO_PROJECT_NAME
  );
  const [selectedModel, setSelectedModel] = useState<string | null>('gpt-5.5');
  const [contextType, setContextType] = useState<SessionContextType>('local');
  const [selectedPermissionMode, setSelectedPermissionMode] = useState('default');
  // ---- worktree-demo state (driven by the scripted timeline below) ----------
  const [workdirMode, setWorkdirMode] = useState<'local' | 'worktree'>('local');
  // Real chat landing preselects the project's current branch.
  const [selectedBranch, setSelectedBranch] = useState<string | null>('main');
  const [demoTask, setDemoTask] = useState<SessionListRow | null>(null);
  const [demoStream, setDemoStream] = useState<{ text: string; done: boolean } | null>(null);
  const [demoCursor, setDemoCursor] = useState<{
    x: number;
    y: number;
    visible: boolean;
    pulse: number;
    /** Skip glide for tiny post-zoom corrections so they don't look like a second hop. */
    instant?: boolean;
  }>({ x: 0, y: 0, visible: false, pulse: 0, instant: false });
  /** Phone-only Ken Burns: extra scale + pan so key beats stay readable. */
  const [demoFocus, setDemoFocus] = useState<DemoFocusState>(DEMO_FOCUS_REST);
  const demoFocusRef = useRef(demoFocus);
  demoFocusRef.current = demoFocus;
  /** Auto zoom-out timer for `focusDemo` — never leave a stale close-up. */
  const demoFocusHoldTimerRef = useRef<number | null>(null);
  /** Measured stage size for JS edge-clamped pan (CSS clamp is unreliable with cqw). */
  const [demoStageSize, setDemoStageSize] = useState({ w: 0, h: 0 });
  const demoStageRef = useRef<HTMLDivElement | null>(null);
  // ---- diff-demo state (feature tab 2; driven by its scripted timeline) ------
  const [diffSecondaryOpen, setDiffSecondaryOpen] = useState(false);
  // The panel opens straight to Changes (no Files-then-click).
  const [diffPanelTab, setDiffPanelTab] = useState<'files' | 'changes' | 'pr'>('changes');
  const [diffViewer, setDiffViewer] = useState<'hidden' | 'skeleton' | 'shown'>('hidden');
  // ---- design-demo state (feature tab 3; driven by its scripted timeline) ----
  const [designTurns, setDesignTurns] = useState<DesignDemoTurns>(INITIAL_DESIGN_TURNS);
  const [designPreview, setDesignPreview] = useState<LandingPreviewDemoState>(
    INITIAL_LANDING_PREVIEW_STATE
  );
  const [designPreviewAvailable, setDesignPreviewAvailable] = useState(false);
  const [designPreviewOpen, setDesignPreviewOpen] = useState(false);
  // "Send" on the saved preview comment stages it in the composer as the app's
  // real pending-reference chip (VisualAnnotationReferenceChip), not plain text.
  const [designStagedRef, setDesignStagedRef] = useState(false);
  const designAnnotationItems = useMemo<VisualAnnotationReferenceChipItem[]>(() => {
    if (!isDesignDemo || !designStagedRef) return [];
    return [{ localId: 'design-annotation-1', reference: buildDesignAnnotationReference(locale) }];
  }, [designStagedRef, isDesignDemo, locale]);
  // ---- mobile-demo state (feature tab 4; driven by its scripted timeline) ----
  const [mobileStage, setMobileStage] = useState<{
    narrowed: boolean;
    screen: MobileDemoScreen;
  }>({ narrowed: true, screen: 'home' });
  const [mobileTurn, setMobileTurn] = useState<{
    text: string;
    image: boolean;
    done: boolean;
  } | null>(null);
  // Opening a changed file reveals the All-Changes viewer: a brief skeleton, then
  // the real diff. Keep DIFF_SKELETON_MS tiny so the live review is the point.
  const diffSkeletonTimer = useRef<number | null>(null);
  const handleDiffOpenFile = useCallback(() => {
    if (DIFF_SKELETON_MS <= 0) {
      setDiffViewer('shown');
      return;
    }
    setDiffViewer('skeleton');
    if (diffSkeletonTimer.current) window.clearTimeout(diffSkeletonTimer.current);
    diffSkeletonTimer.current = window.setTimeout(() => {
      setDiffViewer('shown');
      diffSkeletonTimer.current = null;
    }, DIFF_SKELETON_MS);
  }, []);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const previewStore = useMemo(() => {
    const store = createStore();
    store.set(currentWorkspaceIdAtom, 'workspace-lody' as WorkspaceId);
    store.set(authTokenAtom, 'landing-preview-token');
    store.set(runtimeAtom, createLandingPreviewRuntime('workspace-lody' as WorkspaceId));
    // `DesktopRunConfigMenu` lists agents from `getAllAgentConfigAtom` scoped to
    // the online machines. Both sources are seeded here: the agent cache is a
    // plain atom, and `@/hooks/use-online-machines` is aliased to a preview shim
    // (the real hook needs Convex) that reads `landingPreviewMachinesAtom`.
    store.set(agentConfigMetaCacheAtom, buildPreviewAgentConfigs());
    store.set(landingPreviewMachinesAtom, PREVIEW_MACHINES);
    return store;
  }, []);
  const [configValues, setConfigValues] = useState<Record<string, AcpConfigOptionValue>>({
    reasoning_effort: 'medium',
    [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
    [CODEX_FAST_MODE_CONFIG_ID]: false,
  });

  // Block programmatic scrollIntoView / focus-scroll for the whole demo lifetime
  // (including while the user has scrolled the stage half off-screen).
  useEffect(() => {
    if (!isDemo) return undefined;
    return installDemoScrollGuards();
  }, [isDemo]);

  // Hide the ghost disc when interactions are gated off.
  useEffect(() => {
    if (ghostEnabled) return;
    setDemoCursor((c) => (c.visible ? { ...c, visible: false } : c));
  }, [ghostEnabled]);

  // Follow the site theme toggle: Fumadocs flips `.dark` on <html>, which also
  // drives the scoped `.lody-app-preview` tokens and the components' `dark:` variants.
  // We mirror it into `tone` for the few components that switch styling via prop.
  useEffect(() => {
    setIsMounted(true);
    // Populate the command registry so the composer's ⌘L focus-hint chip renders
    // (the real app does this in AppInitializer; idempotent per-id stacks).
    registerBuiltInCommands();
    const root = document.documentElement;
    const sync = () => setIsDark(root.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    const cancelWarm = warmDemoImages();
    return () => {
      observer.disconnect();
      cancelWarm();
    };
  }, []);

  // Re-localize the demo i18n + seeded copy whenever the page locale changes.
  useEffect(() => {
    void demoI18n.changeLanguage(locale === 'zh' ? 'zh_CN' : 'en');
    setTasks(buildTasks(copy[locale]));
    setLocalSessions(buildLocalSessions(copy[locale]));
  }, [locale]);

  const selectedProvider: PreviewProvider = selectedAgent === 'claude' ? 'claude' : 'codex';

  useEffect(() => {
    const modelIds = Object.keys(t.models[selectedProvider]);
    if (!selectedModel || !modelIds.includes(selectedModel)) {
      setSelectedModel(modelIds[0] ?? null);
    }

    const thinkValues = Object.keys(t.config.think[selectedProvider]);
    const currentThinkValue = configValues.reasoning_effort;
    if (typeof currentThinkValue !== 'string' || !thinkValues.includes(currentThinkValue)) {
      setConfigValues((prev) => ({
        ...prev,
        reasoning_effort: thinkValues.includes('medium') ? 'medium' : (thinkValues[0] ?? 'low'),
      }));
    }

    if (selectedProvider === 'claude') {
      setConfigValues((prev) => ({
        ...prev,
        [CODEX_COLLABORATION_MODE_CONFIG_ID]: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
        [CODEX_FAST_MODE_CONFIG_ID]: false,
      }));
    }
  }, [configValues.reasoning_effort, selectedModel, selectedProvider, t]);

  const tone: 'light' | 'dark' = isDark ? 'dark' : 'light';
  const selectorContentClassName =
    tone === 'dark' ? 'lody-app-preview-portal-dark' : 'lody-app-preview-portal-light';
  const getSelectorContentClassName = (className?: string) =>
    cn(selectorContentClassName, className);
  // Outer embed chrome. On the underwater stage the card plate is killed (see
  // underwater-reveal CSS + mobile classes below) so switching to the phone demo
  // never flashes a full-size bg-background rect over the point cloud.
  const shellClassName = cn(
    'lody-app-preview overflow-hidden text-foreground',
    isMobileDemo
      ? 'rounded-none border-0 bg-transparent shadow-none'
      : 'rounded-lg border bg-background shadow-2xl border-slate-200/80 shadow-slate-400/25 dark:border-white/10 dark:shadow-cyan-950/30'
  );

  const machineOptions = useMemo<OptionSelectorOption<string>[]>(
    () => [
      { value: 'mac-studio', label: t.machines['mac-studio'] },
      { value: 'mbp', label: t.machines.mbp },
    ],
    [t]
  );

  // Mock branch list for the real BranchSelector in the top row (demo picks main).
  const branchOptions = useMemo(
    () => [
      { value: 'main', label: 'main' },
      { value: 'develop', label: 'develop' },
    ],
    []
  );

  /* Sources for the unified project picker in the landing top row. The demo
     keeps the project id == its name so the scripted cursor can aim by text. */
  const unifiedLocalProjects = useMemo<UnifiedLocalProjectOption[]>(
    () =>
      [DEMO_PROJECT_NAME, ...t.localProjectNames].map((name, index) => ({
        key: `mac-studio:${name}`,
        machineId: 'mac-studio',
        localProjectId: name,
        name,
        rootPath: `~/code/${name}`,
        lastUsedAt: now - index * 60_000,
      })),
    [t]
  );

  const unifiedRepositories = useMemo(
    () => [{ fullName: 'loro-dev/lody', description: t.repos['loro-dev/lody'] }],
    [t]
  );

  const modelOptions = useMemo<AcpSessionSelectOption[]>(
    () =>
      (Object.entries(t.models[selectedProvider]) as [string, LabelDesc][]).map(
        ([value, [label, description]]) => ({
          value,
          label,
          description,
        })
      ),
    [selectedProvider, t]
  );

  const configOptionSelectors = useMemo<AcpConfigOptionSelector[]>(() => {
    const selectors: AcpConfigOptionSelector[] = [
      {
        configId: 'reasoning_effort',
        label: t.config.thinkLevel,
        category: 'thought_level',
        type: 'select',
        currentValue: 'medium',
        options: (Object.entries(t.config.think[selectedProvider]) as [string, LabelDesc][]).map(
          ([value, [label, description]]) => ({
            value,
            label,
            description,
          })
        ),
      },
    ];

    if (selectedProvider === 'codex') {
      selectors.push(
        {
          configId: CODEX_COLLABORATION_MODE_CONFIG_ID,
          label: t.config.planMode,
          category: CODEX_COLLABORATION_MODE_CONFIG_ID,
          type: 'select',
          currentValue: CODEX_COLLABORATION_MODE_DEFAULT_VALUE,
          options: [
            { value: CODEX_COLLABORATION_MODE_DEFAULT_VALUE, label: 'Default' },
            { value: CODEX_COLLABORATION_MODE_PLAN_VALUE, label: t.config.planMode },
          ],
        },
        {
          configId: CODEX_FAST_MODE_CONFIG_ID,
          label: t.config.fastMode,
          type: 'boolean',
          currentValue: false,
          options: [],
        }
      );
    }

    return selectors;
  }, [selectedProvider, t]);

  const archiveTask = useCallback((taskId: string) => {
    setTasks((prev) => prev.filter((task) => task.sessionId !== taskId));
    setSelectedTaskId((prev) => (prev === taskId ? null : prev));
  }, []);

  const chatTasks = useMemo(() => tasks.filter((task) => !task.repoFullName), [tasks]);
  const githubTasks = useMemo(() => tasks.filter((task) => task.repoFullName), [tasks]);

  const chatSessionListProps = useMemo<SessionListProps>(
    () => ({
      sessions: chatTasks,
      repos: [],
      chatsCollapsed,
      selectedSessionId: selectedTaskId,
      onSelect: setSelectedTaskId,
      onToggleChatsCollapsed: () => setChatsCollapsed((prev) => !prev),
      onArchiveSession: archiveTask,
      onNew: () => setSelectedTaskId(null),
    }),
    [archiveTask, chatTasks, chatsCollapsed, selectedTaskId]
  );

  const githubSessionListProps = useMemo<SessionListProps>(
    () => ({
      sessions: githubTasks,
      repos,
      selectedSessionId: selectedTaskId,
      onSelect: setSelectedTaskId,
      onToggleRepoCollapsed: (repoFullName) => {
        setRepos((prev) =>
          prev.map((repo) =>
            repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo
          )
        );
      },
      onArchiveSession: archiveTask,
      onNew: () => setSelectedTaskId(null),
      onMoveRepo: (move: SessionListRepoMove) => setRepos(move.nextRepos),
    }),
    [archiveTask, githubTasks, repos, selectedTaskId]
  );

  const sidebarLabels = useMemo(
    () => ({
      home: t.sidebar.home,
      docs: t.sidebar.docs,
      feedback: t.sidebar.feedback,
      myChats: t.sidebar.myChats,
      teamChats: t.sidebar.teamChats,
      onlyChats: t.sidebar.onlyChats,
      switchWorkspace: t.sidebar.switchWorkspace,
      createWorkspace: t.sidebar.createWorkspace,
      inviteMembers: t.sidebar.inviteMembers,
      connectGithubRepo: t.sidebar.connectGithubRepo,
    }),
    [t]
  );

  // Local Projects section — mirror LoroAppSidebar's real structure:
  // SidebarSectionHeader -> LocalProjectItem -> LocalProjectSessionItem rows.
  // Rejected: wrapping the session list in a glass/bordered card makes local
  // project sessions look like GitHub SessionList groups, which the app does not do.
  const localProjectName = t.localProjectNames[0] ?? 'lody-feedback';
  const localProjectsNode = (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <div className="group flex h-7 items-center gap-1 rounded-md pr-2">
          <button
            type="button"
            aria-expanded={!localProjectsSectionCollapsed}
            aria-label={t.sidebar.localProjects}
            onClick={() => setLocalProjectsSectionCollapsed((prev) => !prev)}
            className="relative flex h-7 min-w-0 flex-1 select-none items-center gap-1 rounded-md border border-transparent bg-transparent px-2 text-left text-xs font-semibold text-sidebar-foreground-muted/65 transition-colors hover:text-sidebar-foreground-muted focus-visible:shadow-none"
          >
            <span className="min-w-0 truncate">{t.sidebar.localProjects}</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-current opacity-0 transition-[opacity,translate,scale] duration-150 ease-out group-hover:opacity-100',
                localProjectsSectionCollapsed ? 'rotate-90' : 'rotate-0'
              )}
              aria-hidden="true"
            />
            <span className="flex-1" aria-hidden="true" />
          </button>
        </div>

        {localProjectsSectionCollapsed ? null : (
          <div className="space-y-1">
            {demoTask ? (
              // Worktree demo: the freshly-created `lody` project + its session,
              // mirroring the project-group structure below (appears on send).
              <div className="space-y-0.5">
                <div className="group flex items-center">
                  <div className="group relative flex w-full min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-md border border-transparent bg-transparent py-1 pl-2 pr-3 text-left text-xs font-semibold text-sidebar-foreground-muted/65">
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                      <Folder className="absolute h-3.5 w-3.5 text-current opacity-80" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{DEMO_PROJECT_NAME}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={demoTask.title}
                    className={cn(
                      'group w-full rounded-md border border-transparent bg-transparent py-1.5 pl-2 pr-3 text-left',
                      selectedTaskId === demoTask.sessionId
                        ? 'border-sidebar-border/70 bg-sidebar-selection text-sidebar-selection-foreground outline outline-1 outline-sidebar-ring/20'
                        : 'text-sidebar-foreground hover:bg-sidebar-hover hover:text-sidebar-hover-foreground'
                    )}
                    onClick={() => setSelectedTaskId(demoTask.sessionId)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      setSelectedTaskId(demoTask.sessionId);
                    }}
                  >
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 flex h-4 w-4 items-center justify-center">
                        {demoTask.isWorking ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="min-w-0 flex-1 truncate text-sm text-current">
                            <span className="truncate">{demoTask.title}</span>
                          </div>
                          <span className="ml-auto shrink-0 select-none text-xs tabular-nums text-muted-foreground">
                            now
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="space-y-0.5">
              <div className="group flex items-center">
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={!localProjectCollapsed}
                  aria-label={localProjectName}
                  className="group relative flex w-full min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-md border border-transparent bg-transparent py-1 pl-2 pr-3 text-left text-xs font-semibold text-sidebar-foreground-muted/65 transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
                  onClick={() => setLocalProjectCollapsed((prev) => !prev)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setLocalProjectCollapsed((prev) => !prev);
                  }}
                >
                  <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                    <Folder className="absolute h-3.5 w-3.5 text-current opacity-80 transition-opacity duration-100 group-hover:opacity-0" />
                    <ChevronDown
                      className={cn(
                        'absolute h-4 w-4 text-current opacity-0 transition-[opacity,translate,scale] duration-100 group-hover:opacity-100',
                        localProjectCollapsed ? '-rotate-90' : 'rotate-0'
                      )}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{localProjectName}</span>
                  {localProjectCollapsed ? (
                    <span className="select-none text-[11px] font-semibold tabular-nums text-muted-foreground/80">
                      {localSessions.length}
                    </span>
                  ) : null}
                </div>
              </div>

              {localProjectCollapsed ? null : (
                <div className="flex flex-col gap-1">
                  {localSessions.map((item, index) => {
                    const isSelected = selectedTaskId === item.sessionId;
                    const seed = localSessionSeeds[index];
                    return (
                      <div
                        key={item.sessionId}
                        role="button"
                        tabIndex={0}
                        aria-label={item.title}
                        className={cn(
                          'group w-full rounded-md border border-transparent bg-transparent py-1.5 pl-2 pr-3 text-left',
                          !isSelected &&
                            'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground',
                          isSelected &&
                            'border-sidebar-border/70 bg-sidebar-selection text-sidebar-selection-foreground outline outline-1 outline-sidebar-ring/20 hover:bg-sidebar-selection',
                          isSelected
                            ? 'text-sidebar-selection-foreground'
                            : 'text-sidebar-foreground'
                        )}
                        onClick={() => setSelectedTaskId(item.sessionId)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          setSelectedTaskId(item.sessionId);
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 flex h-4 w-4 items-center justify-center" />
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-start gap-3">
                              <div className="min-w-0 flex-1 truncate text-sm text-current">
                                <span className="truncate">{item.title}</span>
                              </div>
                              <span className="ml-auto shrink-0 select-none text-xs tabular-nums text-muted-foreground">
                                {seed?.ageLabel ?? ''}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const sidebarTopContent = (
    <div className="space-y-3">
      {localProjectsNode}
      <SessionList {...chatSessionListProps} />
      {githubTasks.length ? (
        <div className="px-2 text-xs font-semibold text-sidebar-foreground-muted/65">
          {t.sidebar.githubRepos}
        </div>
      ) : null}
    </div>
  );

  /* Top selector row — 1:1 with chat-landing.tsx's topSelectorNode. The
     Local / GitHub / Chat `ContextSwitch` is GONE from the desktop landing;
     one `UnifiedProjectSelector` now lists local projects and GitHub repos
     together and derives the context type from what you pick (clearing it
     back to "no project" is the plain-chat context). */
  const projectSelection = useMemo<UnifiedProjectSelection>(() => {
    if (contextType === 'local' && selectedLocalProject) {
      return {
        kind: 'local',
        machineId: selectedMachine ?? 'mac-studio',
        localProjectId: selectedLocalProject,
      };
    }
    if (contextType === 'github' && selectedRepo) {
      return { kind: 'github', repoFullName: selectedRepo };
    }
    return { kind: 'none' };
  }, [contextType, selectedLocalProject, selectedMachine, selectedRepo]);

  const projectSelectorNode = (
    <UnifiedProjectSelectorView
      value={projectSelection}
      onChange={(selection) => {
        if (selection.kind === 'none') {
          setContextType('chat');
          return;
        }
        if (selection.kind === 'github') {
          setSelectedRepo(selection.repoFullName);
          setContextType('github');
          return;
        }
        setSelectedLocalProject(selection.localProjectId);
        setContextType('local');
      }}
      localProjects={unifiedLocalProjects}
      repositories={unifiedRepositories}
      onAddLocalProject={() => undefined}
      onConnectGitRepo={() => undefined}
    />
  );

  /* Desktop top scope row — ordered machine → project → worktree/branch, the
     same order chat-landing.tsx's `topSelectorNode` uses now that the composer
     bottom bar is gone. */
  const machineMenuNode = (
    <DesktopMachineMenu
      value={(selectedMachine ?? null) as MachineId | null}
      options={machineOptions.map((option) => ({
        value: option.value as MachineId,
        label: option.label,
      }))}
      onChange={(value) => setSelectedMachine(value)}
    />
  );

  /* Branch + worktree share ONE rounded pill, exactly as chat-landing.tsx's
     `branchWorktreePill` composes them. The standalone workdir DROPDOWN is gone
     from production — worktree is a checkbox pill now. */
  const branchWorktreePill =
    contextType === 'chat' ? null : (
      <div className="flex h-6 min-w-0 max-w-full items-center overflow-hidden rounded-md bg-input/60 dark:bg-foreground/[0.08]">
        <span className="inline-flex min-w-0 items-center" data-demo="branch">
          <BranchSelector
            value={selectedBranch}
            onChange={setSelectedBranch}
            options={branchOptions}
            tone={tone}
            placeholder={DEMO_COPY[locale].branchLabel}
            className="[&_span]:text-xs [&_span]:leading-tight"
            contentClassName={getSelectorContentClassName()}
          />
        </span>
        {contextType === 'local' ? (
          <>
            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
            <span data-demo="workdir" className="inline-flex shrink-0">
              <WorktreeCheckboxPill
                checked={workdirMode === 'worktree'}
                onCheckedChange={(checked) => setWorkdirMode(checked ? 'worktree' : 'local')}
                className="h-6 rounded-none bg-transparent px-2 text-foreground/80 hover:bg-foreground/[0.06]"
              />
            </span>
          </>
        ) : null}
      </div>
    );

  /* The project picker is always mounted now (it is also how you get BACK to a
     project after clearing to plain chat), so the row no longer forks on
     `contextType` — only the branch/worktree pill does. */
  const topSelector = (
    <div className="flex w-full min-w-0 items-center gap-2">
      {machineMenuNode}
      {projectSelectorNode}
      {branchWorktreePill}
    </div>
  );

  // Permission ("Agent") modes shown by the footer permission button.
  // Permission modes as the agent reports them (labels are agent-provided English,
  // matching the real app; only descriptions localize).
  const permissionModeOptions = useMemo<AcpSessionSelectOption[]>(
    () =>
      locale === 'zh'
        ? [
            {
              value: 'default',
              label: 'Agent (full access)',
              description: '自主执行，拥有完整访问权限。',
            },
            { value: 'acceptEdits', label: 'Agent', description: '自动执行，必要时请求权限。' },
            { value: 'read-only', label: 'Read Only', description: '只读，不修改文件。' },
          ]
        : [
            {
              value: 'default',
              label: 'Agent (full access)',
              description: 'Runs autonomously with full access.',
            },
            {
              value: 'acceptEdits',
              label: 'Agent',
              description: 'Runs autonomously, asks when it needs permission.',
            },
            {
              value: 'read-only',
              label: 'Read Only',
              description: 'Read-only, never edits files.',
            },
          ],
    [locale]
  );

  /* Composer footer — 1:1 with chat-landing.tsx / session-chat-input-area.tsx:
     TWO desktop buttons, run config (agent + model + reasoning submenus, plus
     Plan/Fast toggles) then permission mode. The old agent + model + think chip
     row is gone, and so is the whole bottom bar. */
  const footerSelector = (
    <div className="contents">
      <DesktopRunConfigMenu
        agentSelection={
          selectedAgent ? { agentId: selectedAgent, machineId: selectedMachine as MachineId } : null
        }
        allowedMachineIds={selectedMachine ? [selectedMachine as MachineId] : undefined}
        fallbackAgent={{ cliType: 'codex', agentType: 'codex' }}
        onAgentConfigChange={(selection) => setSelectedAgent(selection.agentId)}
        modelOptions={modelOptions}
        selectedModelId={selectedModel}
        onModelChange={setSelectedModel}
        configOptionSelectors={configOptionSelectors}
        configOptionValues={configValues}
        onConfigOptionChange={(configId, value) =>
          setConfigValues((prev) => ({ ...prev, [configId]: value }))
        }
      />
      <DesktopPermissionModeButton
        modeOptions={permissionModeOptions}
        selectedModeId={selectedPermissionMode}
        onModeChange={setSelectedPermissionMode}
        configOptionSelectors={configOptionSelectors}
        configOptionValues={configValues}
        onConfigOptionChange={(configId, value) =>
          setConfigValues((prev) => ({ ...prev, [configId]: value }))
        }
      />
    </div>
  );

  /* The composer bottom bar is gone in production (`bottomBarNode = null` in
     chat-landing.tsx): machine identity moved up into the top selector row and
     the permission mode into the footer. */

  const goToDocs = () => {
    window.location.assign(t.docsPath);
  };

  const allSelectableTasks = useMemo(
    () => [...(demoTask ? [demoTask] : []), ...tasks, ...localSessions],
    [demoTask, tasks, localSessions]
  );
  const mobileConversationTasks = useMemo(
    () =>
      [...(demoTask ? [demoTask] : []), ...chatTasks, ...localSessions, ...githubTasks].sort(
        (a, b) => getTaskTimestamp(b.latestMessageAt) - getTaskTimestamp(a.latestMessageAt)
      ),
    [demoTask, chatTasks, githubTasks, localSessions]
  );
  const mobileHomeMachines = useMemo<MobileHomeMachine[]>(
    () => [
      { id: 'mac-studio', name: t.machines['mac-studio'], isOnline: true },
      { id: 'mbp', name: t.machines.mbp, isOnline: true },
    ],
    [t.machines]
  );
  const mobileHomeLocalProjects = useMemo<MobileHomeLocalProject[]>(
    () => [
      {
        id: 'lody-feedback',
        machineId: 'mac-studio',
        name: 'lody-feedback',
        path: '~/code/lody-feedback',
        conversationCount: localSessions.length,
        latestMessageAt: localSessions[0]?.latestMessageAt
          ? getTaskTimestamp(localSessions[0].latestMessageAt)
          : null,
      },
    ],
    [localSessions]
  );
  const mobileHomeGitHubRepositories = useMemo<MobileHomeGitHubRepository[]>(
    () => [
      {
        id: 'loro-dev/lody',
        name: 'lody',
        fullName: 'loro-dev/lody',
        ownerHandle: 'loro-dev',
        ownerAvatarUrl: 'https://github.com/loro-dev.png?size=64',
        description: t.repos['loro-dev/lody'],
        conversationCount: githubTasks.filter((task) => task.repoFullName === 'loro-dev/lody')
          .length,
        latestMessageAt:
          githubTasks
            .filter((task) => task.repoFullName === 'loro-dev/lody')
            .map((task) => getTaskTimestamp(task.latestMessageAt))
            .sort((a, b) => b - a)[0] ?? null,
      },
    ],
    [githubTasks, t.repos]
  );
  const mobileHomeConversations = useMemo<MobileConversationItem[]>(
    () => mobileConversationTasks.map(buildPreviewMobileConversation),
    [mobileConversationTasks]
  );
  const mobileHomeLabels = useMemo<MobileHomeScreenLabels>(
    () => ({
      switchWorkspace: t.sidebar.switchWorkspace,
      projectsTab: t.mobile.projects,
      localTab: t.contextSwitch.local,
      githubTab: t.contextSwitch.github,
      chatTab: t.contextSwitch.chat,
      allChatsHeading: t.mobile.allChats,
      searchPlaceholder: t.mobile.searchConversations,
      searchAriaLabel: t.mobile.search,
      clearSearchAriaLabel: t.mobile.clear,
      emptyChats: t.mobile.emptyChats,
      emptySearch: t.mobile.emptySearch,
      newChatAriaLabel: t.mobile.newChat,
      conversationCount: (count: number) => String(count),
    }),
    [t]
  );
  const mobileHomeChatFilterPills = useMemo<ReadonlyArray<Record<string, unknown>>>(() => {
    const allStatusIds = ['working', 'waiting', 'idle', 'offline'];
    const allPrIds = ['open', 'draft', 'merged', 'closed', 'no-pr'];
    const allMachineIds = mobileHomeMachines.map((machine) => machine.id);
    const machineNameById = new Map(
      mobileHomeMachines.map((machine) => [machine.id, machine.name] as const)
    );
    const mobileRepoFilterOptions = mobileHomeGitHubRepositories.map((repo) => ({
      id: repo.fullName,
      label: repo.fullName,
    }));
    const mobileProjectFilterOptions = mobileHomeLocalProjects.map((project) => ({
      id: project.id,
      label: project.name,
      description: project.path,
      group: machineNameById.get(project.machineId) ?? project.machineId,
    }));

    const onSelect = (_id: string) => undefined;
    const onChange = (_next: Set<string>) => undefined;
    const multiPills: Array<Record<string, unknown>> = [
      {
        kind: 'multi',
        id: 'repo',
        label: t.mobile.filterRepository,
        options: mobileRepoFilterOptions,
        defaultIds: new Set<string>(mobileRepoFilterOptions.map((option) => option.id)),
        selectedIds: new Set<string>(mobileRepoFilterOptions.map((option) => option.id)),
        onChange,
      },
      {
        kind: 'multi',
        id: 'project',
        label: t.mobile.filterProject,
        options: mobileProjectFilterOptions,
        defaultIds: new Set<string>(mobileProjectFilterOptions.map((option) => option.id)),
        selectedIds: new Set<string>(mobileProjectFilterOptions.map((option) => option.id)),
        onChange,
      },
      {
        kind: 'multi',
        id: 'running',
        label: t.mobile.filterStatus,
        options: [
          { id: 'working', label: t.mobile.filterWorking },
          { id: 'waiting', label: t.mobile.filterWaiting },
          { id: 'idle', label: t.mobile.filterIdle },
          { id: 'offline', label: t.mobile.filterOffline },
        ],
        defaultIds: new Set<string>(allStatusIds),
        selectedIds: new Set<string>(allStatusIds),
        onChange,
      },
      {
        kind: 'multi',
        id: 'pr',
        label: t.mobile.filterPr,
        options: [
          { id: 'open', label: 'Open' },
          { id: 'draft', label: 'Draft' },
          { id: 'merged', label: 'Merged' },
          { id: 'closed', label: 'Closed' },
          { id: 'no-pr', label: t.mobile.filterNoPr },
        ],
        defaultIds: new Set<string>(allPrIds),
        selectedIds: new Set<string>(allPrIds),
        onChange,
      },
      {
        kind: 'multi',
        id: 'machine',
        label: t.mobile.filterMachine,
        options: mobileHomeMachines.map((machine) => ({ id: machine.id, label: machine.name })),
        defaultIds: new Set<string>(allMachineIds),
        selectedIds: new Set<string>(allMachineIds),
        onChange,
      },
    ];

    return [
      {
        kind: 'single',
        id: 'scope',
        fallbackLabel: t.mobile.filterTeam,
        options: [
          { id: 'team', label: t.mobile.filterTeam },
          { id: 'my', label: t.mobile.filterMine },
        ],
        selectedId: 'team',
        onSelect,
      },
      {
        kind: 'single',
        id: 'view',
        fallbackLabel: t.mobile.filterGroupNone,
        options: [
          { id: 'none', label: t.mobile.filterGroupNone },
          { id: 'project', label: t.mobile.filterGroupProject },
        ],
        selectedId: 'none',
        onSelect,
      },
      {
        kind: 'aggregate',
        id: 'filters',
        label: t.mobile.filterFilters,
        pills: multiPills,
      },
    ];
  }, [mobileHomeGitHubRepositories, mobileHomeLocalProjects, mobileHomeMachines, t]);
  const selectedTask = selectedTaskId
    ? (allSelectableTasks.find((task) => task.sessionId === selectedTaskId) ?? null)
    : null;
  const selectedTaskKey = selectedTask?.sessionId ?? null;

  useEffect(() => {
    setActiveSessionTabId(selectedTaskKey ? asSessionId(selectedTaskKey) : null);
  }, [selectedTaskKey]);

  const selectedModelLabel =
    modelOptions.find((option) => option.value === selectedModel)?.label ?? '';
  const isSelectedLocalSession = selectedTask?.sessionId.startsWith('local-') ?? false;
  const isPlainChatSession = Boolean(selectedTask && !selectedTask.repoFullName);
  const selectedRepoLabel = selectedTask
    ? isPlainChatSession
      ? t.sidebar.onlyChats
      : (selectedTask.repoFullName ?? selectedTask.title)
    : (selectedRepo ?? 'loro-dev/lody');
  const activeSessionCopy = isPlainChatSession
    ? t.sessions.jellyfish
    : isSelectedLocalSession
      ? t.sessions.localFeedback
      : selectedTask?.sessionId === 'task-2'
        ? t.sessions.fontSizePlan
        : selectedTask?.sessionId === 'task-3'
          ? t.sessions.mobileAcpKeyboard
          : t.sessions.repo;

  const chatUser: SessionChatUser = useMemo(
    () => ({
      name: 'You',
      image: 'https://avatars.githubusercontent.com/u/30241095?v=4&size=64',
      email: t.userEmail,
    }),
    [t.userEmail]
  );
  const sessionMessages = useMemo(() => {
    if (selectedTask?.sessionId === DEMO_TASK_ID) {
      if (isDesignDemo) {
        return buildDesignDemoHistory(locale, designTurns);
      }
      return buildDemoIntroHistory(locale, demoStream);
    }
    if (isMobileDemo && selectedTask?.sessionId === 'task-5') {
      // Mobile demo streams the jellyfish conversation instead of showing the
      // finished one.
      return buildMobileJellyfishHistory(t.sessions.jellyfish, mobileTurn);
    }
    return buildSessionMessages(activeSessionCopy, selectedModelLabel, selectedModel ?? '');
  }, [
    activeSessionCopy,
    demoStream,
    designTurns,
    isDesignDemo,
    isMobileDemo,
    locale,
    mobileTurn,
    selectedModel,
    selectedModelLabel,
    selectedTask?.sessionId,
    t.sessions.jellyfish,
  ]);
  const sessionItems = useMemo<ChatStreamItem[]>(
    () =>
      sessionMessages.map((message) => ({
        type: 'message',
        sessionId: PREVIEW_SESSION_ID,
        message,
      })),
    [sessionMessages]
  );
  const sessionStatus = useMemo<SessionStatus | undefined>(() => {
    if (!selectedTask?.isWaitingPermission) return undefined;
    return {
      type: 'requestPermission',
      requestId: 'font-size-plan-question',
      toolCallId: 'font-size-plan-ask-user-question',
      toolTitle:
        locale === 'zh'
          ? '字号配置应该影响对话里的哪些文本？'
          : 'Which conversation text should the font-size setting affect?',
      requestKind: 'ask_user_question',
    };
  }, [locale, selectedTask?.isWaitingPermission]);

  const sessionTabMeta = useMemo(() => {
    if (!selectedTask) return null;

    const childTabLabels =
      selectedTask.sessionId === DEMO_TASK_ID ? [] : (activeSessionCopy.childTabs ?? []);
    const parentSession = buildPreviewSessionMeta({
      id: asSessionId(selectedTask.sessionId),
      title: selectedTask.title,
      task: selectedTask,
      selectedAgent,
      minutesAgo: 8,
    });
    const childSessions = childTabLabels.map((label, index) =>
      buildPreviewSessionMeta({
        id: asSessionId(`${selectedTask.sessionId}:child-${index + 1}`),
        title: label,
        task: selectedTask,
        selectedAgent,
        parentSessionId: parentSession.id,
        minutesAgo: 6 - index * 2,
      })
    );
    const validActiveTab =
      activeSessionTabId &&
      (activeSessionTabId === parentSession.id ||
        childSessions.some((session) => session.id === activeSessionTabId));

    return {
      parentSession,
      childSessions,
      activeTabSessionId: validActiveTab ? activeSessionTabId : parentSession.id,
    };
  }, [activeSessionCopy.childTabs, activeSessionTabId, selectedAgent, selectedTask]);

  const sessionPrimaryAction = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(
        // Desktop session send chip; mobile overrides below.
        'h-7 w-7 rounded-md border shadow-xs transition-all',
        'border-primary/[0.28] bg-primary/[0.14] text-foreground hover:bg-primary/[0.22] hover:text-foreground active:translate-y-[1px]'
      )}
      disabled={reply.trim().length === 0 && designAnnotationItems.length === 0}
      aria-label="Send"
    >
      <ArrowUp className="h-4 w-4" />
    </Button>
  );

  /* Production mobile send chip (session-chat-input-area): filled round disc. */
  const mobileSessionPrimaryAction = (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className={cn(
        'h-8 w-8 rounded-full shadow-xs transition-all',
        'bg-foreground text-background hover:bg-foreground/90 hover:text-background active:translate-y-[1px]'
      )}
      disabled={reply.trim().length === 0}
      aria-label="Send"
    >
      <ArrowUp className="h-5 w-5" />
    </Button>
  );

  const sessionComposer = (
    <ChatComposer
      tone={tone}
      variant="session"
      promptId="landing-session-reply"
      promptValue={reply}
      onPromptChange={setReply}
      footerSelector={footerSelector}
      primaryAction={sessionPrimaryAction}
      onImageAddClick={() => undefined}
      onFileAddClick={() => undefined}
      autoResize
      maxRows={5}
      focusOnContainerClick
      visualAnnotationReferenceItems={designAnnotationItems}
      onVisualAnnotationReferenceRemove={() => setDesignStagedRef(false)}
    />
  );

  /* Mobile session composer mirrors production SessionChatInputArea on isMobile:
     single-line ChatComposer + one MobileSessionRunConfig face (agent icon +
     model + thinking) in a flex-1 footer slot + filled round send chip.
     ForceMobileLayoutProvider in LandingMobilePreview makes useIsMobile true. */
  const mobileSessionComposer = sessionTabMeta ? (
    <ChatComposer
      tone={tone}
      variant="session"
      promptId="landing-mobile-session-reply"
      promptValue={reply}
      onPromptChange={setReply}
      promptRows={1}
      footerSelector={
        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
          <div className="min-w-0 flex-1 overflow-hidden">
            <MobileSessionRunConfig
              agentSelection={
                selectedAgent && selectedMachine
                  ? {
                      agentId: selectedAgent,
                      machineId: selectedMachine as MachineId,
                    }
                  : null
              }
              allowedMachineIds={selectedMachine ? [selectedMachine as MachineId] : []}
              agentLocked
              fallbackAgent={getPreviewAgent(selectedAgent)}
              modelOptions={modelOptions}
              selectedModelId={selectedModel}
              onModelChange={setSelectedModel}
              modeOptions={permissionModeOptions}
              selectedModeId={selectedPermissionMode}
              onModeChange={setSelectedPermissionMode}
              configOptionSelectors={configOptionSelectors}
              configOptionValues={configValues}
              onConfigOptionChange={(configId, value) =>
                setConfigValues((prev) => ({ ...prev, [configId]: value }))
              }
            />
          </div>
        </div>
      }
      primaryAction={mobileSessionPrimaryAction}
      onImageAddClick={() => undefined}
      onFileAddClick={() => undefined}
      autoResize
      maxRows={5}
      focusOnContainerClick
    />
  ) : null;

  /* ── Mobile new-chat sheet selectors ──
     The sheet drives everything through `MobileInlinePicker` (chip trigger +
     inline drawer). 1:1 with chat-landing.tsx: model + thinking sit in the
     COMPOSER FOOTER, and the agent / Plan / permission cluster sits BELOW the
     composer in its own `belowComposerNode` slot. The landing shell used to
     render neither, so the sheet stopped one row short of the real one. */
  const mobileSheetFooterSelector = (
    <div className="flex w-full min-w-0 items-center">
      <div className="min-w-0">
        <MobileInlinePicker
          id="landing-mobile-model"
          value={selectedModel}
          onChange={setSelectedModel}
          options={modelOptions.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
          }))}
          ariaLabel={locale === 'zh' ? '模型' : 'Model'}
          triggerClassName="h-8 px-2 py-1 text-sm"
          triggerContent={<span className="truncate">{selectedModelLabel}</span>}
        />
      </div>
      <div className="ml-1 shrink-0">
        <MobileInlinePicker
          id="landing-mobile-thinking"
          value={String(configValues.reasoning_effort ?? 'medium')}
          onChange={(value) => setConfigValues((prev) => ({ ...prev, reasoning_effort: value }))}
          options={(t.config.think[selectedProvider]
            ? (Object.entries(t.config.think[selectedProvider]) as [string, LabelDesc][])
            : []
          ).map(([value, [label, description]]) => ({ value, label, description }))}
          ariaLabel={t.config.thinkLevel}
          triggerClassName="h-8 px-2 py-1 text-sm"
          triggerContent={
            <span className="truncate">
              {t.config.think[selectedProvider][
                String(configValues.reasoning_effort ?? 'medium') as 'medium'
              ]?.[0] ?? t.config.thinkLevel}
            </span>
          }
        />
      </div>
    </div>
  );

  const mobileSheetBelowComposer = (
    <MobileInlinePickerRowSlot>
      <div className="flex w-full items-start gap-2">
        <div className="min-w-0">
          <MobileInlinePicker
            id="landing-mobile-agent"
            value={selectedAgent}
            onChange={setSelectedAgent}
            options={[
              { value: 'codex', label: t.agents.codex },
              { value: 'claude', label: t.agents.claude },
            ]}
            ariaLabel={t.selectors.selectAgent}
            triggerClassName="h-8 px-2 py-1 text-sm"
            triggerContent={<span className="truncate">{t.agents[selectedProvider]}</span>}
          />
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="min-w-0">
            <MobileInlinePicker
              id="landing-mobile-permission"
              value={selectedPermissionMode}
              onChange={setSelectedPermissionMode}
              options={permissionModeOptions.map((option) => ({
                value: option.value,
                label: option.label,
                description: option.description,
              }))}
              ariaLabel={locale === 'zh' ? '权限模式' : 'Permission mode'}
              triggerClassName="h-8 px-2 py-1 text-sm"
              triggerContent={
                <>
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-80">
                    {getModeIcon(selectedPermissionMode)}
                  </span>
                  <span className="truncate">
                    {permissionModeOptions.find((option) => option.value === selectedPermissionMode)
                      ?.label ?? ''}
                  </span>
                </>
              }
            />
          </div>
        </div>
      </div>
    </MobileInlinePickerRowSlot>
  );

  // Show the split changes layout for GitHub-worktree sessions that carry a diff.
  const resetDemoFocus = useCallback(() => {
    if (demoFocusHoldTimerRef.current != null) {
      window.clearTimeout(demoFocusHoldTimerRef.current);
      demoFocusHoldTimerRef.current = null;
    }
    setDemoFocus(DEMO_FOCUS_REST);
  }, []);

  // Track the phone stage size so pan can be edge-clamped in JS (not only CSS).
  useEffect(() => {
    const stage = demoStageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setDemoStageSize((prev) =>
        Math.abs(prev.w - cr.width) < 0.5 && Math.abs(prev.h - cr.height) < 0.5
          ? prev
          : { w: cr.width, h: cr.height }
      );
    });
    ro.observe(stage);
    const r = stage.getBoundingClientRect();
    setDemoStageSize({ w: r.width, h: r.height });
    return () => ro.disconnect();
  }, [isMounted, isMobileDemo]);

  /** Clamped transform vars for the phone desktop-shell camera (always set on
   *  phone so letterboxed rest state is centered, not stuck at top-left). */
  const desktopFocusCssVars = useMemo((): CSSProperties => {
    if (!isPhoneDemoViewport() || demoStageSize.w < 2) {
      return {};
    }
    const { tx, ty, totalS } = resolveClampedFocusTransform(
      demoStageSize.w,
      demoStageSize.h,
      demoFocus.fx,
      demoFocus.fy,
      demoFocus.scale
    );
    return {
      ['--ld-focus-tx' as string]: `${tx}px`,
      ['--ld-focus-ty' as string]: `${ty}px`,
      ['--ld-focus-total-s' as string]: String(totalS),
    };
  }, [demoFocus, demoStageSize]);

  /**
   * Move the ghost cursor onto `el` with a glide. Uses the live element rect
   * only — no pan/zoom camera (that fought cursor motion on phone).
   */
  const moveCursorToEl = useCallback(
    (
      el: HTMLElement | null | undefined,
      opts?: { pulse?: boolean; visible?: boolean; instant?: boolean }
    ) => {
      if (!ghostGateRef.current) return;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 && rect.height < 1) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setDemoCursor((c) => ({
        ...c,
        x: cx,
        y: cy,
        visible: opts?.visible ?? true,
        pulse: opts?.pulse ? c.pulse + 1 : c.pulse,
        instant: opts?.instant ?? false,
      }));
    },
    []
  );

  /**
   * Former phone Ken-Burns focus camera — disabled. Zoom/pan desynced the ghost
   * cursor and felt janky on mobile. Call sites kept as no-ops so demo timelines
   * stay readable.
   */
  const focusDemo = useCallback(
    (
      _el?: HTMLElement | null,
      _fallback?: { fx: number; fy: number; scale: number },
      _scale?: number,
      _holdMs?: number
    ) => {
      // no-op: keep shell at rest contain-scale; cursor uses live rects only
    },
    []
  );

  // ---- worktree-demo script: a ghost user driving the REAL composer ---------
  // One long timeline per activation. Clicks target real DOM with state fallbacks.
  // Always uses the desktop shell (scaled on phone). No Ken-Burns camera.
  useEffect(() => {
    if (!isWorktreeDemo || !isMounted) return undefined;
    const flag = { cancelled: false };
    const timers: number[] = [];
    const intervals: number[] = [];
    const at = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => {
        if (!flag.cancelled) fn();
      }, ms);
      timers.push(id);
    };

    const d = DEMO_COPY[locale];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const findTarget = (selector: string, text?: string): HTMLElement | null => {
      const scopes: ParentNode[] = [];
      if (shellRef.current) scopes.push(shellRef.current);
      scopes.push(document); // popovers portal to <body>
      for (const scope of scopes) {
        const nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(
          (node) => node.getBoundingClientRect().width > 0
        );
        const match = text
          ? nodes.find((node) => (node.textContent ?? '').includes(text))
          : nodes[0];
        if (match) return match;
      }
      return null;
    };
    const moveTo = (selector: string, text?: string) => {
      moveCursorToEl(findTarget(selector, text));
    };
    const clickTarget = (selector: string, text?: string, action?: () => void) => {
      const el = findTarget(selector, text);
      moveCursorToEl(el, { pulse: true });
      clickQuiet(el, action);
    };
    const streamReply = (streamStart: number) => {
      const streamEnd = Math.min(WORKTREE_DEMO_DURATION_MS - 1200, streamStart + 1600);
      at(streamStart, () => {
        const tickMs = 28;
        const ticks = Math.max(1, Math.floor((streamEnd - streamStart) / tickMs));
        const perTick = Math.max(6, Math.ceil(d.reply.length / ticks));
        let offset = 0;
        const id = window.setInterval(() => {
          if (flag.cancelled) {
            window.clearInterval(id);
            return;
          }
          offset = Math.min(d.reply.length, offset + perTick);
          const done = offset >= d.reply.length;
          setDemoStream({ text: d.reply.slice(0, offset), done });
          if (done) {
            window.clearInterval(id);
            setDemoTask(buildDemoTask(locale, false));
          }
        }, tickMs);
        intervals.push(id);
      });
    };

    setSelectedTaskId(null);
    setContextType('local');
    setSelectedLocalProject(DEMO_PROJECT_NAME);
    setWorkdirMode('local');
    setSelectedBranch('main');
    setPrompt('');
    setDemoTask(null);
    setDemoStream(null);
    resetDemoFocus();

    if (reduced) {
      setWorkdirMode('worktree');
      setSelectedBranch('main');
      setDemoTask(buildDemoTask(locale, false));
      setDemoStream({ text: d.reply, done: true });
      setSelectedTaskId(DEMO_TASK_ID);
      return () => {
        flag.cancelled = true;
      };
    }

    // 1) Zoom into the worktree pill (cursor parks at stage center on the pill).
    at(350, () => {
      const el = findTarget('[data-demo="workdir"] label');
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.worktreePill);
    });
    at(1000, () =>
      clickTarget('[data-demo="workdir"] label', undefined, () => setWorkdirMode('worktree'))
    );
    // 2) Follow the cursor to the composer while typing.
    at(1450, () => {
      const el = findTarget('textarea');
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.composer, 1.7);
    });
    const typeEnd = scheduleTypedText(at, 1800, d.promptText, locale, setPrompt);
    at(typeEnd + 220, () => moveTo('button[aria-label="Send"]'));
    const sendAt = typeEnd + 700;
    at(sendAt, () =>
      clickTarget('button[aria-label="Send"]', undefined, () => {
        setPrompt('');
        setDemoTask(buildDemoTask(locale, true));
        setDemoStream({ text: '', done: false });
        setSelectedTaskId(DEMO_TASK_ID);
        setDemoCursor((cursor) => ({ ...cursor, visible: false }));
      })
    );
    // 3) After the session opens, soft-focus the reply area (not empty top chrome).
    // Prefer the last message row so zoom lands on real text, not blank scroll.
    at(sendAt + 280, () => {
      const el =
        findTarget('[data-message-role="assistant"]') ??
        findTarget('[data-message-role="user"]') ??
        findTarget('.lody-app-preview [data-slot="scroll-area"]');
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.sessionChat, 1.4);
    });
    streamReply(sendAt + 350);

    return () => {
      flag.cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      intervals.forEach((id) => window.clearInterval(id));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setDemoCursor({ x: 0, y: 0, visible: false, pulse: 0 });
      resetDemoFocus();
      setDemoTask(null);
      setDemoStream(null);
      setWorkdirMode('local');
      setSelectedBranch('main');
      setPrompt('');
      setContextType('local');
      setSelectedTaskId(null);
    };
  }, [isWorktreeDemo, isMounted, locale, focusDemo, resetDemoFocus, moveCursorToEl]);

  // ---- diff-demo script (feature tab 2): keep tab-1's end state, then drill into
  // the "Create highlight clipping" GitHub session and open its live diff. ---------
  useEffect(() => {
    if (!isDiffDemo || !isMounted) return undefined;
    const flag = { cancelled: false };
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => {
        if (!flag.cancelled) fn();
      }, ms);
      timers.push(id);
    };

    // Opening state: jump straight onto the GitHub clipping session WITH the
    // right panel already open on Changes. The toggle-panel click was pure
    // theatre and delayed the real point of this tab (the live diff).
    clearPanelLayoutStorage();
    setWorkdirMode('worktree');
    setSelectedBranch('main');
    setDemoTask(buildDemoTask(locale, false));
    setDemoStream({ text: DEMO_COPY[locale].reply, done: true });
    setSelectedTaskId(DIFF_DEMO_TASK_ID);
    setDiffSecondaryOpen(true);
    setDiffPanelTab('changes');
    setDiffViewer('hidden');
    resetDemoFocus();

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // No motion: jump straight to the opened-diff end state.
      setDiffViewer('shown');
      return () => {
        flag.cancelled = true;
      };
    }

    const findTarget = (selector: string, text?: string): HTMLElement | null => {
      const scopes: ParentNode[] = [];
      if (shellRef.current) scopes.push(shellRef.current);
      scopes.push(document);
      for (const scope of scopes) {
        const nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(
          (node) => node.getBoundingClientRect().width > 0
        );
        const match = text
          ? nodes.find((node) => (node.textContent ?? '').includes(text))
          : nodes[0];
        if (match) return match;
      }
      return null;
    };
    const findByText = (text: string): HTMLElement | null => {
      const root = shellRef.current;
      if (!root) return null;
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
        (el) => (el.textContent ?? '').includes(text) && el.getBoundingClientRect().width > 0
      );
      nodes.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return nodes[0] ?? null;
    };
    const clickEl = (el: HTMLElement | null, action?: () => void) => {
      moveCursorToEl(el, { pulse: true });
      clickQuiet(el, action);
    };

    const dragHandleLeft = (totalDx: number, steps: number, stepMs: number) => {
      if (!ghostGateRef.current) return;
      const handle = findTarget('[data-slot="resizable-handle"]');
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      let x = rect.left + rect.width / 2;
      const init = (buttons: number): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      });
      // Aim camera + cursor at the handle before dragging.
      moveCursorToEl(handle, { pulse: true });
      handle.dispatchEvent(new PointerEvent('pointerdown', init(1)));
      const dx = totalDx / steps;
      for (let i = 1; i <= steps; i++) {
        const id = window.setTimeout(() => {
          if (flag.cancelled || !ghostGateRef.current) {
            // Abort mid-drag cleanly so we never leave a dangling capture.
            try {
              document.body.dispatchEvent(new PointerEvent('pointerup', init(0)));
            } catch {
              /* ignore */
            }
            return;
          }
          x += dx;
          document.body.dispatchEvent(new PointerEvent('pointermove', init(1)));
          // Keep the view centered on the handle as it slides.
          moveCursorToEl(handle);
          if (i === steps) document.body.dispatchEvent(new PointerEvent('pointerup', init(0)));
        }, i * stepMs);
        timers.push(id);
      }
    };

    const fileBasename = 'view.tsx';

    /* -- timeline (budget: DIFF_DEMO_DURATION_MS) --
       Slow enough to read: widen panel → park on file → click → hold on live
       diff. Phone focus follows the cursor: panel → file row → live diff. */
    at(120, () => {
      const el = findTarget('[data-slot="resizable-handle"]');
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.rightPanel, 1.65);
    });
    // Drag slower (more steps + longer step) so the panel widen is visible.
    at(380, () => dragHandleLeft(-300, 14, 32));
    at(1000, () => {
      const el = findByText(fileBasename);
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.rightPanel, 1.85);
    });
    // Hover the file long enough to register before the click.
    at(1750, () => {
      const el = findByText(fileBasename);
      clickEl(el, () => handleDiffOpenFile());
      at(450, () => {
        // Diff surface: project cursor onto the viewer region (clamped camera).
        focusDemo(null, DEMO_FOCUS_ANCHORS.diffViewer, 1.95);
      });
      at(700, () => setDemoCursor((cursor) => ({ ...cursor, visible: false })));
    });

    return () => {
      flag.cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      if (diffSkeletonTimer.current) {
        window.clearTimeout(diffSkeletonTimer.current);
        diffSkeletonTimer.current = null;
      }
      setDemoCursor({ x: 0, y: 0, visible: false, pulse: 0 });
      resetDemoFocus();
      setDemoTask(null);
      setDemoStream(null);
      setWorkdirMode('local');
      setSelectedBranch('main');
      setDiffSecondaryOpen(false);
      setDiffPanelTab('changes');
      setDiffViewer('hidden');
      setSelectedTaskId(null);
      clearPanelLayoutStorage();
    };
  }, [
    isDiffDemo,
    isMounted,
    locale,
    handleDiffOpenFile,
    focusDemo,
    resetDemoFocus,
    moveCursorToEl,
  ]);

  // ---- design-demo script (feature tab 3): design mode via Lody Preview --------
  // Back on the `lody` session: ask for the landing dev server → reply reports a
  // preview candidate (the info bar gains the emerald Browser action) → open the
  // Preview → widen the panel with a REAL drag on the resize handle → annotate the
  // hero copy → send the comment → the page hot-reloads with the edit applied.
  useEffect(() => {
    if (!isDesignDemo || !isMounted) return undefined;
    const flag = { cancelled: false };
    const timers: number[] = [];
    const intervals: number[] = [];
    const at = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => {
        if (!flag.cancelled) fn();
      }, ms);
      timers.push(id);
    };
    // Opening state: already on the "Introduce Lody" session with its completed
    // reply — skip the sidebar re-click so the demo starts at the composer.
    clearPanelLayoutStorage();
    setSelectedTaskId(DEMO_TASK_ID);
    setWorkdirMode('worktree');
    setSelectedBranch('main');
    setDemoTask(buildDemoTask(locale, false));
    setDemoStream({ text: DEMO_COPY[locale].reply, done: true });
    setDesignTurns(INITIAL_DESIGN_TURNS);
    setDesignPreview(INITIAL_LANDING_PREVIEW_STATE);
    setDesignPreviewAvailable(false);
    setDesignPreviewOpen(false);
    setDesignStagedRef(false);
    setReply('');
    resetDemoFocus();

    const d = DESIGN_DEMO_COPY[locale];
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // No motion: jump straight to the fully-reviewed end state.
      setDesignTurns({
        turn2User: true,
        turn2: { devDone: true, reportDone: true, text: d.turn2Text, done: true },
        turn3User: true,
        turn3: { editDone: true, text: d.turn3Text, done: true },
      });
      setDesignPreviewAvailable(true);
      setDesignPreviewOpen(true);
      setDesignPreview({
        loading: false,
        annotating: true,
        hoverLine: null,
        draft: null,
        savedComment: { line: 2, text: d.comment, staged: true },
        edited: true,
      });
      return () => {
        flag.cancelled = true;
      };
    }

    const findTarget = (selector: string, text?: string): HTMLElement | null => {
      const scopes: ParentNode[] = [];
      if (shellRef.current) scopes.push(shellRef.current);
      scopes.push(document);
      for (const scope of scopes) {
        const nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(
          (node) => node.getBoundingClientRect().width > 0
        );
        const match = text
          ? nodes.find((node) => (node.textContent ?? '').includes(text))
          : nodes[0];
        if (match) return match;
      }
      return null;
    };
    const moveTo = (selector: string, text?: string) => moveCursorToEl(findTarget(selector, text));
    const clickEl = (el: HTMLElement | null, action?: () => void) => {
      moveCursorToEl(el, { pulse: true });
      clickQuiet(el, action);
    };
    const click = (selector: string, action?: () => void) => clickEl(findTarget(selector), action);

    // Drag the REAL react-resizable-panels handle: its registry listens for
    // body-level pointer events and requires `isPrimary` (see
    // getResizeEventCoordinates), so synthetic PointerEvents drive a real resize.
    const dragHandleLeft = (totalDx: number, steps: number, stepMs: number) => {
      if (!ghostGateRef.current) return;
      const handle = findTarget('[data-slot="resizable-handle"]');
      if (!handle) return;
      const rect = handle.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      let x = rect.left + rect.width / 2;
      const init = (buttons: number): PointerEventInit => ({
        bubbles: true,
        cancelable: true,
        pointerId: 7,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      });
      moveCursorToEl(handle, { pulse: true });
      handle.dispatchEvent(new PointerEvent('pointerdown', init(1)));
      const dx = totalDx / steps;
      for (let i = 1; i <= steps; i++) {
        const id = window.setTimeout(() => {
          if (flag.cancelled || !ghostGateRef.current) {
            try {
              document.body.dispatchEvent(new PointerEvent('pointerup', init(0)));
            } catch {
              /* ignore */
            }
            return;
          }
          x += dx;
          document.body.dispatchEvent(new PointerEvent('pointermove', init(1)));
          moveCursorToEl(handle);
          if (i === steps) {
            document.body.dispatchEvent(new PointerEvent('pointerup', init(0)));
          }
        }, i * stepMs);
        timers.push(id);
      }
    };

    // -- timeline (budget: DESIGN_DEMO_DURATION_MS) --
    // Phone focus follows the cursor: composer → Browser → preview → annotate.
    at(60, () => {
      const el = findTarget('textarea');
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.composer, 1.7);
    });
    const typeEnd = scheduleTypedText(at, 200, d.prompt, locale, setReply);
    at(typeEnd + 80, () => {
      const el = findTarget('button[aria-label="Send"]');
      if (!el) return;
      // Park on Send while hidden, then reveal — still tracks camera if zoomed.
      moveCursorToEl(el, { visible: false });
    });
    at(typeEnd + 140, () =>
      setDemoCursor((cursor) => ({ ...cursor, visible: true, pulse: cursor.pulse + 1 }))
    );
    at(typeEnd + 400, () =>
      click('button[aria-label="Send"]', () => {
        setReply('');
        setDesignTurns((turns) => ({ ...turns, turn2User: true }));
        setDemoTask(buildDemoTask(locale, true));
        setDemoCursor((cursor) => ({ ...cursor, visible: false }));
      })
    );
    // Reply: pnpm dev → report preview candidate → header preview icon.
    const toolsAt = typeEnd + 900;
    at(toolsAt, () =>
      setDesignTurns((turns) => ({
        ...turns,
        turn2: { devDone: false, reportDone: false, text: '', done: false },
      }))
    );
    at(toolsAt + 900, () =>
      setDesignTurns((turns) =>
        turns.turn2 ? { ...turns, turn2: { ...turns.turn2, devDone: true } } : turns
      )
    );
    at(toolsAt + 1400, () => {
      setDesignTurns((turns) =>
        turns.turn2 ? { ...turns, turn2: { ...turns.turn2, reportDone: true } } : turns
      );
      // The candidate lands in the session doc → the header action appears.
      setDesignPreviewAvailable(true);
    });
    at(toolsAt + 1700, () => {
      const tickMs = 24;
      const target = d.turn2Text;
      const ticks = Math.max(1, Math.floor(700 / tickMs));
      const perTick = Math.max(6, Math.ceil(target.length / ticks));
      let offset = 0;
      const id = window.setInterval(() => {
        if (flag.cancelled) {
          window.clearInterval(id);
          return;
        }
        offset = Math.min(target.length, offset + perTick);
        const done = offset >= target.length;
        setDesignTurns((turns) =>
          turns.turn2
            ? { ...turns, turn2: { ...turns.turn2, text: target.slice(0, offset), done } }
            : turns
        );
        if (done) {
          window.clearInterval(id);
          setDemoTask(buildDemoTask(locale, false));
        }
      }, tickMs);
      intervals.push(id);
    });
    // 4) Open the Browser panel from the info bar.
    const openPreviewAt = toolsAt + 3200;
    at(openPreviewAt - 80, () => {
      const el = findTarget(PREVIEW_ACTION_SELECTOR);
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.composer, 1.8);
    });
    at(openPreviewAt, () => moveTo(PREVIEW_ACTION_SELECTOR));
    at(openPreviewAt + 450, () => click(PREVIEW_ACTION_SELECTOR, () => setDesignPreviewOpen(true)));
    at(openPreviewAt + 700, () => {
      focusDemo(null, DEMO_FOCUS_ANCHORS.browserPreview, 1.75);
    });
    at(openPreviewAt + 900, () => setDesignPreview((state) => ({ ...state, loading: false })));
    // 5) Widen the preview modestly for the hero copy.
    at(openPreviewAt + 1200, () => moveTo('[data-slot="resizable-handle"]'));
    at(openPreviewAt + 1500, () => dragHandleLeft(-150, 8, 40));
    // 6) Annotation mode on, inspect the three copy lines.
    const annotateAt = openPreviewAt + 2200;
    at(annotateAt, () => moveTo(ANNOTATE_ACTION_SELECTOR));
    at(annotateAt + 400, () =>
      click(ANNOTATE_ACTION_SELECTOR, () =>
        setDesignPreview((state) => ({ ...state, annotating: true }))
      )
    );
    at(annotateAt + 700, () => {
      const el = findTarget('[data-demo="pv-line-0"]');
      moveCursorToEl(el);
      focusDemo(el, DEMO_FOCUS_ANCHORS.annotateLine, 1.95);
    });
    at(annotateAt + 800, () => {
      moveTo('[data-demo="pv-line-0"]');
      setDesignPreview((state) => ({ ...state, hoverLine: 0 }));
    });
    at(annotateAt + 1400, () => {
      moveTo('[data-demo="pv-line-1"]');
      setDesignPreview((state) => ({ ...state, hoverLine: 1 }));
    });
    at(annotateAt + 2000, () => {
      moveTo('[data-demo="pv-line-2"]');
      setDesignPreview((state) => ({ ...state, hoverLine: 2 }));
    });
    // 7) Click the last line → draft comment card.
    at(annotateAt + 2500, () =>
      click('[data-demo="pv-line-2"]', () =>
        setDesignPreview((state) => ({ ...state, draft: { line: 2, text: '' } }))
      )
    );
    at(annotateAt + 2900, () => moveTo('[data-demo="pv-draft"] textarea'));
    const commentEnd = scheduleTypedText(at, annotateAt + 3100, d.comment, locale, (slice) => {
      setDesignPreview((state) =>
        state.draft ? { ...state, draft: { ...state.draft, text: slice } } : state
      );
    });
    /* 8) Add comment → the saved pin card appears ALREADY staged. Creating a
       preview comment stages its visual-annotation reference in the composer in
       the same call (`submitDraft` → `onAddVisualAnnotationToChat` in
       `sessions/managed-preview-surface.tsx`); the card's Send control is only
       the toggle for comments that already exist, so there is no second click
       between commenting and sending. */
    at(commentEnd + 250, () => moveTo('[data-demo="pv-draft-send"]'));
    at(commentEnd + 600, () =>
      click('[data-demo="pv-draft-send"]', () => {
        setDesignPreview((state) => ({
          ...state,
          draft: null,
          hoverLine: null,
          savedComment: { line: 2, text: d.comment, staged: true },
        }));
        // Stages the app's real pending-reference chip in the composer.
        setDesignStagedRef(true);
      })
    );
    // 9) Send from the session composer; the agent edits + the page hot-reloads.
    at(commentEnd + 1100, () => moveTo('button[aria-label="Send"]'));
    at(commentEnd + 1600, () =>
      click('button[aria-label="Send"]', () => {
        setReply('');
        setDesignStagedRef(false);
        setDesignTurns((turns) => ({ ...turns, turn3User: true }));
        setDemoTask(buildDemoTask(locale, true));
      })
    );
    at(commentEnd + 2000, () =>
      setDesignTurns((turns) => ({
        ...turns,
        turn3: { editDone: false, text: '', done: false },
      }))
    );
    at(commentEnd + 2600, () => {
      setDesignTurns((turns) =>
        turns.turn3 ? { ...turns, turn3: { ...turns.turn3, editDone: true } } : turns
      );
      // Hot reload: the preview drops the trailing phrase in the same beat.
      setDesignPreview((state) => ({ ...state, edited: true }));
      setDemoCursor((cursor) => ({ ...cursor, visible: false }));
    });
    at(commentEnd + 2800, () => {
      const tickMs = 24;
      const target = d.turn3Text;
      const ticks = Math.max(1, Math.floor(500 / tickMs));
      const perTick = Math.max(6, Math.ceil(target.length / ticks));
      let offset = 0;
      const id = window.setInterval(() => {
        if (flag.cancelled) {
          window.clearInterval(id);
          return;
        }
        offset = Math.min(target.length, offset + perTick);
        const done = offset >= target.length;
        setDesignTurns((turns) =>
          turns.turn3
            ? { ...turns, turn3: { ...turns.turn3, text: target.slice(0, offset), done } }
            : turns
        );
        if (done) {
          window.clearInterval(id);
          setDemoTask(buildDemoTask(locale, false));
        }
      }, tickMs);
      intervals.push(id);
    });

    return () => {
      flag.cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      intervals.forEach((id) => window.clearInterval(id));
      clearPanelLayoutStorage();
      setDemoCursor({ x: 0, y: 0, visible: false, pulse: 0 });
      resetDemoFocus();
      setDemoTask(null);
      setDemoStream(null);
      setDesignTurns(INITIAL_DESIGN_TURNS);
      setDesignPreview(INITIAL_LANDING_PREVIEW_STATE);
      setDesignPreviewAvailable(false);
      setDesignPreviewOpen(false);
      setDesignStagedRef(false);
      setReply('');
      setWorkdirMode('local');
      setSelectedBranch('main');
      setSelectedTaskId(null);
    };
  }, [isDesignDemo, isMounted, locale, focusDemo, resetDemoFocus, moveCursorToEl]);

  // ---- mobile-demo script (feature tab 4): Lody on the phone -----------------
  // The preview morphs to iPhone width, then a ghost thumb drives the REAL mobile
  // UI: all-conversations home → tab-bar new chat → type the jellyfish prompt →
  // send → the session slides in and the reply streams the generated image.
  useEffect(() => {
    if (!isMobileDemo || !isMounted) return undefined;
    const flag = { cancelled: false };
    const timers: number[] = [];
    const intervals: number[] = [];
    const at = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => {
        if (!flag.cancelled) fn();
      }, ms);
      timers.push(id);
    };

    // Opening state: phone already at design size (same stage height as desktop
    // demos). No full-width card intermediate — that flashed a dark rectangle
    // and jumped the stage taller than worktree/diff/design.
    setSelectedTaskId('task-5');
    setMobileStage({ narrowed: true, screen: 'home' });
    setMobileTurn(null);
    setPrompt('');

    const j = copy[locale].sessions.jellyfish;
    const newChatLabel = copy[locale].mobile.newChat;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setMobileStage({ narrowed: true, screen: 'session' });
      setMobileTurn({ text: j.intro, image: true, done: true });
      return () => {
        flag.cancelled = true;
      };
    }

    const findTarget = (selector: string, text?: string): HTMLElement | null => {
      const scopes: ParentNode[] = [];
      if (shellRef.current) scopes.push(shellRef.current);
      scopes.push(document);
      for (const scope of scopes) {
        const nodes = Array.from(scope.querySelectorAll<HTMLElement>(selector)).filter(
          (node) => node.getBoundingClientRect().width > 0
        );
        const match = text
          ? nodes.find((node) => (node.textContent ?? '').includes(text))
          : nodes[0];
        if (match) return match;
      }
      return null;
    };
    const moveTo = (selector: string, text?: string) => {
      const el = findTarget(selector, text);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setDemoCursor((cursor) => ({
        ...cursor,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        visible: true,
      }));
    };
    const click = (selector: string, action?: () => void) => {
      setDemoCursor((cursor) => ({ ...cursor, pulse: cursor.pulse + 1, visible: true }));
      clickQuiet(findTarget(selector), action);
    };

    // -- timeline (budget: MOBILE_DEMO_DURATION_MS) --
    // 1) New chat from the tab bar (phone is already framed).
    at(350, () => moveTo(`button[aria-label="${newChatLabel}"]`));
    at(800, () =>
      click(`button[aria-label="${newChatLabel}"]`, () =>
        setMobileStage((stage) => ({ ...stage, screen: 'compose' }))
      )
    );
    // 2) Type the jellyfish prompt (controlled state only — no focus/scroll).
    at(1200, () => moveTo('textarea'));
    const typeEnd = scheduleTypedText(at, 1350, j.user, locale, setPrompt);
    at(typeEnd + 200, () => moveTo('button[aria-label="Send"]'));
    const sendAt = typeEnd + 650;
    at(sendAt, () =>
      click('button[aria-label="Send"]', () => {
        setPrompt('');
        setMobileStage((stage) => ({ ...stage, screen: 'session' }));
        setMobileTurn({ text: '', image: false, done: false });
        setDemoCursor((cursor) => ({ ...cursor, visible: false }));
      })
    );
    // 3) Stream the reply, then the generated image arrives.
    at(sendAt + 300, () => {
      const tickMs = 22;
      const target = j.intro;
      const perTick = Math.max(2, Math.ceil(target.length / 6));
      let offset = 0;
      const id = window.setInterval(() => {
        if (flag.cancelled) {
          window.clearInterval(id);
          return;
        }
        offset = Math.min(target.length, offset + perTick);
        setMobileTurn((turn) => (turn ? { ...turn, text: target.slice(0, offset) } : turn));
        if (offset >= target.length) window.clearInterval(id);
      }, tickMs);
      intervals.push(id);
    });
    at(sendAt + 800, () => setMobileTurn((turn) => (turn ? { ...turn, image: true } : turn)));
    at(sendAt + 1000, () => setMobileTurn((turn) => (turn ? { ...turn, done: true } : turn)));

    return () => {
      flag.cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      intervals.forEach((id) => window.clearInterval(id));
      // Restore the static chat-landing preview for the other feature tabs.
      setDemoCursor({ x: 0, y: 0, visible: false, pulse: 0 });
      setMobileStage({ narrowed: true, screen: 'home' });
      setMobileTurn(null);
      setPrompt('');
      setSelectedTaskId(null);
    };
  }, [isMobileDemo, isMounted, locale]);

  // Ghost touch indicator: iPad-style circular fingertip + tap pulse.
  // Portaled to <body> in viewport space with a very high z-index so it sits
  // ABOVE any dropdown/popover (also body-portaled) instead of being clipped
  // inside the scaled app frame.
  const demoCursorNode =
    isDemo && isMounted
      ? createPortal(
          <div
            aria-hidden="true"
            className="lody-demo-cursor"
            data-visible={demoCursor.visible ? 'true' : 'false'}
            data-instant={demoCursor.instant ? 'true' : 'false'}
            style={{ transform: `translate3d(${demoCursor.x}px, ${demoCursor.y}px, 0)` }}
          >
            {demoCursor.pulse > 0 ? (
              <span key={demoCursor.pulse} className="lody-demo-cursor__pulse" />
            ) : null}
            <span className="lody-demo-cursor__dot" />
          </div>,
          document.body
        )
      : null;

  const sessionHasChanges = Boolean(
    selectedTask &&
    selectedTask.repoFullName &&
    (selectedTask.addedLines || selectedTask.deletedLines)
  );

  const diffDemoControls: DiffDemoControls | undefined = isDiffDemo
    ? {
        secondaryOpen: diffSecondaryOpen,
        panelTab: diffPanelTab,
        viewer: diffViewer,
        onToggleSecondary: () => setDiffSecondaryOpen((open) => !open),
        onPanelTabChange: setDiffPanelTab,
        onOpenFile: handleDiffOpenFile,
      }
    : undefined;

  // Design demo drives the `lody` demo session through DesktopSessionPreview (so
  // it gets the real resizable layout + the right panel's Browser tab).
  const designDemoControls: DesignDemoControls | undefined =
    isDesignDemo && selectedTask?.sessionId === DEMO_TASK_ID
      ? {
          previewAvailable: designPreviewAvailable,
          previewOpen: designPreviewOpen,
          onOpenPreview: () => setDesignPreviewOpen(true),
          previewNode: <LandingPreviewPanel state={designPreview} />,
        }
      : undefined;

  if (!isMounted) {
    return (
      <div
        className={cn(
          shellClassName,
          // No solid plate under the SSR/hydration shell on the ocean stage.
          'landing-app-preview--stage-demo border-0 bg-transparent shadow-none'
        )}
      >
        <div className="landing-app-preview-stage flex min-h-0 flex-1 items-center justify-center">
          <div className="h-28 w-full max-w-xl rounded-2xl border border-border/40 bg-card/40" />
        </div>
      </div>
    );
  }

  return (
    <Provider store={previewStore}>
      <I18nextProvider i18n={demoI18n}>
        <TooltipProvider>
          <div
            className={cn(
              shellClassName,
              'relative',
              // Desktop demos: full-slot transparent playback (no card fill) on
              // compact stages; mobile is already plate-less via shellClassName.
              // Never transition background — that was the dark rect flash when
              // entering/leaving the mobile tab.
              !isMobileDemo && 'landing-app-preview--stage-demo'
            )}
            ref={shellRef}
          >
            {demoCursorNode}
            {isMobileDemo ? (
              <LandingMobilePreview
                locale={locale}
                narrowed={mobileStage.narrowed}
                screen={mobileStage.screen}
                promptValue={prompt}
                promptPlaceholder={t.landing.placeholder}
                machineName={t.machines['mac-studio']}
                chats={mobileHomeConversations}
                machines={mobileHomeMachines}
                localProjects={mobileHomeLocalProjects}
                githubRepositories={mobileHomeGitHubRepositories}
                labels={mobileHomeLabels}
                chatFilterPills={mobileHomeChatFilterPills}
                sheetFooterSelector={mobileSheetFooterSelector}
                sheetBelowComposerNode={mobileSheetBelowComposer}
                sessionNode={
                  selectedTask && sessionTabMeta ? (
                    <MobileSessionView
                      task={selectedTask}
                      repoLabel={selectedRepoLabel}
                      isLocalSession={isSelectedLocalSession}
                      isPlainChatSession={isPlainChatSession}
                      items={sessionItems}
                      sessionHistory={sessionMessages}
                      sessionStatus={sessionStatus}
                      chatUser={chatUser}
                      composer={mobileSessionComposer}
                      hasChanges={sessionHasChanges}
                      mobileBackLabel={t.mobile.back}
                      mobileMoreActionsLabel={t.mobile.moreActions}
                      mobileSessionTabsLabel={t.mobile.sessionTabs}
                      onMobileBack={() => undefined}
                    />
                  ) : null
                }
              />
            ) : (
              /* Worktree / diff / design always use the DESKTOP shell — even on
                 phone viewports. A `md:hidden` mobile session used to take over
                 below 768px and made Live Diff / Parallel Worktrees look like a
                 random narrow chat. The shell is force-desktop + CSS-scaled into
                 the reveal frame (see `.landing-desktop-demo-shell`). */
              <div
                ref={demoStageRef}
                className="landing-app-preview-stage min-h-0 w-full flex-1"
                data-focus-zoom={demoFocus.scale > 1.02 ? 'true' : 'false'}
                style={
                  {
                    ...desktopFocusCssVars,
                    ['--ld-focus-scale' as string]: String(demoFocus.scale),
                    ['--ld-focus-fx' as string]: `${demoFocus.fx}px`,
                    ['--ld-focus-fy' as string]: `${demoFocus.fy}px`,
                  } as CSSProperties
                }
              >
                <ForceDesktopLayoutProvider>
                  <div className="landing-desktop-demo-shell flex h-full min-h-0">
                    <div
                      className="min-h-0 shrink-0 border-r border-sidebar-border bg-sidebar-background"
                      onPointerDownCapture={preventStaticSidebarChrome}
                      onClickCapture={preventStaticSidebarChrome}
                      onKeyDownCapture={preventStaticSidebarChromeKeyDown}
                    >
                      <LoroSidebar
                        className="h-full rounded-none border-0"
                        workspaceName={t.workspaceName}
                        userEmail={t.userEmail}
                        labels={sidebarLabels}
                        topContent={sidebarTopContent}
                        workspaces={[
                          { id: 'workspace-lody', name: 'Lody', logo: WORKSPACE_LOGO },
                          { id: 'workspace-loro', name: 'Loro' },
                          { id: 'workspace-demo', name: 'Demo' },
                        ]}
                        currentWorkspaceId={workspaceId}
                        connectionUiState="online"
                        activeNav={selectedTask ? null : activeNav}
                        defaultWidth={296}
                        minWidth={260}
                        maxWidth={340}
                        repoSections={[]}
                        chats={[]}
                        sessionListProps={githubSessionListProps}
                        onWorkspaceSelected={() => undefined}
                        onHomeClicked={() => {
                          setActiveNav('home');
                          setSelectedTaskId(null);
                        }}
                        onArchiveClicked={() => undefined}
                        onDocsClicked={goToDocs}
                        onFeedbackClicked={() => undefined}
                        onSettingsClicked={() => undefined}
                        onInviteClicked={() => undefined}
                        onLinkRepoClicked={() => undefined}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      {selectedTask && sessionTabMeta ? (
                        /* Production has ONE desktop session shell: the right
                           panel (Files / All Changes / …) is always mounted, even
                           on a session with a clean worktree. */
                        <DesktopSessionPreview
                          key={layoutKey}
                          task={selectedTask}
                          repoLabel={selectedRepoLabel}
                          isLocalSession={isSelectedLocalSession}
                          newTabLabel={activeSessionCopy.newTab}
                          parentSession={sessionTabMeta.parentSession}
                          childSessions={sessionTabMeta.childSessions}
                          activeTabSessionId={sessionTabMeta.activeTabSessionId}
                          onSelectTab={(tabId) => setActiveSessionTabId(asSessionId(tabId))}
                          items={sessionItems}
                          sessionStatus={sessionStatus}
                          sessionHistory={sessionMessages}
                          chatUser={chatUser}
                          composer={sessionComposer}
                          locale={locale}
                          isDark={isDark}
                          hasChanges={sessionHasChanges}
                          diffDemo={diffDemoControls}
                          designDemo={designDemoControls}
                        />
                      ) : (
                        <ChatLandingView
                          tone={tone}
                          title={t.landing.title}
                          promptValue={prompt}
                          onPromptChange={setPrompt}
                          promptPlaceholder={t.landing.placeholder}
                          topSelector={topSelector}
                          footerSelector={footerSelector}
                          onSubmit={() => undefined}
                          submitDisabled={prompt.trim().length === 0}
                          onImageAddClick={() => undefined}
                        />
                      )}
                    </div>
                  </div>
                </ForceDesktopLayoutProvider>
              </div>
            )}
          </div>
        </TooltipProvider>
      </I18nextProvider>
    </Provider>
  );
}
