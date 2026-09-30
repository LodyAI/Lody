/**
 * Demo content for the landing product replica: copy, session rows, the scripted
 * conversations, and the mock diff. Only states the feature-tab demos reach are
 * modelled — the preview frame is inert, so nothing else can be opened.
 */

import type { LandingLocale } from './landing';
import type {
  ReplicaAssistantItem,
  ReplicaAssistantMessage,
  ReplicaChangeFile,
  ReplicaMessage,
  ReplicaSessionRow,
  ReplicaToolCall,
  ReplicaUserMessage,
  ReplicaVisualAnnotation,
} from './landing-replica/types';

const now = Date.now();

export const WORKSPACE_LOGO = '/landing/icon-transparent.png';
export const JELLYFISH_IMAGE = {
  src: '/landing/jellyfish.webp',
  width: 1024,
  height: 1536,
  fileName: 'jellyfish.png',
};

// ---- Copy -------------------------------------------------------------------

type PreviewCopy = {
  landing: { title: string; placeholder: string };
  machineName: string;
  /** Selected model / think level / permission mode shown by the composer chips. */
  modelLabel: string;
  thinkLabel: string;
  thinkLevelLabel: string;
  permissionLabel: string;
  modelPickerLabel: string;
  permissionPickerLabel: string;
  agentPickerLabel: string;
  agentName: string;
  localProjectName: string;
  localSessionTitle: string;
  tasks: Record<'task-1' | 'task-2' | 'task-3' | 'task-5', string>;
  jellyfish: { user: string; intro: string };
  openInEditor: string;
  moreActions: string;
  commitAndPush: string;
  createPr: string;
  files: string;
  allChanges: string;
  browser: string;
};

