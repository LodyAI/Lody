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
  'zh-hant': {
    landing: {
      title: '今天想做些什麼？',
      placeholder: "按 '/' 使用指令，'@' 加入提及。",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: '思考強度',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: '模型',
    permissionPickerLabel: '權限模式',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: '修復 Roadmap Issue 更新時間',
    tasks: {
      'task-1': '建立高亮裁切修正 PR',
      'task-2': '規劃對話字體大小設定',
      'task-3': '修正行動端 ACP Provider 鍵盤',
      'task-5': '生成水母圖片',
    },
    jellyfish: {
      user: '生成一張透明水母漂浮在深藍海水中的照片。',
      intro: '水母圖片已生成。',
    },
    openInEditor: '在編輯器中開啟',
    moreActions: '更多操作',
    commitAndPush: '提交並推送',
    createPr: '建立 PR',
    files: '檔案',
    allChanges: '全部變更',
    browser: '瀏覽器',
  },
  ja: {
    landing: {
      title: '何に取り組みましょうか？',
      placeholder: "'/' でコマンド、'@' でメンションを入力。",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: '思考レベル',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: 'モデル',
    permissionPickerLabel: '権限モード',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: 'ロードマップ Issue の更新日時を修正',
    tasks: {
      'task-1': 'ハイライト見切れ修正の PR を作成',
      'task-2': 'チャット文字サイズ設定を設計',
      'task-3': 'モバイル ACP プロバイダーのキーボードを修正',
      'task-5': 'クラゲの画像を生成',
    },
    jellyfish: {
      user: '深い青い海に浮かぶ半透明のクラゲの写真を生成してください。',
      intro: 'クラゲの画像を生成しました。',
    },
    openInEditor: 'エディターで開く',
    moreActions: 'その他の操作',
    commitAndPush: 'コミットしてプッシュ',
    createPr: 'PR を作成',
    files: 'ファイル',
    allChanges: 'すべての変更',
    browser: 'ブラウザー',
  },
  ko: {
    landing: {
      title: '무엇을 함께 작업할까요?',
      placeholder: "'/'로 명령어, '@'로 멘션을 입력하세요.",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: '사고 수준',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: '모델',
    permissionPickerLabel: '권한 모드',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: '로드맵 이슈 타임스탬프 수정',
    tasks: {
      'task-1': '하이라이트 잘림 수정 PR 생성',
      'task-2': '채팅 글꼴 크기 설정 계획',
      'task-3': '모바일 ACP 프로바이더 키보드 수정',
      'task-5': '해파리 이미지 생성',
    },
    jellyfish: {
      user: '깊은 푸른 바다에 떠 있는 반투명 해파리 사진을 생성해 줘.',
      intro: '해파리 이미지를 생성했습니다.',
    },
    openInEditor: '에디터에서 열기',
    moreActions: '더 많은 작업',
    commitAndPush: '커밋 및 푸시',
    createPr: 'PR 생성',
    files: '파일',
    allChanges: '모든 변경 사항',
    browser: '브라우저',
  },
  es: {
    landing: {
      title: '¿En qué deberíamos trabajar?',
      placeholder: "Pulsa '/' para comandos y '@' para menciones.",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: 'Nivel de razonamiento',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: 'Modelo',
    permissionPickerLabel: 'Modo de permisos',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: 'Corregir marcas de tiempo de issues en el roadmap',
    tasks: {
      'task-1': 'Crear PR para corregir recorte de resaltado',
      'task-2': 'Planificar ajuste de tamaño de fuente del chat',
      'task-3': 'Corregir teclado del proveedor ACP en móvil',
      'task-5': 'Generar imagen de medusa',
    },
    jellyfish: {
      user: 'Genera una foto de una medusa translúcida flotando en aguas azul profundo.',
      intro: 'Imagen de la medusa generada.',
    },
    openInEditor: 'Abrir en el editor',
    moreActions: 'Más acciones',
    commitAndPush: 'Confirmar y subir',
    createPr: 'Crear PR',
    files: 'Archivos',
    allChanges: 'Todos los cambios',
    browser: 'Navegador',
  },
  fr: {
    landing: {
      title: 'Sur quoi devons-nous travailler ?',
      placeholder: "Appuyez sur '/' pour les commandes, '@' pour les mentions.",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: 'Niveau de réflexion',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: 'Modèle',
    permissionPickerLabel: "Mode d'autorisation",
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: 'Corriger les horodatages des tickets de feuille de route',
    tasks: {
      'task-1': 'Créer une PR pour corriger la découpe de sélection',
      'task-2': 'Planifier le réglage de taille de police du chat',
      'task-3': 'Corriger le clavier mobile du fournisseur ACP',
      'task-5': 'Générer une image de méduse',
    },
    jellyfish: {
      user: 'Génère une photo de méduse translucide flottant dans une eau bleu profond.',
      intro: "L'image de méduse a été générée.",
    },
    openInEditor: "Ouvrir dans l'éditeur",
    moreActions: "Plus d'actions",
    commitAndPush: 'Commit et push',
    createPr: 'Créer une PR',
    files: 'Fichiers',
    allChanges: 'Toutes les modifications',
    browser: 'Navigateur',
  },
  ru: {
    landing: {
      title: 'Над чем поработаем?',
      placeholder: "Нажмите '/' для команд, '@' для упоминаний.",
    },
    machineName: 'Mac Studio',
    modelLabel: '5.5',
    thinkLabel: 'Medium',
    thinkLevelLabel: 'Уровень размышлений',
    permissionLabel: 'Agent (full access)',
    modelPickerLabel: 'Модель',
    permissionPickerLabel: 'Режим разрешений',
    agentPickerLabel: 'ACP Provider',
    agentName: 'Codex',
    localProjectName: 'lody-feedback',
    localSessionTitle: 'Исправить метки времени задач дорожной карты',
    tasks: {
      'task-1': 'Создать PR с исправлением обрезки выделения',
      'task-2': 'Спланировать настройку размера шрифта чата',
      'task-3': 'Исправить клавиатуру ACP-провайдера на мобильных',
      'task-5': 'Сгенерировать изображение медузы',
    },
    jellyfish: {
      user: 'Сгенерируй фото полупрозрачной медузы, парящей в глубокой синей воде.',
      intro: 'Изображение медузы готово.',
    },
    openInEditor: 'Открыть в редакторе',
    moreActions: 'Другие действия',
    commitAndPush: 'Коммит и пуш',
    createPr: 'Создать PR',
    files: 'Файлы',
    allChanges: 'Все изменения',
    browser: 'Браузер',
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

type PrHistoryCopy = {
  userInvestigate: string;
  traceText: string;
  readHotspots: string;
  readSidebar: string;
  repro: string;
  rootCause: string;
  editSidebar: string;
  fixedSummary: string;
  userCreatePr: string;
  createPrIntro: string;
  gitStatus: string;
  gitCommit: string;
  gitPush: string;
  createPrTool: string;
  prCreatedText: string;
  upstreamConfirmedText: string;
};

const PR_HISTORY_COPY: Record<LandingLocale, PrHistoryCopy> = {
  en: {
    userInvestigate:
      'When a conversation or project is selected, the highlighted background is clipped slightly on both sides. Can you investigate whether the container needs more room?',
    traceText:
      'I will trace the sidebar rendering path and selected-state styling, then verify whether container clipping is the actual cause with a minimal repro.',
    readHotspots: 'Read context/hotspots.md',
    readSidebar: 'Read packages/components/src/components/loro-sidebar.tsx',
    repro: 'Reproduce Radix ScrollArea clipping',
    rootCause: [
      'Root cause confirmed: the selected-state `outline` is painted outside the row box, while the horizontal gutter lived on the `ScrollArea` root. The inner Radix viewport is the actual clipping boundary, so the left and right 1px outline was shaved off.',
      '',
      'The fix is to move the horizontal gutter to the viewport: rows keep the same visual position, the scrollbar position is unchanged, and the outline has room to render fully.',
    ].join('\n'),
    editSidebar: 'Edit packages/components/src/components/loro-sidebar.tsx',
    fixedSummary:
      'Fixed. This covers chat/PR rows, local project sessions, local project folders, and updated-mode rows because they all render inside the same sidebar ScrollArea.',
    userCreatePr: 'Create a PR for the current branch.',
    createPrIntro:
      'I will check the current branch and diff, commit this fix, then push and create the PR.',
    gitStatus: 'Check git status and diff',
    gitCommit: 'Commit fix: stop sidebar selection outline being clipped on the sides',
    gitPush: 'Push feat/selection-highlight-clipping',
    createPrTool: 'Create GitHub PR #2564',
    prCreatedText: [
      'PR created: **https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- Branch: `feat/selection-highlight-clipping` -> `main`',
      '- Commit: `fix: stop sidebar selection outline being clipped on the sides`',
      '- Change: only `loro-sidebar.tsx`, moving the horizontal gutter to the viewport so selected highlights are not clipped on the sides.',
    ].join('\n'),
    upstreamConfirmedText: [
      'Remote state is confirmed. Commit `119f8827` is on `origin/feat/selection-highlight-clipping`, and PR #2564 was created from that commit.',
      '',
      'It only looked unpushed because the local branch was still tracking `origin/main`. I set the upstream to the correct remote branch, and `git status` now shows the branch is even with the remote.',
      '',
      'Nothing left to push.',
    ].join('\n'),
  },
  zh: {
    userInvestigate:
      '选中对话或者项目的时候，高亮背景两边会被裁剪一点点。你研究一下是不是容器应该大一点？',
    traceText: '我先定位侧边栏的渲染入口和选中态样式，再用一个最小复现验证是不是容器裁剪导致的。',
    readHotspots: '读取 context/hotspots.md',
    readSidebar: '读取 packages/components/src/components/loro-sidebar.tsx',
    repro: '复现 Radix ScrollArea 裁剪',
    rootCause: [
      '确认根因：选中态的 `outline` 画在盒子外侧，但横向留白在 `ScrollArea` root 上，内部 Radix viewport 是真正的裁剪边界，所以左右 1px 被削掉。',
      '',
      '修法是把横向 gutter 移到 viewport：列表行仍保持相同位置，滚动条位置不变，但 outline 有空间完整绘制。',
    ].join('\n'),
    editSidebar: '修改 packages/components/src/components/loro-sidebar.tsx',
    fixedSummary:
      '已经修好。这个改动覆盖聊天/PR 行、本地项目 session、本地项目文件夹和 Updated 模式行，因为它们都在同一个 sidebar ScrollArea 里。',
    userCreatePr: '为当前分支创建 PR。',
    createPrIntro: '我会检查当前分支和 diff，提交这个修复，然后推送并创建 PR。',
    gitStatus: '检查 git 状态和 diff',
    gitCommit: '提交 fix: stop sidebar selection outline being clipped on the sides',
    gitPush: '推送 feat/selection-highlight-clipping',
    createPrTool: '创建 GitHub PR #2564',
    prCreatedText: [
      'PR 已创建：**https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- 分支：`feat/selection-highlight-clipping` -> `main`',
      '- 提交：`fix: stop sidebar selection outline being clipped on the sides`',
      '- 改动：只修改 `loro-sidebar.tsx`，把横向 gutter 移到 viewport，避免选中高亮左右被裁剪。',
    ].join('\n'),
    upstreamConfirmedText: [
      '远端状态也确认好了。提交 `119f8827` 已在 `origin/feat/selection-highlight-clipping` 上，PR #2564 就是基于这个提交创建的。',
      '',
      '之前看起来像没 push，是因为本地分支还在跟踪 `origin/main`。我已经把 upstream 设置到正确的远端分支，`git status` 现在显示本地和远端一致。',
      '',
      '没有剩余内容需要 push。',
    ].join('\n'),
  },
  'zh-hant': {
    userInvestigate:
      '選取對話或專案時，高亮背景的左右兩側會被稍微裁切。可以幫我檢查是不是容器空間不夠嗎？',
    traceText: '我先追蹤側邊欄的渲染路徑與選取狀態樣式，再以最小重現確認是否為容器裁切所致。',
    readHotspots: '讀取 context/hotspots.md',
    readSidebar: '讀取 packages/components/src/components/loro-sidebar.tsx',
    repro: '重現 Radix ScrollArea 裁切',
    rootCause: [
      '確認根因：選取狀態的 `outline` 繪製在元素框外側，但水平留白設在 `ScrollArea` root 上，內層 Radix viewport 才是實際裁切邊界，因此左右 1px 被削掉了。',
      '',
      '修正方式是將水平 gutter 移至 viewport：列表列維持相同視覺位置，捲軸位置不變，同時讓 outline 有完整繪製空間。',
    ].join('\n'),
    editSidebar: '編輯 packages/components/src/components/loro-sidebar.tsx',
    fixedSummary:
      '已修復。此變更涵蓋聊天/PR 列、本機專案工作階段、本機專案資料夾以及更新模式列，因為它們都在同一個側邊欄 ScrollArea 內。',
    userCreatePr: '為目前分支建立 PR。',
    createPrIntro: '我會先檢查目前分支與 diff，提交這個修正，再推送並建立 PR。',
    gitStatus: '檢查 git 狀態與 diff',
    gitCommit: '提交 fix: stop sidebar selection outline being clipped on the sides',
    gitPush: '推送 feat/selection-highlight-clipping',
    createPrTool: '建立 GitHub PR #2564',
    prCreatedText: [
      'PR 已建立：**https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- 分支：`feat/selection-highlight-clipping` -> `main`',
      '- 提交：`fix: stop sidebar selection outline being clipped on the sides`',
      '- 變更：僅修改 `loro-sidebar.tsx`，將水平 gutter 移至 viewport，避免選取高亮在兩側遭裁切。',
    ].join('\n'),
    upstreamConfirmedText: [
      '遠端狀態也已確認。提交 `119f8827` 已位於 `origin/feat/selection-highlight-clipping`，PR #2564 即是由該提交建立。',
      '',
      '先前看起來像尚未推送，是因為本機分支仍追蹤 `origin/main`。我已將 upstream 設為正確的遠端分支，`git status` 現已顯示本地與遠端一致。',
      '',
      '沒有其餘內容需要推送。',
    ].join('\n'),
  },
  ja: {
    userInvestigate:
      '会話やプロジェクトを選択したとき、ハイライト背景の両端が少し見切れています。コンテナ幅に余裕が必要か調べてもらえますか？',
    traceText:
      'サイドバーの描画経路と選択中スタイルをたどり、最小再現でコンテナのクリッピングが原因か検証します。',
    readHotspots: 'context/hotspots.md を読み込み',
    readSidebar: 'packages/components/src/components/loro-sidebar.tsx を読み込み',
    repro: 'Radix ScrollArea のクリッピングを再現',
    rootCause: [
      '原因を特定しました：選択状態の `outline` はボックスの外側に描画されますが、左右の余白が `ScrollArea` のルートに付いており、内側の Radix viewport が実際のクリッピング境界になって左右 1px が削られていました。',
      '',
      '左右のガターを viewport 側へ移すことで、行の位置もスクロールバーも変えずに outline 全体を描画できます。',
    ].join('\n'),
    editSidebar: 'packages/components/src/components/loro-sidebar.tsx を編集',
    fixedSummary:
      '修正しました。チャット/PR 行、ローカルプロジェクトのセッション、フォルダ行、更新モード行はすべて同じサイドバーの ScrollArea 内にあるため一括で解消されます。',
    userCreatePr: '現在のブランチで PR を作成して。',
    createPrIntro:
      '現在のブランチと差分を確認し、この修正をコミットしてプッシュ後に PR を作成します。',
    gitStatus: 'git status と差分を確認',
    gitCommit: 'コミット fix: stop sidebar selection outline being clipped on the sides',
    gitPush: 'feat/selection-highlight-clipping をプッシュ',
    createPrTool: 'GitHub PR #2564 を作成',
    prCreatedText: [
      'PR を作成しました：**https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- ブランチ：`feat/selection-highlight-clipping` -> `main`',
      '- コミット：`fix: stop sidebar selection outline being clipped on the sides`',
      '- 変更点：`loro-sidebar.tsx` のみ。左右ガターを viewport に移し、選択ハイライトの見切れを防ぎました。',
    ].join('\n'),
    upstreamConfirmedText: [
      'リモート状態も確認済みです。コミット `119f8827` は `origin/feat/selection-highlight-clipping` に反映されており、PR #2564 はこのコミットから作成されています。',
      '',
      '未プッシュに見えたのはローカルブランチが `origin/main` を追跡していたためです。正しいリモートブランチを upstream に設定し、`git status` でも一致を確認しました。',
      '',
      '追加でプッシュする変更はありません。',
    ].join('\n'),
  },
  ko: {
    userInvestigate:
      '대화나 프로젝트를 선택할 때 하이라이트 배경 양쪽이 살짝 잘립니다. 컨테이너 여백이 더 필요한지 확인해 줄래요?',
    traceText:
      '사이드바 렌더링 경로와 선택 상태 스타일을 추적한 뒤 최소 재현으로 컨테이너 클리핑이 원인인지 검증하겠습니다.',
    readHotspots: 'context/hotspots.md 읽기',
    readSidebar: 'packages/components/src/components/loro-sidebar.tsx 읽기',
    repro: 'Radix ScrollArea 클리핑 재현',
    rootCause: [
      '원인을 확인했습니다. 선택 상태 `outline`은 요소 바깥에 그려지는데 가로 여백이 `ScrollArea` 루트에 있어 내부 Radix viewport가 실제 클리핑 경계가 되며 좌우 1px이 잘렸습니다.',
      '',
      '가로 여백을 viewport로 옮기면 행 위치와 스크롤바는 그대로 유지되면서 outline이 온전히 표시됩니다.',
    ].join('\n'),
    editSidebar: 'packages/components/src/components/loro-sidebar.tsx 수정',
    fixedSummary:
      '수정했습니다. 채팅/PR 행, 로컬 프로젝트 세션, 폴더, 업데이트 모드 행 모두 같은 사이드바 ScrollArea 안에서 렌더링되므로 함께 해결됩니다.',
    userCreatePr: '현재 브랜치로 PR을 만들어 줘.',
    createPrIntro: '현재 브랜치와 diff를 확인하고 수정 사항을 커밋·푸시한 뒤 PR을 생성하겠습니다.',
    gitStatus: 'git status 및 diff 확인',
    gitCommit: '커밋 fix: stop sidebar selection outline being clipped on the sides',
    gitPush: 'feat/selection-highlight-clipping 푸시',
    createPrTool: 'GitHub PR #2564 생성',
    prCreatedText: [
      'PR이 생성되었습니다: **https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- 브랜치: `feat/selection-highlight-clipping` -> `main`',
      '- 커밋: `fix: stop sidebar selection outline being clipped on the sides`',
      '- 변경 사항: `loro-sidebar.tsx`에서 가로 여백을 viewport로 이동해 선택 하이라이트 양쪽 잘림을 방지했습니다.',
    ].join('\n'),
    upstreamConfirmedText: [
      '원격 상태도 확인했습니다. 커밋 `119f8827`이 `origin/feat/selection-highlight-clipping`에 반영되어 있으며 PR #2564는 이 커밋을 기준으로 생성되었습니다.',
      '',
      '푸시되지 않은 것처럼 보였던 이유는 로컬 브랜치가 여전히 `origin/main`을 추적하고 있었기 때문입니다. 올바른 원격 브랜치로 upstream을 설정했고 `git status`도 일치합니다.',
      '',
      '추가로 푸시할 내용은 없습니다.',
    ].join('\n'),
  },
  es: {
    userInvestigate:
      'Cuando se selecciona una conversación o un proyecto, el fondo resaltado se recorta ligeramente a ambos lados. ¿Puedes investigar si el contenedor necesita más espacio?',
    traceText:
      'Rastrearé la ruta de renderizado de la barra lateral y los estilos de selección, y luego comprobaré con una reproducción mínima si el recorte del contenedor es la causa.',
    readHotspots: 'Leer context/hotspots.md',
    readSidebar: 'Leer packages/components/src/components/loro-sidebar.tsx',
    repro: 'Reproducir recorte de Radix ScrollArea',
    rootCause: [
      'Causa raíz confirmada: el `outline` de selección se dibuja fuera de la caja de la fila, mientras que el margen horizontal estaba en la raíz de `ScrollArea`. El viewport interno de Radix actúa como límite de recorte, cortando 1px a izquierda y derecha.',
      '',
      'La solución es mover el margen horizontal al viewport: las filas conservan su posición, la barra de desplazamiento no cambia y el contorno se renderiza completo.',
    ].join('\n'),
    editSidebar: 'Editar packages/components/src/components/loro-sidebar.tsx',
    fixedSummary:
      'Corregido. Esto cubre filas de chat/PR, sesiones de proyectos locales, carpetas locales y filas en modo actualizado porque todas se renderizan dentro del mismo ScrollArea.',
    userCreatePr: 'Crea un PR para la rama actual.',
    createPrIntro:
      'Comprobaré la rama actual y el diff, haré commit de la corrección, subiré los cambios y crearé el PR.',
    gitStatus: 'Comprobar git status y diff',
    gitCommit: 'Confirmar fix: stop sidebar selection outline being clipped on the sides',
    gitPush: 'Subir feat/selection-highlight-clipping',
    createPrTool: 'Crear GitHub PR #2564',
    prCreatedText: [
      'PR creado: **https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- Rama: `feat/selection-highlight-clipping` -> `main`',
      '- Commit: `fix: stop sidebar selection outline being clipped on the sides`',
      '- Cambio: solo `loro-sidebar.tsx`, moviendo el margen horizontal al viewport para que el resaltado no se recorte.',
    ].join('\n'),
    upstreamConfirmedText: [
      'Estado remoto confirmado. El commit `119f8827` ya está en `origin/feat/selection-highlight-clipping` y el PR #2564 se creó desde ese commit.',
      '',
      'Solo parecía sin subir porque la rama local seguía rastreando `origin/main`. Configuré el upstream correcto y `git status` muestra que la rama está sincronizada.',
      '',
      'No queda nada por subir.',
    ].join('\n'),
  },
  fr: {
    userInvestigate:
      "Lorsqu'une conversation ou un projet est sélectionné, le fond en surbrillance est légèrement rogné sur les deux côtés. Peux-tu vérifier si le conteneur manque d'espace ?",
    traceText:
      "Je vais remonter le rendu de la barre latérale et le style d'état sélectionné, puis vérifier avec une reproduction minimale si le rognage du conteneur est en cause.",
    readHotspots: 'Lire context/hotspots.md',
    readSidebar: 'Lire packages/components/src/components/loro-sidebar.tsx',
    repro: 'Reproduire le rognage de Radix ScrollArea',
    rootCause: [
      "Cause confirmée : le contour `outline` sélectionné est dessiné à l'extérieur de la ligne, alors que la marge horizontale était posée sur la racine `ScrollArea`. Le viewport interne de Radix sert de limite de découpe et rognait 1px de chaque côté.",
      '',
      "La correction déplace la marge horizontale sur le viewport : les lignes gardent la même position, la barre de défilement ne bouge pas et l'outline s'affiche en entier.",
    ].join('\n'),
    editSidebar: 'Modifier packages/components/src/components/loro-sidebar.tsx',
    fixedSummary:
      'Corrigé. Cela couvre les lignes de chat/PR, les sessions locales, les dossiers locaux et les lignes en mode mis à jour puisqu’elles partagent le même ScrollArea.',
    userCreatePr: 'Crée une PR pour la branche courante.',
    createPrIntro:
      'Je vais vérifier la branche actuelle et le diff, valider ce correctif, puis pousser et ouvrir la PR.',
    gitStatus: 'Vérifier git status et le diff',
    gitCommit: 'Commit fix: stop sidebar selection outline being clipped on the sides',
    gitPush: 'Pousser feat/selection-highlight-clipping',
    createPrTool: 'Créer la PR GitHub #2564',
    prCreatedText: [
      'PR créée : **https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- Branche : `feat/selection-highlight-clipping` -> `main`',
      '- Commit : `fix: stop sidebar selection outline being clipped on the sides`',
      '- Modification : uniquement `loro-sidebar.tsx`, déplacement de la marge horizontale vers le viewport pour éviter tout rognage.',
    ].join('\n'),
    upstreamConfirmedText: [
      "État distant confirmé. Le commit `119f8827` est bien sur `origin/feat/selection-highlight-clipping` et la PR #2564 s'appuie dessus.",
      '',
      "La branche semblait non poussée uniquement parce qu'elle suivait encore `origin/main`. J'ai mis à jour l'upstream et `git status` indique que tout est synchronisé.",
      '',
      'Rien de plus à pousser.',
    ].join('\n'),
  },
  ru: {
    userInvestigate:
      'Когда выбран диалог или проект, подсветка фона слегка обрезается с обоих краёв. Проверь, пожалуйста, не слишком ли узкий контейнер?',
    traceText:
      'Прослежу рендеринг боковой панели и стили выделения, затем на минимальном примере проверю, виновата ли обрезка контейнера.',
    readHotspots: 'Чтение context/hotspots.md',
    readSidebar: 'Чтение packages/components/src/components/loro-sidebar.tsx',
    repro: 'Воспроизведение обрезки Radix ScrollArea',
    rootCause: [
      'Причина подтверждена: `outline` выбранного элемента рисуется снаружи блока строки, а горизонтальные отступы заданы на корневом `ScrollArea`. Внутренний Radix viewport задаёт границу обрезки и срезает по 1px слева и справа.',
      '',
      'Решение — перенести горизонтальный отступ во viewport: строки и полоса прокрутки останутся на местах, а обводка будет рисоваться полностью.',
    ].join('\n'),
    editSidebar: 'Изменение packages/components/src/components/loro-sidebar.tsx',
    fixedSummary:
      'Исправлено. Изменение охватывает строки чатов и PR, локальные сессии, папки проектов и режим обновлений, так как все они рендерятся в одном ScrollArea.',
    userCreatePr: 'Создай PR для текущей ветки.',
    createPrIntro:
      'Проверю текущую ветку и diff, закоммичу исправление, отправлю изменения и создам PR.',
    gitStatus: 'Проверка git status и diff',
    gitCommit: 'Коммит fix: stop sidebar selection outline being clipped on the sides',
    gitPush: 'Отправка feat/selection-highlight-clipping',
    createPrTool: 'Создание GitHub PR #2564',
    prCreatedText: [
      'PR создан: **https://github.com/loro-dev/lody/pull/2564**',
      '',
      '- Ветка: `feat/selection-highlight-clipping` -> `main`',
      '- Коммит: `fix: stop sidebar selection outline being clipped on the sides`',
      '- Изменение: только `loro-sidebar.tsx` — перенос горизонтального отступа во viewport, чтобы подсветка выделения не обрезалась.',
    ].join('\n'),
    upstreamConfirmedText: [
      'Состояние на удалённом сервере подтверждено. Коммит `119f8827` уже в `origin/feat/selection-highlight-clipping`, и PR #2564 создан на его основе.',
      '',
      'Казалось, что ветка не отправлена, только потому что локальная ветка отслеживала `origin/main`. Я настроил правильный upstream, и `git status` теперь показывает полную синхронизацию.',
      '',
      'Больше отправлять нечего.',
    ].join('\n'),
  },
};

/** Diff demo: the finished GitHub session that fixed the sidebar clipping. */
export function buildLodyPrHistory(locale: LandingLocale): ReplicaMessage[] {
  const copy = PR_HISTORY_COPY[locale];
  const claude = { agent: 'claude' as const };
  return [
    userMessage('lody-pr-user-investigate', copy.userInvestigate, '2026-06-21T09:07:13.599Z'),
    assistantMessage(
      'lody-pr-assistant-fix',
      [
        { type: 'text', text: copy.traceText },
        toolCall('read', copy.readHotspots, 'landing-lody-pr-read-hotspots'),
        toolCall('read', copy.readSidebar, 'landing-lody-pr-read-sidebar'),
        toolCall('execute', copy.repro, 'landing-lody-pr-repro'),
        { type: 'text', text: copy.rootCause },
        toolCall('edit', copy.editSidebar, 'landing-lody-pr-edit-sidebar'),
        { type: 'text', text: copy.fixedSummary },
      ],
      '2026-06-21T09:11:44.000Z',
      claude
    ),
    userMessage('lody-pr-user-create-pr', copy.userCreatePr, '2026-06-21T09:18:20.000Z'),
    assistantMessage(
      'lody-pr-assistant-create-pr',
      [
        { type: 'text', text: copy.createPrIntro },
        toolCall('execute', copy.gitStatus, 'landing-lody-pr-git-status'),
        toolCall('execute', copy.gitCommit, 'landing-lody-pr-commit'),
        toolCall('execute', copy.gitPush, 'landing-lody-pr-push'),
        toolCall('execute', copy.createPrTool, 'landing-lody-pr-create-pr'),
        { type: 'text', text: copy.prCreatedText },
      ],
      '2026-06-21T09:22:40.000Z',
      claude
    ),
    assistantMessage(
      'lody-pr-assistant-upstream',
      [{ type: 'text', text: copy.upstreamConfirmedText }],
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
  'zh-hant': {
    promptText: '介紹一下 Lody',
    branchLabel: '分支',
    reply: [
      'Lody 是一個本機優先的 AI 程式設計協作工作區：',
      '',
      '- **並行 Agent** — 每個任務都擁有獨立的 git worktree，多個 Agent 可同時開發而互不干擾。',
      '- **即時同步** — 對話、diff 與終端輸出會即時同步到桌面、瀏覽器與手機。',
      '- **統一控制面** — 在任何裝置上啟動、審查並合併 Agent 的成果。',
      '',
      '目前工作階段正執行於從 `main` 建立的全新 worktree 中，我在此做的任何修改都不會影響你的工作目錄。',
    ].join('\n'),
  },
  ja: {
    promptText: 'Lody を紹介して',
    branchLabel: 'ブランチ',
    reply: [
      'Lody はコーディングエージェントを実行するためのローカルファーストなワークスペースです：',
      '',
      '- **並列エージェント** — タスクごとに独立した git worktree を割り当て、複数エージェントが干渉せずに同時開発できます。',
      '- **どこでもリアルタイム** — 会話、差分、ターミナル出力がデスクトップ・ブラウザー・スマホへ即時同期されます。',
      '- **統一コントロールプレーン** — どのデバイスからでもエージェント作業の開始・レビュー・マージが可能です。',
      '',
      'このセッションは `main` から作成した新しい worktree で動いているため、ここでの変更が作業ディレクトリに影響することはありません。',
    ].join('\n'),
  },
  ko: {
    promptText: 'Lody를 소개해 줘',
    branchLabel: '브랜치',
    reply: [
      'Lody는 코딩 에이전트를 실행하기 위한 로컬 우선 워크스페이스입니다:',
      '',
      '- **병렬 에이전트** — 모든 작업이 격리된 git worktree에서 실행되어 여러 에이전트가 충돌 없이 동시에 개발합니다.',
      '- **어디서나 실시간 동기화** — 대화, diff, 터미널 출력이 데스크톱·브라우저·모바일로 실시간 동기화됩니다.',
      '- **하나의 컨트롤 플레인** — 어떤 기기에서든 에이전트 작업을 시작하고 리뷰하며 병합할 수 있습니다.',
      '',
      '이 세션은 `main`에서 새로 생성된 worktree에서 실행 중이므로 여기서 하는 작업은 원래 작업 디렉터리에 영향을 주지 않습니다.',
    ].join('\n'),
  },
  es: {
    promptText: 'Presenta Lody',
    branchLabel: 'Rama',
    reply: [
      'Lody es un espacio de trabajo local-first para ejecutar agentes de programación:',
      '',
      '- **Agentes en paralelo** — cada tarea tiene su propio git worktree aislado, así que varios agentes trabajan a la vez sin pisarse.',
      '- **En vivo en todas partes** — conversaciones, diffs y salida de terminal se sincronizan en tiempo real con escritorio, navegador y móvil.',
      '- **Un solo plano de control** — inicia, revisa y fusiona el trabajo de los agentes desde cualquier dispositivo.',
      '',
      'Esta sesión se ejecuta en un worktree limpio creado desde `main`, así que nada de lo que haga aquí tocará tu directorio de trabajo.',
    ].join('\n'),
  },
  fr: {
    promptText: 'Présente Lody',
    branchLabel: 'Branche',
    reply: [
      'Lody est un espace de travail local-first conçu pour exécuter des agents de code :',
      '',
      "- **Agents en parallèle** — chaque tâche dispose de son propre git worktree isolé, permettant à plusieurs agents d'avancer côte à côte sans conflit.",
      '- **Synchronisé partout** — conversations, diffs et sorties terminal se synchronisent en temps réel sur ordinateur, navigateur et mobile.',
      "- **Plan de contrôle unique** — lancez, relisez et fusionnez le travail de vos agents depuis n'importe quel appareil.",
      '',
      'Cette session tourne dans un nouveau worktree créé depuis `main` : aucune modification ici ne touche votre répertoire de travail.',
    ].join('\n'),
  },
  ru: {
    promptText: 'Расскажи о Lody',
    branchLabel: 'Ветка',
    reply: [
      'Lody — это локально-ориентированное рабочее пространство для запуска агентов разработки:',
      '',
      '- **Параллельные агенты** — каждая задача получает свой изолированный git worktree, поэтому несколько агентов работают одновременно и не мешают друг другу.',
      '- **Синхронизация везде** — диалоги, diff и вывод терминала в реальном времени обновляются на компьютере, в браузере и на телефоне.',
      '- **Единая панель управления** — запускайте, проверяйте и сливайте изменения агентов с любого устройства.',
      '',
      'Эта сессия работает в чистом worktree от ветки `main`, поэтому любые изменения здесь не затронут вашу рабочую директорию.',
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
    turn3EditHero: string;
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
    turn3EditHero: 'Edit apps/landing/src/components/hero.tsx',
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
    turn3EditHero: '修改 apps/landing/src/components/hero.tsx',
    turn3Text:
      '已完成。hero lead 不再以 `— desktop, browser, or phone.` 结尾 — 热更新已经生效，右侧预览里已经是新文案。',
  },
  'zh-hant': {
    prompt: '啟動 Lody Landing Page 的開發伺服器，並在 Lody 瀏覽器中開啟。',
    turn2Intro: '我來啟動 landing page 的開發伺服器，並回報為此工作階段的預覽候選項目。',
    turn2Text: [
      '開發伺服器已啟動：',
      '',
      '- 本機網址：**http://127.0.0.1:3002/**',
      '- 已透過 `lody_report_preview_candidate` 回報為此工作階段的預覽候選。',
      '',
      '點選輸入框上方資訊列的瀏覽器按鈕，即可在 Lody 中開啟。',
    ].join('\n'),
    comment: '移除 desktop, browser, or phone',
    turn3Intro: '沒問題，我來移除 hero 副標尾端的這段文字。',
    turn3EditHero: '編輯 apps/landing/src/components/hero.tsx',
    turn3Text:
      '已完成。hero 副標已不再以 `— desktop, browser, or phone.` 結尾 — 熱重載已套用，右側預覽已顯示最新文案。',
  },
  ja: {
    prompt: 'ランディングページの開発サーバーを起動して、Lody ブラウザーで開いて。',
    turn2Intro:
      'ランディングページの開発サーバーを起動し、このセッションのプレビュー候補として登録します。',
    turn2Text: [
      '開発サーバーを起動しました：',
      '',
      '- ローカル：**http://127.0.0.1:3002/**',
      '- `lody_report_preview_candidate` でこのセッションのプレビュー候補として報告済みです。',
      '',
      '入力欄の上にあるブラウザーボタンをクリックして Lody 内で開けます。',
    ].join('\n'),
    comment: '"desktop, browser, or phone" を削除',
    turn3Intro: '了解しました。ヒーローのリード文末尾のフレーズを削除します。',
    turn3EditHero: 'apps/landing/src/components/hero.tsx を編集',
    turn3Text:
      '完了しました。ヒーローのリード文から `— desktop, browser, or phone.` を削除し、ホットリロードで右側のプレビューに反映済みです。',
  },
  ko: {
    prompt: '랜딩 페이지 개발 서버를 시작하고 Lody 브라우저에서 열어 줘.',
    turn2Intro: '랜딩 페이지 개발 서버를 실행하고 이 세션의 미리보기 후보로 등록하겠습니다.',
    turn2Text: [
      '개발 서버가 실행되었습니다:',
      '',
      '- 로컬 주소: **http://127.0.0.1:3002/**',
      '- `lody_report_preview_candidate`를 통해 이 세션의 미리보기 후보로 보고했습니다.',
      '',
      '입력창 위 정보 바의 브라우저 버튼을 눌러 Lody에서 열어 보세요.',
    ].join('\n'),
    comment: '"desktop, browser, or phone" 삭제',
    turn3Intro: '바로 진행할게요. 히어로 소개 문구 끝부분을 제거하겠습니다.',
    turn3EditHero: 'apps/landing/src/components/hero.tsx 수정',
    turn3Text:
      '완료했습니다. 히어로 문구 끝의 `— desktop, browser, or phone.`을 제거했고 핫 리로드가 적용되어 오른쪽 미리보기에 바로 반영되었습니다.',
  },
  es: {
    prompt: 'Inicia el servidor de desarrollo de la landing y ábrelo en el navegador de Lody.',
    turn2Intro:
      'Iniciaré el servidor de desarrollo de la landing y lo registraré como vista previa candidata de esta sesión.',
    turn2Text: [
      'El servidor de desarrollo está activo:',
      '',
      '- Local: **http://127.0.0.1:3002/**',
      '- Registrado como vista previa candidata mediante `lody_report_preview_candidate`.',
      '',
      'Haz clic en el botón Navegador sobre el editor para abrirlo en Lody.',
    ].join('\n'),
    comment: 'Quitar "desktop, browser, or phone"',
    turn3Intro: 'En marcha: elimino esa frase final de la entradilla del hero.',
    turn3EditHero: 'Editar apps/landing/src/components/hero.tsx',
    turn3Text:
      'Listo. La entradilla ya no termina en `— desktop, browser, or phone.` y la recarga en caliente ya actualizó la vista previa a la derecha.',
  },
  fr: {
    prompt:
      'Démarre le serveur de développement de la landing et ouvre-le dans le navigateur Lody.',
    turn2Intro:
      'Je démarre le serveur de développement et je le déclare comme aperçu candidat pour cette session.',
    turn2Text: [
      'Le serveur de développement est prêt :',
      '',
      '- Local : **http://127.0.0.1:3002/**',
      '- Déclaré comme aperçu candidat via `lody_report_preview_candidate`.',
      '',
      'Cliquez sur le bouton Navigateur au-dessus de la zone de saisie pour l’ouvrir dans Lody.',
    ].join('\n'),
    comment: 'Retirer "desktop, browser, or phone"',
    turn3Intro: "C'est parti — je retire cette fin de phrase du sous-titre du hero.",
    turn3EditHero: 'Modifier apps/landing/src/components/hero.tsx',
    turn3Text:
      "Terminé. Le sous-titre ne se termine plus par `— desktop, browser, or phone.` et le rechargement à chaud l'a déjà appliqué dans l'aperçu à droite.",
  },
  ru: {
    prompt: 'Запусти dev-сервер лендинга и открой его во встроенном браузере Lody.',
    turn2Intro: 'Запускаю dev-сервер лендинга и регистрирую его как предпросмотр для этой сессии.',
    turn2Text: [
      'Dev-сервер запущен:',
      '',
      '- Локально: **http://127.0.0.1:3002/**',
      '- Зарегистрирован как предпросмотр сессии через `lody_report_preview_candidate`.',
      '',
      'Нажмите кнопку «Браузер» над полем ввода, чтобы открыть его в Lody.',
    ].join('\n'),
    comment: 'Убрать "desktop, browser, or phone"',
    turn3Intro: 'Принял — удаляю эту концовку из подзаголовка в hero.',
    turn3EditHero: 'Изменение apps/landing/src/components/hero.tsx',
    turn3Text:
      'Готово. Подзаголовок больше не заканчивается на `— desktop, browser, or phone.` — hot reload уже обновил предпросмотр справа.',
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
        d.turn3EditHero,
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
