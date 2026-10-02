/**
 * Landing SEO / AI-crawler payload: search description, feature list, JSON-LD.
 * Kept free of React so route heads can render the payload during prerender.
 */

export type LandingSeoLocale = 'en' | 'zh';

export type LandingFeatureItem = {
  name: string;
  description: string;
};

const EN_FEATURES: readonly LandingFeatureItem[] = [
  {
    name: 'Parallel coding agents',
    description: 'Run multiple agents at once, each in its own session.',
  },
  {
    name: 'Isolated Git worktrees',
    description: 'Branch and experiment without clobbering your main checkout.',
  },
  {
    name: 'Live diff review',
    description: 'Review agent edits in real time as they land.',
  },
  {
    name: 'Design / preview mode',
    description: 'Open live previews and iterate on UI from the same workspace.',
  },
  {
    name: 'Agent orchestration',
    description: 'One agent can start, message, and steer other agents across machines and repos.',
  },
  {
    name: 'CLI and automation',
    description:
      'Scripts, CI, and external systems open sessions and kick off work via the same control plane.',
  },
  {
    name: 'Team shared sessions',
    description: 'Hand off and continue work in a shared team workspace.',
  },
  {
    name: 'PR, CI, and merge',
    description: 'Follow pull requests, checks, and merge actions inside the product.',
  },
  {
    name: 'Usage by member',
    description: 'See token and cost usage broken down by model and teammate.',
  },
  {
    name: 'Bring your own subscriptions',
    description:
      'Use Claude Code, Codex, Grok, Kimi, and other ACP-compatible agents on your machines.',
  },
  {
    name: 'Mobile and Dynamic Island',
    description: 'Track progress and answer permission prompts from your phone.',
  },
  {
    name: 'GitHub integration',
    description: 'Connect agent work to repositories, pull requests, and review loops.',
  },
];

const ZH_FEATURES: readonly LandingFeatureItem[] = [
  {
    name: '并行 Coding Agents',
    description: '同时运行多个 Agent，各自独立会话。',
  },
  {
    name: '隔离 Git Worktree',
    description: '在独立 worktree 里改代码，不弄乱主工作区。',
  },
  {
    name: '实时差异查看',
    description: 'Agent 改动实时出现在差异视图里，方便 review。',
  },
  {
    name: '设计 / 预览模式',
    description: '在同一工作区打开预览并迭代界面。',
  },
  {
    name: 'Agent 调度其他 Agent',
    description: '一个对话里跨机器、跨仓库开会话、发消息、盯进度。',
  },
  {
    name: 'CLI 与自动化',
    description: '脚本、CI 和外部系统通过同一控制面开会话、触发任务。',
  },
  {
    name: '团队共享会话',
    description: '在团队 workspace 里 hand off，接着聊、接着 steer。',
  },
  {
    name: 'PR、CI 与合入',
    description: '在产品里跟进 PR、检查项与 merge。',
  },
  {
    name: '按成员用量',
    description: '按模型与成员查看 token 与费用。',
  },
  {
    name: '自带订阅 / ACP',
    description: '在你自己的机器上使用 Claude Code、Codex、Grok、Kimi 等 ACP Agent。',
  },
  {
    name: '移动端与灵动岛',
    description: '在手机上查看进度、处理权限请求。',
  },
  {
    name: 'GitHub 集成',
    description: '把 Agent 工作接到仓库、PR 与 review 流程。',
  },
];

export function landingFeatures(locale: LandingSeoLocale): readonly LandingFeatureItem[] {
  return locale === 'zh' ? ZH_FEATURES : EN_FEATURES;
}

export function landingMetaDescription(locale: LandingSeoLocale): string {
  if (locale === 'zh') {
    return 'Lody 是团队 AI Coding Agent 工作区，支持并行 Agent、隔离 Git Worktree、实时 Diff Review、GitHub 集成、跨设备协作与移动端访问。';
  }
  return 'Lody is a team workspace for running AI coding agents in parallel with isolated Git worktrees, live diff review, GitHub integration, and mobile access.';
}

export function landingPageTitle(locale: LandingSeoLocale): string {
  return locale === 'zh'
    ? 'Lody - 安全地并行运行你的 Agents'
    : 'Lody - Run your agents in parallel, safely';
}

/** SoftwareApplication JSON-LD for crawlers and AI agents (no JS required). */
export function landingJsonLd(locale: LandingSeoLocale): Record<string, unknown> {
  const features = landingFeatures(locale);
  const isZh = locale === 'zh';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Lody',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Windows, Linux, iOS, Android, Web',
    url: isZh ? 'https://lody.ai/zh' : 'https://lody.ai/',
    description: landingMetaDescription(locale),
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: isZh ? '提供免费版与 Plus 等方案' : 'Free tier and Plus plans available',
    },
    featureList: features.map((f) => f.name),
    about: features.map((f) => ({
      '@type': 'Thing',
      name: f.name,
      description: f.description,
    })),
  };
}