export const PREVIEW_COPY: Record<LandingLocale, PreviewCopy> = {
  en: {
    // 1:1 with the app's rotating landing heading (`chat.heading2`).
    landing: {
      title: 'What should we work on?',
      placeholder: "Press '/' for commands, '@' for mentions.",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: 'Think level',
    // Permission mode labels are agent-provided English in the app.
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: 'Model',
    permissionPickerLabel: 'Permission mode',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: 'Fix roadmap issue timestamps',
    tasks: {
      'task-1': 'Create highlight clipping fix PR',
      'task-2': 'Plan chat font size setting',
      'task-3': 'Fix mobile ACP provider keyboard',
      'task-5': 'Generate jellyfish image',
    },
    jellyfish: {
      user: 'Generate a photo of a translucent jellyfish floating in deep blue water.',
      intro: 'Generated the jellyfish image.',
    },
    openInEditor: 'Open in editor',
    moreActions: 'More actions',
    commitAndPush: 'Commit & Push',
    createPr: 'Create PR',
    files: 'Files',
    allChanges: 'All Changes',
    browser: 'Browser',
  },
  zh: {
    landing: {
      title: '今天想做点什么？',
      placeholder: "按 '/' 使用命令，'@' 添加提及。",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: '思考强度',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: '模型',
    permissionPickerLabel: '权限模式',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: '修复 Roadmap Issue 更新时间',
    tasks: {
      'task-1': '创建高亮裁剪修复 PR',
      'task-2': '规划对话字号设置',
      'task-3': '优化移动端 ACP Provider 键盘',
      'task-5': '生成水母图片',
    },
    jellyfish: {
      user: '生成一张透明水母漂浮在深蓝色海水里的照片。',
      intro: '水母图片已生成。',
    },
    openInEditor: '在编辑器中打开',
    moreActions: '更多操作',
    commitAndPush: '提交并推送',
    createPr: '创建 PR',
    files: '文件',
    allChanges: '全部变更',
    browser: '浏览器',
  },
};

// ---- Session rows -------------------------------------------------------------

export const DIFF_DEMO_TASK_ID = 'task-1';
export const JELLYFISH_TASK_ID = 'task-5';
export const DEMO_PROJECT_NAME = 'lody';
export const DEMO_TASK_ID = 'local-demo-intro';
export const GITHUB_REPO = 'loro-dev/lody';
export const GITHUB_OWNER_AVATAR = 'https://github.com/loro-dev.png?size=64';

export function formatAgeLabel(timestamp: number): string {
  const diffMs = Math.max(0, now - timestamp);
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function row(
  seed: Omit<ReplicaSessionRow, 'ageLabel' | 'hasUnreadMessages' | 'isWaitingPermission'> &
    Partial<Pick<ReplicaSessionRow, 'hasUnreadMessages' | 'isWaitingPermission'>>
): ReplicaSessionRow {
  return {
    hasUnreadMessages: false,
    isWaitingPermission: false,
    ...seed,
    ageLabel: formatAgeLabel(seed.latestMessageAt),
  };
}

/** GitHub worktree sessions + the plain jellyfish chat, newest first per group. */
export function buildTasks(locale: LandingLocale): ReplicaSessionRow[] {
  const titles = PREVIEW_COPY[locale].tasks;
  return [
    row({
      id: 'task-1',
      title: titles['task-1'],
      repoFullName: GITHUB_REPO,
      branchName: 'feat/selection-highlight-clipping',
      prUrl: 'https://github.com/loro-dev/lody/pull/2564',
      prNumber: 2564,
      prStatus: 'open',
      prCiState: 'success',
      prMergeable: true,
      latestMessageAt: now - 8 * 60 * 1000,
      addedLines: 15,
      deletedLines: 2,
      isWorking: false,
      isWorktree: true,
    }),
    row({
      id: 'task-2',
      title: titles['task-2'],
      repoFullName: GITHUB_REPO,
      branchName: 'plan/chat-font-size-setting',
      latestMessageAt: now - 37 * 60 * 1000,
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: true,
      isWaitingPermission: true,
      isWorktree: true,
    }),
    row({
      id: 'task-3',
      title: titles['task-3'],
      repoFullName: GITHUB_REPO,
      branchName: 'fix/mobile-acp-provider-keyboard',
      prUrl: 'https://github.com/loro-dev/lody/pull/2520',
      prNumber: 2520,
      prStatus: 'merged',
      prCiState: 'success',
      latestMessageAt: now - 3 * 60 * 60 * 1000,
      addedLines: 23,
      deletedLines: 9,
      isWorking: false,
      isWorktree: true,
    }),
    row({
      id: JELLYFISH_TASK_ID,
      title: titles['task-5'],
      repoFullName: null,
      branchName: '',
      latestMessageAt: now - 2 * 60 * 60 * 1000,
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      hasUnreadMessages: true,
      isWorktree: false,
    }),
  ];
}

/** The `lody-feedback` local project's one session. It sorts first on the mobile
    home (latest activity) while the sidebar row keeps its seeded "1h" age. */
export function buildLocalSession(locale: LandingLocale): ReplicaSessionRow {
  return {
    ...row({
      id: 'local-1',
      title: PREVIEW_COPY[locale].localSessionTitle,
      repoFullName: PREVIEW_COPY[locale].localProjectName,
      branchName: 'codex/fix-roadmap-updated-at',
      latestMessageAt: now,
      addedLines: 0,
      deletedLines: 0,
      isWorking: false,
      isWorktree: false,
    }),
    ageLabel: '1h',
  };
}

// ---- Scripted conversations -----------------------------------------------------

function userMessage(id: string, text: string, timestamp: string): ReplicaUserMessage {
  return { id, role: 'user', timestamp, text };
}

function assistantMessage(
  id: string,
  items: ReplicaAssistantItem[],
  timestamp: string,
  options?: { agent?: 'codex' | 'claude'; finished?: boolean }
): ReplicaAssistantMessage {
  const agent = options?.agent ?? 'codex';
  return {
    id,
    role: 'assistant',
    timestamp,
    items,
    finished: options?.finished ?? true,
    agent,
    modelLabel: agent === 'claude' ? 'Opus' : '5.5',
  };
}

function toolCall(
  kind: ReplicaToolCall['kind'],
  title: string,
  id: string,
  status: ReplicaToolCall['status'] = 'completed'
): ReplicaToolCall {
  return { type: 'tool_call', kind, title, id, status };
}

/** Diff demo: the finished GitHub session that fixed the sidebar clipping. */
export function buildLodyPrHistory(locale: LandingLocale): ReplicaMessage[] {
  const isZh = locale === 'zh';
  const claude = { agent: 'claude' as const };
  return [
    userMessage(
      'lody-pr-user-investigate',
      isZh
        ? '选中对话或者项目的时候，高亮背景两边会被裁剪一点点。你研究一下是不是容器应该大一点？'
        : 'When a conversation or project is selected, the highlighted background is clipped slightly on both sides. Can you investigate whether the container needs more room?',
      '2026-06-21T09:07:13.599Z'
    ),
    assistantMessage(
      'lody-pr-assistant-fix',
      [
        {
          type: 'text',
          text: isZh
            ? '我先定位侧边栏的渲染入口和选中态样式，再用一个最小复现验证是不是容器裁剪导致的。'
            : 'I will trace the sidebar rendering path and selected-state styling, then verify whether container clipping is the actual cause with a minimal repro.',
        },
        toolCall(
          'read',
          isZh ? '读取 context/hotspots.md' : 'Read context/hotspots.md',
          'landing-lody-pr-read-hotspots'
        ),
        toolCall(
          'read',
          isZh
            ? '读取 packages/components/src/components/loro-sidebar.tsx'
            : 'Read packages/components/src/components/loro-sidebar.tsx',
          'landing-lody-pr-read-sidebar'
        ),
        toolCall(
          'execute',
          isZh ? '复现 Radix ScrollArea 裁剪' : 'Reproduce Radix ScrollArea clipping',
          'landing-lody-pr-repro'
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
        toolCall(
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
      '2026-06-21T09:11:44.000Z',
      claude
    ),
    userMessage(
      'lody-pr-user-create-pr',
      isZh ? '为当前分支创建 PR。' : 'Create a PR for the current branch.',
      '2026-06-21T09:18:20.000Z'
    ),
    assistantMessage(
      'lody-pr-assistant-create-pr',
      [
        {
          type: 'text',
          text: isZh
            ? '我会检查当前分支和 diff，提交这个修复，然后推送并创建 PR。'
            : 'I will check the current branch and diff, commit this fix, then push and create the PR.',
        },
        toolCall(
          'execute',
          isZh ? '检查 git 状态和 diff' : 'Check git status and diff',
          'landing-lody-pr-git-status'
        ),
        toolCall(
          'execute',
          isZh
            ? '提交 fix: stop sidebar selection outline being clipped on the sides'
            : 'Commit fix: stop sidebar selection outline being clipped on the sides',
          'landing-lody-pr-commit'
        ),
        toolCall(
          'execute',
          isZh
            ? '推送 feat/selection-highlight-clipping'
            : 'Push feat/selection-highlight-clipping',
          'landing-lody-pr-push'
        ),
        toolCall(
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
      '2026-06-21T09:22:40.000Z',
      claude
    ),
    assistantMessage(
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
      '2026-06-21T09:25:10.000Z',
      claude
    ),
  ];
}

export const DEMO_COPY: Record<
  LandingLocale,
  { promptText: string; reply: string; branchLabel: string }
> = {
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

/** The worktree demo's freshly created local session (appears on send). */
export function buildDemoTask(locale: LandingLocale, isWorking: boolean): ReplicaSessionRow {
  return row({
    id: DEMO_TASK_ID,
    title: DEMO_COPY[locale].promptText,
    repoFullName: DEMO_PROJECT_NAME,
    branchName: 'main',
    latestMessageAt: now,
    addedLines: 0,
    deletedLines: 0,
    isWorking,
    isWorktree: true,
  });
}

export function buildDemoIntroHistory(
  locale: LandingLocale,
  stream: { text: string; done: boolean } | null
): ReplicaMessage[] {
  const d = DEMO_COPY[locale];
  const messages: ReplicaMessage[] = [
    userMessage(`${DEMO_TASK_ID}-user`, d.promptText, '2026-07-04T02:10:00.000Z'),
  ];
  if (stream) {
    messages.push(
      assistantMessage(
        `${DEMO_TASK_ID}-reply`,
        [{ type: 'text', text: stream.text }],
        '2026-07-04T02:10:06.000Z',
        { finished: stream.done }
      )
    );
  }
  return messages;
}

export const DESIGN_DEMO_COPY: Record<
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

/** The Browser-preview comment, staged in the composer and carried into history. */
export function buildDesignAnnotation(locale: LandingLocale): ReplicaVisualAnnotation {
  return {
    body: DESIGN_DEMO_COPY[locale].comment,
    authorName: 'Leon',
    selector: 'main > section.hero > p:nth-of-type(2)',
    targetText: 'Conversations, diffs, and previews stay in sync — desktop, browser, or phone.',
    tag: 'p',
  };
}

/** Progress of the two scripted design-demo turns. */
export type DesignDemoTurns = {
  turn2User: boolean;
  turn2: { devDone: boolean; reportDone: boolean; text: string; done: boolean } | null;
  turn3User: boolean;
  turn3: { editDone: boolean; text: string; done: boolean } | null;
};

export const INITIAL_DESIGN_TURNS: DesignDemoTurns = {
  turn2User: false,
  turn2: null,
  turn3User: false,
  turn3: null,
};

export function buildDesignDemoHistory(
  locale: LandingLocale,
  turns: DesignDemoTurns
): ReplicaMessage[] {
  const d = DESIGN_DEMO_COPY[locale];
  // Starts from tab-1's completed intro conversation.
  const messages = buildDemoIntroHistory(locale, { text: DEMO_COPY[locale].reply, done: true });
  if (turns.turn2User) {
    messages.push(userMessage(`${DEMO_TASK_ID}-design-user`, d.prompt, '2026-07-04T02:14:00.000Z'));
  }
  if (turns.turn2) {
    const items: ReplicaAssistantItem[] = [
      { type: 'text', text: d.turn2Intro },
      toolCall(
        'execute',
        'pnpm dev --filter @lody/landing',
        'design-dev-server',
        turns.turn2.devDone ? 'completed' : 'in_progress'
      ),
    ];
    if (turns.turn2.devDone) {
      // The real MCP tool the CLI exposes for this.
      items.push(
        toolCall(
          'other',
          'lody_report_preview_candidate (MCP)',
          'design-report-preview',
          turns.turn2.reportDone ? 'completed' : 'in_progress'
        )
      );
    }
    if (turns.turn2.text) items.push({ type: 'text', text: turns.turn2.text });
    messages.push(
      assistantMessage(`${DEMO_TASK_ID}-design-reply`, items, '2026-07-04T02:14:06.000Z', {
        finished: turns.turn2.done,
      })
    );
  }
  if (turns.turn3User) {
    // Sent from the staged chip: the user message carries only the annotation.
    messages.push({
      id: `${DEMO_TASK_ID}-design-user-edit`,
      role: 'user',
      timestamp: '2026-07-04T02:15:30.000Z',
      annotation: buildDesignAnnotation(locale),
    });
  }
  if (turns.turn3) {
    const items: ReplicaAssistantItem[] = [
      { type: 'text', text: d.turn3Intro },
      toolCall(
        'edit',
        locale === 'zh'
          ? '修改 apps/landing/src/components/hero.tsx'
          : 'Edit apps/landing/src/components/hero.tsx',
        'design-edit-hero',
        turns.turn3.editDone ? 'completed' : 'in_progress'
      ),
    ];
    if (turns.turn3.text) items.push({ type: 'text', text: turns.turn3.text });
    messages.push(
      assistantMessage(`${DEMO_TASK_ID}-design-reply-edit`, items, '2026-07-04T02:15:36.000Z', {
        finished: turns.turn3.done,
      })
    );
  }
  return messages;
}

/** Mobile demo: the jellyfish chat, streamed; the finished turn carries the image. */
export function buildJellyfishHistory(
  locale: LandingLocale,
  turn: { text: string; image: boolean; done: boolean } | null
): ReplicaMessage[] {
  const copy = PREVIEW_COPY[locale].jellyfish;
  const messages: ReplicaMessage[] = [
    userMessage('mobile-jelly-user', copy.user, '2026-07-04T02:20:00.000Z'),
  ];
  if (turn && (turn.text || turn.image)) {
    const items: ReplicaAssistantItem[] = [];
    if (turn.text) items.push({ type: 'text', text: turn.text });
    if (turn.image) items.push({ type: 'image', image: JELLYFISH_IMAGE });
    messages.push(
      assistantMessage('mobile-jelly-reply', items, '2026-07-04T02:20:06.000Z', {
        finished: turn.done,
      })
    );
  }
  return messages;
}

// ---- Changes ---------------------------------------------------------------------

/** The two files the clipping fix touched, as shown by the diff demo. */
export const MOCK_CHANGE_FILES: ReplicaChangeFile[] = [
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
