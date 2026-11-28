import { founderCallUrl } from '@site/lib/founder-call';
import { GITHUB_REPO_URL } from '@site/lib/github';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';
import type { CliSectionCopy } from './landing-cli-section';
import type { LandingCtaCopy } from './landing-cta-section';
import type { MobileDeepSectionCopy } from './landing-mobile-deep-section';
import type { OrchestrationSectionCopy } from './landing-orchestration-section';
import type { PowerSectionCopy } from './landing-power-section';
import type { SubscriptionsSectionCopy } from './landing-subscriptions-section';

export type LandingCopy = {
  skipToContent: string;
  subscriptions: SubscriptionsSectionCopy;
  /** One agent runs other agents — short claim only. */
  orchestration: OrchestrationSectionCopy;
  /** Terminal / scripts / external systems — separate section. */
  cli: CliSectionCopy;
  power: PowerSectionCopy;
  mobileDeep: MobileDeepSectionCopy;
  cta: LandingCtaCopy;
  hero: {
    eyebrow: string;
    prefix: string;
    words: string[];
    suffix: string;
    lead: string;
    /** Ghost secondary (source repository). */
    secondary: string;
    secondaryHref: string;
    secondaryExternal?: boolean;
    webAppHref: string;
    /** Shared with closing CTA for platform-aware primary download. */
    labels: LandingCtaCopy['labels'];
    /** Text link → full multi-platform download page. */
    otherDownloads: string;
    otherDownloadsHref: string;
  };
};

