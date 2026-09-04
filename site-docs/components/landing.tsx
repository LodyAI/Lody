import type { CliSectionCopy } from './landing-cli-section';
import type { LandingCtaCopy } from './landing-cta-section';
import type { MobileDeepSectionCopy } from './landing-mobile-deep-section';
import type { OrchestrationSectionCopy } from './landing-orchestration-section';
import type { PowerSectionCopy } from './landing-power-section';
import type { SubscriptionsSectionCopy } from './landing-subscriptions-section';
import { founderCallUrl } from '@site/lib/founder-call';
import { GITHUB_REPO_URL } from '@site/lib/github';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';
import { UnderwaterExperience } from './underwater-experience';

export type LandingLocale = 'en' | 'zh';

type LandingCopy = {
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

const copy: Record<LandingLocale, LandingCopy> = {
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
        href: '/docs/session-orchestration',
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
        href: '/docs/session-handoff',
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
      title: 'Live on Dynamic Island',
      body: 'Agent progress and permission prompts without reopening the app',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt: 'Lody on iPhone Dynamic Island: agent permission prompt with Deny and Allow',
    },
    cta: {
      slogan: 'Your agents. Everywhere',
      lead: 'Desktop, phone, browser. Same workspace',
      allPlatforms: 'All platforms',
      allPlatformsHref: '/download',
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
      eyebrow: 'Team agent workspace',
      // Static headline (no rotating words) — shared claim for phone + desktop + team.
      prefix: 'Share coding agents with your team on phone and desktop',
      words: [],
      suffix: '',
      lead: 'Shared sessions, live diffs, and one control plane — so your team and agents stay in sync',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: 'Other download options',
      otherDownloadsHref: '/download',
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
        href: '/zh/docs/session-orchestration',
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
        href: '/zh/docs/session-handoff',
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
      title: '灵动岛上看进度',
      body: '不打开 App 也能看状态、处理权限',
      mediaImage: '/landing/dynamic-island.png',
      mediaAlt: 'iPhone 灵动岛上的 Lody：Agent 权限请求，可 Deny / Allow',
    },
    cta: {
      slogan: '你的 Agents，处处可用',
      lead: '桌面、手机、浏览器。同一工作区',
      allPlatforms: '全部平台',
      allPlatformsHref: '/zh/download',
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
      eyebrow: '团队 Agent 工作区',
      // Two-line headline: hard break after the device phrase (see underwater-experience).
      prefix: '在手机或电脑上',
      words: [],
      suffix: '和团队共用 Coding Agents',
      lead: '共享会话、实时差异、统一控制面 — 团队与 Agents 始终同步',
      secondary: 'GitHub',
      secondaryHref: GITHUB_REPO_URL,
      secondaryExternal: true,
      webAppHref: '/login',
      otherDownloads: '其他下载方式',
      otherDownloadsHref: '/zh/download',
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
};

export function LandingPage({ locale }: { locale: LandingLocale }) {
  const t = copy[locale];

  return (
    <div className="underwater-landing">
      <a className="uw-skip-link" href="#main-content">
        {t.skipToContent}
      </a>

      <SiteNav locale={locale} languageHref={locale === 'zh' ? '/home' : '/zh/home'} />

      <UnderwaterExperience
        subscriptions={t.subscriptions}
        orchestration={t.orchestration}
        cli={t.cli}
        power={t.power}
        mobileDeep={t.mobileDeep}
        cta={t.cta}
        hero={t.hero}
        locale={locale}
      />

      <SiteFooter locale={locale} />
    </div>
  );
}