export const LANDING_COPY: Record<SiteLocale, LandingCopy> = {
  en: {
    skipToContent: 'Skip to content',
    subscriptions: {
      title: 'Use subscriptions you already have',
      body: 'Run on your machines with the plan you already pay for',
      note: 'API keys work too',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: 'Your subscription' },
        { id: 'codex', label: 'Codex', hint: 'Your login' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '…and any coding agent that speaks ACP',
        body: 'Cursor, Gemini CLI, Cline, Goose, OpenCode, Qwen and more. If it adapts the Agent Client Protocol, it plugs into Lody',
        label: 'Coding agents supported through the Agent Client Protocol',
      },
    },
    orchestration: {
      title: 'One agent can run the others',
      body: 'Manage many sessions from a single chat — across machines, agents, and repos.',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'en'),
        label: 'How one agent runs the others',
      },
      hubLabel: 'Your agent',
      useCases: [
        {
          title: 'Multi-platform sub-agents',
          body: 'Spin sub-agents to test macOS, Linux, and Windows in parallel.',
        },
        {
          title: 'Review → fix loop',
          body: 'One agent reviews; another fixes; iterate without leaving the chat.',
        },
        {
          title: 'Cross-repo fixes',
          body: 'A dependency is broken? Fix it in a sub-session, watch it land, pull it back — stay in this chat.',
        },
      ],
      sessions: [
        { task: 'Test on macOS', agentId: 'codex' },
        { task: 'Fix the dependency', agentId: 'claude-code' },
        { task: 'Land upstream', agentId: 'gemini' },
      ],
    },
    cli: {
      title: 'Connect any machine from the terminal',
      body: 'Run npx lody daemon start on a server, cloud VM, or the desktop at home. It opens a sign-in link in your browser, then keeps that machine connected — so you can hand it work from your phone, the web app, a script, or CI.',
      prompt: '$',
      lines: [
        {
          caption: 'On the remote machine — sign in once, stays connected',
          cmd: 'npx lody daemon start',
        },
        {
          caption: 'From your laptop, a script, or CI',
          cmd: 'lody session create --agent codex "Fix the auth 500s"',
        },
        { cmd: 'lody session chat <id> "Also check rate limits"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: 'Ship together in one workspace',
      body: 'Sessions are shared, so decisions stay in the team workspace — hand off and steer from the same context',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'en'),
        label: 'How to hand off a session',
      },
      points: [
        'Open any teammate’s session and keep chatting',
        'Machines stay private until you share',
      ],
      features: [
        {
          id: 'usage',
          title: 'Usage by member',
          body: 'Token and cost breakdown by model and teammate for the workspace.',
        },
        {
          id: 'pr',
          title: 'PR, CI, merge',
          body: 'Pull request status, checks, conversation, and merge actions in-session.',
        },
      ],
    },
    mobileDeep: {
      title: 'Live on mobile and Dynamic Island',
      body: 'Agent progress and permission prompts without reopening the app',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt: 'Lody on iPhone Dynamic Island: agent permission prompt with Deny and Allow',
    },
    cta: {
      slogan: 'Your agents. Everywhere',
      lead: 'Desktop, phone, browser. Same workspace',
      allPlatforms: 'All platforms',
      allPlatformsHref: localizeSitePath('/download', 'en'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: 'Book a founder call',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: 'Download for macOS',
        macIntel: 'Intel Mac',
        win: 'Download for Windows',
        linux: 'Download for Linux',
        ios: 'Get on the App Store',
        android: 'Download Android APK',
        browser: 'Open Web App',
      },
    },
    hero: {
      eyebrow: 'Team AI coding agent workspace',
      prefix: 'Share AI coding agents with your team on phone and desktop',
      words: [],
      suffix: '',
      lead: 'Parallel Git worktrees, shared sessions, live diffs, and one control plane — so your team and agents stay in sync',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: 'Other download options',
      otherDownloadsHref: localizeSitePath('/download', 'en'),
      labels: {
        macArm: 'Download for macOS',
        macIntel: 'Intel Mac',
        win: 'Download for Windows',
        linux: 'Download for Linux',
        ios: 'Get on the App Store',
        android: 'Download Android APK',
        browser: 'Open Web App',
      },
    },
  },
  zh: {
    skipToContent: '跳到正文',
    subscriptions: {
      title: '用已有的订阅就行',
      body: '用你已经在付的套餐，跑在你自己的机器上',
      note: '也支持 API key',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: '你的订阅' },
        { id: 'codex', label: 'Codex', hint: '你的登录' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '……以及任何支持 ACP 的编程 Agent',
        body: 'Cursor、Gemini CLI、Cline、Goose、OpenCode、Qwen 等等。只要适配了 Agent Client Protocol（ACP），就能接入 Lody',
        label: '通过 Agent Client Protocol 支持的编程 Agent',
      },
    },
    orchestration: {
      title: '一个 Agent 调度其他 Agent',
      body: '在一个对话里管理多个 session——跨机器、跨 Agent、跨仓库。',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'zh'),
        label: '一个 Agent 如何调度其他会话',
      },
      hubLabel: '你的 Agent',
      useCases: [
        {
          title: '多平台 sub-agent',
          body: '让 sub-agent 并行在 macOS / Linux / Windows 上跑测试。',
        },
        {
          title: 'Review → fix 循环',
          body: '一个 agent review，另一个改；不用离开当前对话。',
        },
        {
          title: '跨仓库修复',
          body: '依赖的包出问题？在当前对话开 sub-session 去修、盯完，再合回来。',
        },
      ],
      sessions: [
        { task: '在 macOS 上测', agentId: 'codex' },
        { task: '修依赖包', agentId: 'claude-code' },
        { task: '合回上游', agentId: 'gemini' },
      ],
    },
    cli: {
      title: '一行命令接入任意机器',
      body: '在服务器、云主机或家里的台式机上跑 npx lody daemon start：它会在浏览器里打开登录链接，登录完这台机器就一直在线——之后用手机、Web、脚本或 CI 都能给它派活。',
      prompt: '$',
      lines: [
        { caption: '在远端机器上——登录一次，之后保持在线', cmd: 'npx lody daemon start' },
        {
          caption: '在你自己的电脑、脚本或 CI 里',
          cmd: 'lody session create --agent codex "修 auth 500"',
        },
        { cmd: 'lody session chat <id> "顺便检查限流"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: '在同一工作区一起交付',
      body: '会话可共享，AI 对话里的决策留在团队 workspace 里，方便 hand off 和接着 steer',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'zh'),
        label: '如何交接会话',
      },
      points: ['打开同事的会话，接着聊下去', '机器默认私有，你打开才共享'],
      features: [
        {
          id: 'usage',
          title: '按成员用量',
          body: '按模型与成员查看 workspace 的 token 与费用。',
        },
        {
          id: 'pr',
          title: 'PR · CI · 合入',
          body: '在会话里查看 PR 状态、检查项、讨论与 merge。',
        },
      ],
    },
    mobileDeep: {
      title: '手机与灵动岛实时看进度',
      body: '离开工位也能随时查看进度、审批权限并继续发指令',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt: 'iPhone 灵动岛上的 Lody：Agent 权限请求，可 Deny / Allow',
    },
    cta: {
      slogan: '你的 Agents，处处可用',
      lead: '桌面、手机、浏览器。同一工作区',
      allPlatforms: '全部平台',
      allPlatformsHref: localizeSitePath('/download', 'zh'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: '和创始人聊聊',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: '下载 macOS 版',
        macIntel: 'Intel Mac',
        win: '下载 Windows 版',
        linux: '下载 Linux 版',
        ios: '前往 App Store',
        android: '下载 Android APK',
        browser: '打开 Web App',
      },
    },
    hero: {
      eyebrow: 'AI 编程 Agent 团队工作区',
      prefix: '在电脑和手机上',
      words: [],
      suffix: '并行多开并共享 AI 编程 Agent',
      lead: 'Git Worktree 隔离并行、共享会话、实时 Diff 审查与统一控制面 — 让团队与 Claude Code、Codex 始终同步',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: '其他下载方式',
      otherDownloadsHref: localizeSitePath('/download', 'zh'),
      labels: {
        macArm: '下载 macOS 版',
        macIntel: 'Intel Mac',
        win: '下载 Windows 版',
        linux: '下载 Linux 版',
        ios: '前往 App Store',
        android: '下载 Android APK',
        browser: '打开 Web App',
      },
    },
  },
  'zh-hant': {
    skipToContent: '跳至主要內容',
    subscriptions: {
      title: '直接沿用你已有的訂閱',
      body: '用你原本就在付費的方案，直接在自己的機器上執行',
      note: '同時支援 API key',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: '你的訂閱' },
        { id: 'codex', label: 'Codex', hint: '你的登入帳號' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '……以及任何支援 ACP 的程式設計 Agent',
        body: 'Cursor、Gemini CLI、Cline、Goose、OpenCode、Qwen 等等。只要支援 Agent Client Protocol（ACP），就能無縫接入 Lody',
        label: '透過 Agent Client Protocol 支援的程式設計 Agent',
      },
    },
    orchestration: {
      title: '讓一個 Agent 調度其他 Agent',
      body: '在單一對話中管理多個工作階段——跨機器、跨 Agent、跨儲存庫。',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'zh-hant'),
        label: '一個 Agent 如何調度其他工作階段',
      },
      hubLabel: '你的 Agent',
      useCases: [
        {
          title: '多平台 sub-agent',
          body: '同時派出 sub-agent 在 macOS、Linux 與 Windows 上平行測試。',
        },
        {
          title: 'Review → 修正循環',
          body: '一個 Agent 負責審查，另一個負責修改；全程不需離開目前對話。',
        },
        {
          title: '跨儲存庫修復',
          body: '相依套件出錯了？在目前對話開啟子工作階段修復、追蹤合入，再拉回主線。',
        },
      ],
      sessions: [
        { task: '在 macOS 測試', agentId: 'codex' },
        { task: '修復相依套件', agentId: 'claude-code' },
        { task: '合併回上游', agentId: 'gemini' },
      ],
    },
    cli: {
      title: '從終端機一行指令連接任何機器',
      body: '在伺服器、雲端主機或家裡的桌機執行 npx lody daemon start。它會在瀏覽器開啟登入連結，登入後便保持連線——之後無論用手機、Web 應用、腳本或 CI 都能派發任務。',
      prompt: '$',
      lines: [
        { caption: '在遠端機器上——登入一次即保持連線', cmd: 'npx lody daemon start' },
        {
          caption: '從你的筆電、腳本或 CI 發起',
          cmd: 'lody session create --agent codex "修復 auth 500 錯誤"',
        },
        { cmd: 'lody session chat <id> "順便檢查速率限制"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: '在同一個工作區並肩交付',
      body: '工作階段皆可共享，讓討論與決策留在團隊工作區內——隨時從同一脈絡接手並引導',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'zh-hant'),
        label: '如何交接工作階段',
      },
      points: ['開啟同事的工作階段並繼續對話', '機器預設私有，僅在你分享時才開放'],
      features: [
        {
          id: 'usage',
          title: '依成員查看用量',
          body: '依模型與團隊成員檢視工作區的 Token 與費用明細。',
        },
        {
          id: 'pr',
          title: 'PR · CI · 合併',
          body: '在工作階段內直接檢視 PR 狀態、檢查結果、討論與合併操作。',
        },
      ],
    },
    mobileDeep: {
      title: '手機與動態島即時掌握進度',
      body: '不必重新開啟 App，也能遠端檢視 Agent 進度並處理權限請求',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt: 'iPhone 動態島上的 Lody：Agent 權限請求提示，附帶拒絕與允許按鈕',
    },
    cta: {
      slogan: '你的 Agents，無處不在',
      lead: '桌面、手機、瀏覽器，同一個工作區',
      allPlatforms: '所有平台',
      allPlatformsHref: localizeSitePath('/download', 'zh-hant'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: '與創辦人聊聊',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: '下載 macOS 版',
        macIntel: 'Intel Mac',
        win: '下載 Windows 版',
        linux: '下載 Linux 版',
        ios: '前往 App Store',
        android: '下載 Android APK',
        browser: '開啟 Web 應用',
      },
    },
    hero: {
      eyebrow: 'AI 程式設計 Agent 團隊工作區',
      prefix: '在手機與電腦上',
      words: [],
      suffix: '與團隊並行共享 AI 程式設計 Agent',
      lead: 'Git Worktree 隔離並行、共享工作階段、即時 Diff 審查與統一控制面 — 讓團隊與 Claude Code、Codex 始終同步',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: '其他下載選項',
      otherDownloadsHref: localizeSitePath('/download', 'zh-hant'),
      labels: {
        macArm: '下載 macOS 版',
        macIntel: 'Intel Mac',
        win: '下載 Windows 版',
        linux: '下載 Linux 版',
        ios: '前往 App Store',
        android: '下載 Android APK',
        browser: '開啟 Web 應用',
      },
    },
  },
  ja: {
    skipToContent: 'メインコンテンツへスキップ',
    subscriptions: {
      title: 'すでにお持ちのサブスクリプションをそのまま活用',
      body: '支払い済みのプランを使って、ご自身のマシン上でそのまま実行できます',
      note: 'API キーにも対応しています',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: 'ご自身のサブスクリプション' },
        { id: 'codex', label: 'Codex', hint: 'ご自身のログイン' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '…さらに ACP 対応のあらゆるコーディングエージェントも',
        body: 'Cursor、Gemini CLI、Cline、Goose、OpenCode、Qwen など。Agent Client Protocol（ACP）に対応していれば Lody にそのまま接続できます',
        label: 'Agent Client Protocol 経由で対応するコーディングエージェント',
      },
    },
    orchestration: {
      title: 'ひとつのエージェントが他のエージェントを動かす',
      body: 'ひとつのチャットから複数のセッションを管理 — マシン、エージェント、リポジトリを横断して。',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'ja'),
        label: 'エージェントから他セッションを操作する方法',
      },
      hubLabel: 'あなたのエージェント',
      useCases: [
        {
          title: 'マルチプラットフォームのサブエージェント',
          body: 'macOS・Linux・Windows 向けの並列テストをサブエージェントに実行させます。',
        },
        {
          title: 'レビュー → 修正ループ',
          body: 'あるエージェントがレビューし、別のエージェントが修正。チャットを離れずに反復できます。',
        },
        {
          title: 'リポジトリ横断の修正',
          body: '依存ライブラリに不具合があるときはサブセッションで修正し、マージを見届けて取り込めます。',
        },
      ],
      sessions: [
        { task: 'macOS でテスト', agentId: 'codex' },
        { task: '依存関係を修正', agentId: 'claude-code' },
        { task: '上流へ反映', agentId: 'gemini' },
      ],
    },
    cli: {
      title: 'ターミナルからあらゆるマシンを接続',
      body: 'サーバー、クラウド VM、自宅のデスクトップで npx lody daemon start を実行するだけ。ブラウザーでサインインすれば常時接続され、スマホ・Web アプリ・スクリプト・CI からいつでも作業を依頼できます。',
      prompt: '$',
      lines: [
        {
          caption: 'リモートマシンで実行 — 一度サインインすれば常時接続',
          cmd: 'npx lody daemon start',
        },
        {
          caption: '手元の PC、スクリプト、または CI から',
          cmd: 'lody session create --agent codex "auth の 500 エラーを修正"',
        },
        { cmd: 'lody session chat <id> "レート制限も確認して"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: 'ひとつのワークスペースで一緒にリリース',
      body: 'セッションを共有できるため、意思決定がチームワークスペースに蓄積 — 同じ文脈のまま引き継いで指示を出せます',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'ja'),
        label: 'セッションを引き継ぐ方法',
      },
      points: [
        'チームメンバーのセッションを開いてそのまま会話を続けられます',
        'マシンは共有をオンにするまで非公開のままです',
      ],
      features: [
        {
          id: 'usage',
          title: 'メンバー別の利用量',
          body: 'ワークスペース内のトークン数とコストをモデル別・メンバー別に可視化。',
        },
        {
          id: 'pr',
          title: 'PR・CI・マージ',
          body: 'Pull Request の状態、チェック結果、議論、マージ操作をセッション内で完結。',
        },
      ],
    },
    mobileDeep: {
      title: 'スマホと Dynamic Island でリアルタイム確認',
      body: 'アプリを開き直さずにエージェントの進捗確認と権限承認ができます',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt:
        'iPhone の Dynamic Island 上の Lody：拒否・許可ボタン付きのエージェント権限プロンプト',
    },
    cta: {
      slogan: 'あなたのエージェントを、どこからでも',
      lead: 'デスクトップ、スマホ、ブラウザー。すべて同じワークスペース',
      allPlatforms: 'すべてのプラットフォーム',
      allPlatformsHref: localizeSitePath('/download', 'ja'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: '創業者と話す',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: 'macOS 版をダウンロード',
        macIntel: 'Intel Mac',
        win: 'Windows 版をダウンロード',
        linux: 'Linux 版をダウンロード',
        ios: 'App Store で入手',
        android: 'Android APK をダウンロード',
        browser: 'Web アプリを開く',
      },
    },
    hero: {
      eyebrow: 'チーム向け AI コーディングエージェントワークスペース',
      prefix: 'スマホでもデスクトップでも、',
      words: [],
      suffix: 'AI コーディングエージェントをチームで並列実行',
      lead: 'Git worktree 分離、共有セッション、リアルタイム差分レビュー、統一コントロールプレーン — Claude Code や Codex とチームが常に同期',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: 'その他のダウンロード',
      otherDownloadsHref: localizeSitePath('/download', 'ja'),
      labels: {
        macArm: 'macOS 版をダウンロード',
        macIntel: 'Intel Mac',
        win: 'Windows 版をダウンロード',
        linux: 'Linux 版をダウンロード',
        ios: 'App Store で入手',
        android: 'Android APK をダウンロード',
        browser: 'Web アプリを開く',
      },
    },
  },
  ko: {
    skipToContent: '본문으로 건너뛰기',
    subscriptions: {
      title: '이미 보유한 구독을 그대로 사용하세요',
      body: '이미 결제 중인 요금제로 내 머신에서 바로 실행할 수 있습니다',
      note: 'API 키도 지원합니다',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: '내 구독' },
        { id: 'codex', label: 'Codex', hint: '내 로그인' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '…그리고 ACP를 지원하는 모든 코딩 에이전트',
        body: 'Cursor, Gemini CLI, Cline, Goose, OpenCode, Qwen 등 Agent Client Protocol(ACP)을 지원한다면 무엇이든 Lody에 연결됩니다',
        label: 'Agent Client Protocol을 통해 지원되는 코딩 에이전트',
      },
    },
    orchestration: {
      title: '하나의 에이전트가 다른 에이전트를 지휘합니다',
      body: '하나의 채팅에서 여러 세션을 관리하세요 — 머신, 에이전트, 리포지토리를 넘나들며.',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'ko'),
        label: '하나의 에이전트가 다른 세션을 실행하는 방법',
      },
      hubLabel: '내 에이전트',
      useCases: [
        {
          title: '멀티 플랫폼 서브 에이전트',
          body: '서브 에이전트를 띄워 macOS, Linux, Windows에서 병렬로 테스트합니다.',
        },
        {
          title: '리뷰 → 수정 루프',
          body: '한 에이전트가 리뷰하고 다른 에이전트가 수정합니다. 채팅을 떠나지 않고 반복하세요.',
        },
        {
          title: '크로스 리포지토리 수정',
          body: '의존성 패키지가 깨졌나요? 서브 세션에서 고치고 반영을 확인한 뒤 다시 가져오세요.',
        },
      ],
      sessions: [
        { task: 'macOS에서 테스트', agentId: 'codex' },
        { task: '의존성 수정', agentId: 'claude-code' },
        { task: '업스트림 반영', agentId: 'gemini' },
      ],
    },
    cli: {
      title: '터미널에서 어떤 머신이든 연결하세요',
      body: '서버, 클라우드 VM 또는 집 데스크톱에서 npx lody daemon start를 실행하세요. 브라우저에서 로그인 링크가 열리고 한 번 로그인하면 연결이 유지되어 휴대폰, 웹 앱, 스크립트, CI에서 작업을 맡길 수 있습니다.',
      prompt: '$',
      lines: [
        {
          caption: '원격 머신에서 실행 — 한 번 로그인하면 연결 유지',
          cmd: 'npx lody daemon start',
        },
        {
          caption: '노트북, 스크립트 또는 CI에서',
          cmd: 'lody session create --agent codex "auth 500 오류 수정"',
        },
        { cmd: 'lody session chat <id> "요청 제한도 함께 확인해 줘"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: '하나의 워크스페이스에서 함께 배포하세요',
      body: '세션이 공유되므로 모든 의사결정이 팀 워크스페이스에 남습니다 — 같은 맥락에서 바로 인수인계하고 방향을 조정하세요',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'ko'),
        label: '세션 인수인계 방법',
      },
      points: [
        '동료의 세션을 열어 바로 대화를 이어가세요',
        '머신은 직접 공유하기 전까지 비공개로 유지됩니다',
      ],
      features: [
        {
          id: 'usage',
          title: '멤버별 사용량',
          body: '워크스페이스의 모델별·멤버별 토큰 및 비용 분석.',
        },
        {
          id: 'pr',
          title: 'PR · CI · 병합',
          body: '세션 안에서 Pull Request 상태, 체크, 대화 및 병합을 바로 처리합니다.',
        },
      ],
    },
    mobileDeep: {
      title: '모바일과 Dynamic Island에서 실시간 확인',
      body: '앱을 다시 열지 않고도 에이전트 진행 상황과 권한 요청을 처리하세요',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt: 'iPhone Dynamic Island의 Lody: 거부 및 허용 버튼이 있는 에이전트 권한 프롬프트',
    },
    cta: {
      slogan: '내 에이전트, 어디서나',
      lead: '데스크톱, 모바일, 브라우저. 모두 하나의 워크스페이스',
      allPlatforms: '모든 플랫폼',
      allPlatformsHref: localizeSitePath('/download', 'ko'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: '창업자와 통화 예약',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: 'macOS용 다운로드',
        macIntel: 'Intel Mac',
        win: 'Windows용 다운로드',
        linux: 'Linux용 다운로드',
        ios: 'App Store에서 받기',
        android: 'Android APK 다운로드',
        browser: '웹 앱 열기',
      },
    },
    hero: {
      eyebrow: '팀용 AI 코딩 에이전트 워크스페이스',
      prefix: '모바일과 데스크톱에서',
      words: [],
      suffix: '팀과 함께 AI 코딩 에이전트를 병렬 실행하세요',
      lead: '격리된 Git 워크트리, 공유 세션, 실시간 Diff 리뷰, 하나의 컨트롤 플레인 — Claude Code·Codex와 팀이 늘 동기화됩니다',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: '다른 다운로드 옵션',
      otherDownloadsHref: localizeSitePath('/download', 'ko'),
      labels: {
        macArm: 'macOS용 다운로드',
        macIntel: 'Intel Mac',
        win: 'Windows용 다운로드',
        linux: 'Linux용 다운로드',
        ios: 'App Store에서 받기',
        android: 'Android APK 다운로드',
        browser: '웹 앱 열기',
      },
    },
  },
  es: {
    skipToContent: 'Ir al contenido principal',
    subscriptions: {
      title: 'Usa las suscripciones que ya tienes',
      body: 'Ejecútalos en tus propias máquinas con el plan que ya pagas',
      note: 'También funcionan claves API',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: 'Tu suscripción' },
        { id: 'codex', label: 'Codex', hint: 'Tu inicio de sesión' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '…y cualquier agente de programación compatible con ACP',
        body: 'Cursor, Gemini CLI, Cline, Goose, OpenCode, Qwen y más. Si implementa el Agent Client Protocol, se conecta con Lody',
        label: 'Agentes de programación compatibles mediante el Agent Client Protocol',
      },
    },
    orchestration: {
      title: 'Un agente puede dirigir a los demás',
      body: 'Gestiona varias sesiones desde un solo chat: entre máquinas, agentes y repositorios.',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'es'),
        label: 'Cómo un agente coordina a los demás',
      },
      hubLabel: 'Tu agente',
      useCases: [
        {
          title: 'Subagentes multiplataforma',
          body: 'Lanza subagentes para probar en macOS, Linux y Windows en paralelo.',
        },
        {
          title: 'Ciclo revisión → corrección',
          body: 'Un agente revisa y otro corrige; itera sin salir del chat.',
        },
        {
          title: 'Correcciones entre repositorios',
          body: '¿Falló una dependencia? Corrígela en una subsesión, comprueba que se integre y vuelve a tu flujo sin salir de este chat.',
        },
      ],
      sessions: [
        { task: 'Probar en macOS', agentId: 'codex' },
        { task: 'Corregir la dependencia', agentId: 'claude-code' },
        { task: 'Integrar en upstream', agentId: 'gemini' },
      ],
    },
    cli: {
      title: 'Conecta cualquier máquina desde la terminal',
      body: 'Ejecuta npx lody daemon start en un servidor, una VM en la nube o tu equipo de casa. Abre un enlace de acceso en tu navegador y mantiene esa máquina conectada para recibir tareas desde tu teléfono, la app web, un script o CI.',
      prompt: '$',
      lines: [
        {
          caption: 'En la máquina remota: inicia sesión una vez y queda conectada',
          cmd: 'npx lody daemon start',
        },
        {
          caption: 'Desde tu portátil, un script o CI',
          cmd: 'lody session create --agent codex "Corrige los errores 500 de auth"',
        },
        { cmd: 'lody session chat <id> "Revisa también los límites de tasa"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: 'Publica en equipo desde un solo espacio',
      body: 'Las sesiones se comparten para que las decisiones permanezcan en el espacio del equipo: cede el control y continúa desde el mismo contexto',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'es'),
        label: 'Cómo traspasar una sesión',
      },
      points: [
        'Abre la sesión de cualquier compañero y sigue conversando',
        'Tus máquinas son privadas hasta que decidas compartirlas',
      ],
      features: [
        {
          id: 'usage',
          title: 'Uso por miembro',
          body: 'Desglose de tokens y costes por modelo y miembro dentro del espacio de trabajo.',
        },
        {
          id: 'pr',
          title: 'PR, CI y fusión',
          body: 'Estado del pull request, comprobaciones, conversación y fusión dentro de la sesión.',
        },
      ],
    },
    mobileDeep: {
      title: 'Control en vivo desde móvil y Dynamic Island',
      body: 'Sigue el progreso del agente y aprueba permisos sin volver a abrir la app',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt:
        'Lody en la Dynamic Island del iPhone: solicitud de permiso del agente con Denegar y Permitir',
    },
    cta: {
      slogan: 'Tus agentes. En todas partes',
      lead: 'Escritorio, móvil y navegador. El mismo espacio de trabajo',
      allPlatforms: 'Todas las plataformas',
      allPlatformsHref: localizeSitePath('/download', 'es'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: 'Hablar con un fundador',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: 'Descargar para macOS',
        macIntel: 'Mac Intel',
        win: 'Descargar para Windows',
        linux: 'Descargar para Linux',
        ios: 'Descargar en el App Store',
        android: 'Descargar APK de Android',
        browser: 'Abrir app web',
      },
    },
    hero: {
      eyebrow: 'Espacio de trabajo para agentes de código IA',
      prefix: 'Ejecuta y comparte agentes de código IA en paralelo en móvil y escritorio',
      words: [],
      suffix: '',
      lead: 'Git worktrees aislados, sesiones compartidas, diffs en vivo y un único plano de control para sincronizar a tu equipo con Claude Code y Codex',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: 'Otras opciones de descarga',
      otherDownloadsHref: localizeSitePath('/download', 'es'),
      labels: {
        macArm: 'Descargar para macOS',
        macIntel: 'Mac Intel',
        win: 'Descargar para Windows',
        linux: 'Descargar para Linux',
        ios: 'Descargar en el App Store',
        android: 'Descargar APK de Android',
        browser: 'Abrir app web',
      },
    },
  },
  fr: {
    skipToContent: 'Aller au contenu principal',
    subscriptions: {
      title: 'Utilisez vos abonnements existants',
      body: 'Exécutez-les sur vos machines avec les offres que vous payez déjà',
      note: 'Les clés API fonctionnent aussi',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: 'Votre abonnement' },
        { id: 'codex', label: 'Codex', hint: 'Votre connexion' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '…et tout agent de code compatible ACP',
        body: 'Cursor, Gemini CLI, Cline, Goose, OpenCode, Qwen et bien plus. Tout outil qui parle Agent Client Protocol se branche à Lody',
        label: 'Agents de code pris en charge via le protocole Agent Client Protocol',
      },
    },
    orchestration: {
      title: 'Un agent peut piloter les autres',
      body: 'Gérez plusieurs sessions depuis un seul fil — sur plusieurs machines, agents et dépôts.',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'fr'),
        label: 'Comment un agent orchestre les autres',
      },
      hubLabel: 'Votre agent',
      useCases: [
        {
          title: 'Sous-agents multiplateformes',
          body: 'Lancez des sous-agents pour tester en parallèle sur macOS, Linux et Windows.',
        },
        {
          title: 'Boucle revue → correction',
          body: 'Un agent relit, un autre corrige ; itérez sans quitter la conversation.',
        },
        {
          title: 'Correctifs multi-dépôts',
          body: 'Une dépendance casse ? Corrigez-la dans une sous-session, suivez son intégration et rapatriez-la sans quitter ce fil.',
        },
      ],
      sessions: [
        { task: 'Tester sur macOS', agentId: 'codex' },
        { task: 'Corriger la dépendance', agentId: 'claude-code' },
        { task: 'Fusionner en amont', agentId: 'gemini' },
      ],
    },
    cli: {
      title: 'Connectez toute machine depuis le terminal',
      body: "Lancez npx lody daemon start sur un serveur, une VM cloud ou votre poste à la maison. Un lien de connexion s'ouvre dans le navigateur et garde la machine connectée pour recevoir des tâches depuis votre téléphone, l'app web, un script ou la CI.",
      prompt: '$',
      lines: [
        {
          caption: 'Sur la machine distante — connectez-vous une fois, elle reste en ligne',
          cmd: 'npx lody daemon start',
        },
        {
          caption: 'Depuis votre portable, un script ou la CI',
          cmd: 'lody session create --agent codex "Corriger les erreurs 500 d\'auth"',
        },
        { cmd: 'lody session chat <id> "Vérifie aussi les limites de débit"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: 'Livrez ensemble dans un seul espace',
      body: "Les sessions sont partagées afin que les décisions restent dans l'espace d'équipe — passez le relais et reprenez le guidage avec le même contexte",
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'fr'),
        label: 'Comment passer le relais sur une session',
      },
      points: [
        "Ouvrez la session d'un coéquipier et poursuivez la discussion",
        'Vos machines restent privées tant que vous ne les partagez pas',
      ],
      features: [
        {
          id: 'usage',
          title: 'Consommation par membre',
          body: "Répartition des tokens et des coûts par modèle et par membre sur l'espace.",
        },
        {
          id: 'pr',
          title: 'PR, CI et fusion',
          body: 'Statut de pull request, vérifications, discussion et fusion directement dans la session.',
        },
      ],
    },
    mobileDeep: {
      title: 'Suivi en direct sur mobile et Dynamic Island',
      body: "Suivez l'avancement des agents et validez les autorisations sans rouvrir l'app",
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt:
        "Lody sur la Dynamic Island d'iPhone : demande d'autorisation d'agent avec Refuser et Autoriser",
    },
    cta: {
      slogan: 'Vos agents. Partout',
      lead: 'Ordinateur, téléphone, navigateur. Un seul espace de travail',
      allPlatforms: 'Toutes les plateformes',
      allPlatformsHref: localizeSitePath('/download', 'fr'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: 'Échanger avec un fondateur',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: 'Télécharger pour macOS',
        macIntel: 'Mac Intel',
        win: 'Télécharger pour Windows',
        linux: 'Télécharger pour Linux',
        ios: "Télécharger sur l'App Store",
        android: "Télécharger l'APK Android",
        browser: "Ouvrir l'app web",
      },
    },
    hero: {
      eyebrow: 'Espace d’équipe pour agents de code IA',
      prefix: 'Exécutez et partagez vos agents de code IA en parallèle sur mobile et ordinateur',
      words: [],
      suffix: '',
      lead: 'Worktrees Git isolés, sessions partagées, revue de diff en direct et plan de contrôle unique — synchronisez votre équipe avec Claude Code et Codex',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: 'Autres options de téléchargement',
      otherDownloadsHref: localizeSitePath('/download', 'fr'),
      labels: {
        macArm: 'Télécharger pour macOS',
        macIntel: 'Mac Intel',
        win: 'Télécharger pour Windows',
        linux: 'Télécharger pour Linux',
        ios: "Télécharger sur l'App Store",
        android: "Télécharger l'APK Android",
        browser: "Ouvrir l'app web",
      },
    },
  },
  ru: {
    skipToContent: 'Перейти к основному содержимому',
    subscriptions: {
      title: 'Используйте подписки, которые у вас уже есть',
      body: 'Запускайте агентов на своих машинах по уже оплаченному тарифу',
      note: 'API-ключи тоже поддерживаются',
      providers: [
        { id: 'claude-code', label: 'Claude Code', hint: 'Ваша подписка' },
        { id: 'codex', label: 'Codex', hint: 'Ваш аккаунт' },
        { id: 'grok', label: 'Grok', hint: 'Grok Build' },
        { id: 'kimi', label: 'Kimi', hint: 'Kimi Code' },
      ],
      wall: {
        title: '…и любой агент разработки с поддержкой ACP',
        body: 'Cursor, Gemini CLI, Cline, Goose, OpenCode, Qwen и другие. Всё, что поддерживает Agent Client Protocol, подключается к Lody',
        label: 'Агенты разработки, поддерживаемые через Agent Client Protocol',
      },
    },
    orchestration: {
      title: 'Один агент управляет остальными',
      body: 'Управляйте множеством сессий из одного чата — на разных машинах, агентах и репозиториях.',
      docsLink: {
        href: localizeSitePath('/docs/session-orchestration', 'ru'),
        label: 'Как один агент запускает другие сессии',
      },
      hubLabel: 'Ваш агент',
      useCases: [
        {
          title: 'Мультиплатформенные субагенты',
          body: 'Запускайте субагентов для параллельного тестирования на macOS, Linux и Windows.',
        },
        {
          title: 'Цикл ревью → исправление',
          body: 'Один агент проверяет, другой исправляет — итерируйте, не выходя из чата.',
        },
        {
          title: 'Исправления в соседних репозиториях',
          body: 'Сломалась зависимость? Исправьте её в подсессии, дождитесь слияния и подтяните изменения, оставаясь в этом чате.',
        },
      ],
      sessions: [
        { task: 'Проверить на macOS', agentId: 'codex' },
        { task: 'Починить зависимость', agentId: 'claude-code' },
        { task: 'Слить в upstream', agentId: 'gemini' },
      ],
    },
    cli: {
      title: 'Подключите любую машину из терминала',
      body: 'Выполните npx lody daemon start на сервере, в облачной ВМ или на домашнем ПК. Команда откроет ссылку для входа в браузере и оставит машину на связи — после этого ей можно ставить задачи с телефона, из веб-приложения, скрипта или CI.',
      prompt: '$',
      lines: [
        {
          caption: 'На удалённой машине — войдите один раз, связь сохраняется',
          cmd: 'npx lody daemon start',
        },
        {
          caption: 'С ноутбука, из скрипта или CI',
          cmd: 'lody session create --agent codex "Исправить ошибки 500 в auth"',
        },
        { cmd: 'lody session chat <id> "Проверь также лимиты запросов"' },
        { cmd: 'lody session list' },
        { cmd: 'lody session status <id>' },
      ],
    },
    power: {
      title: 'Выпускайте релизы вместе в одном пространстве',
      body: 'Сессии общие, поэтому все решения остаются в рабочем пространстве команды — передавайте задачи и направляйте агентов в едином контексте',
      docsLink: {
        href: localizeSitePath('/docs/session-handoff', 'ru'),
        label: 'Как передать сессию коллеге',
      },
      points: [
        'Откройте сессию любого коллеги и продолжите диалог',
        'Машины остаются приватными, пока вы сами их не откроете команде',
      ],
      features: [
        {
          id: 'usage',
          title: 'Расход по участникам',
          body: 'Детализация токенов и затрат по моделям и участникам рабочего пространства.',
        },
        {
          id: 'pr',
          title: 'PR, CI и слияние',
          body: 'Статус pull request, проверки, обсуждение и слияние прямо внутри сессии.',
        },
      ],
    },
    mobileDeep: {
      title: 'Контроль с телефона и на Dynamic Island',
      body: 'Прогресс агента и запросы разрешений без повторного открытия приложения',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt:
        'Lody на Dynamic Island iPhone: запрос разрешения агента с кнопками «Запретить» и «Разрешить»',
    },
    cta: {
      slogan: 'Ваши агенты. Повсюду',
      lead: 'Компьютер, телефон, браузер. Одно рабочее пространство',
      allPlatforms: 'Все платформы',
      allPlatformsHref: localizeSitePath('/download', 'ru'),
      github: 'GitHub',
      githubHref: GITHUB_REPO_URL,
      webAppHref: '/login',
      bookCall: 'Созвониться с основателем',
      bookCallHref: founderCallUrl('landing'),
      labels: {
        macArm: 'Скачать для macOS',
        macIntel: 'Intel Mac',
        win: 'Скачать для Windows',
        linux: 'Скачать для Linux',
        ios: 'Открыть в App Store',
        android: 'Скачать Android APK',
        browser: 'Открыть веб-приложение',
      },
    },
    hero: {
      eyebrow: 'Командное пространство для ИИ-агентов разработки',
      prefix: 'Запускайте и делитесь ИИ-агентами для кода параллельно на телефоне и компьютере',
      words: [],
      suffix: '',
      lead: 'Изолированные Git worktree, общие сессии, живой diff и единая панель управления — синхронизируйте команду с Claude Code и Codex',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: 'Другие варианты загрузки',
      otherDownloadsHref: localizeSitePath('/download', 'ru'),
      labels: {
        macArm: 'Скачать для macOS',
        macIntel: 'Intel Mac',
        win: 'Скачать для Windows',
        linux: 'Скачать для Linux',
        ios: 'Открыть в App Store',
        android: 'Скачать Android APK',
        browser: 'Открыть веб-приложение',
      },
    },
  },
};
