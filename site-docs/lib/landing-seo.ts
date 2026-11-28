/**
 * Landing SEO / AI-crawler payload: localized keyword mapping, search title,
 * description, feature list, and SoftwareApplication JSON-LD.
 * Kept free of React so route heads can render the payload during prerender.
 */

import type { SiteLocale } from '@site/src/site-pages/shared';

export type LandingSeoLocale = SiteLocale;

export type LandingFeatureItem = {
  name: string;
  description: string;
};

export type LandingKeywordMap = {
  /** Native developer search term mapped from the English category Top Keyword. */
  primary: string;
  /** Native high-intent secondary terms woven into meta, headings, and copy. */
  secondary: readonly string[];
};

const IN_LANGUAGE_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'en-US',
  zh: 'zh-CN',
  'zh-hant': 'zh-Hant',
  ja: 'ja',
  ko: 'ko',
  es: 'es',
  fr: 'fr',
  ru: 'ru',
};

const KEYWORDS_BY_LOCALE: Record<LandingSeoLocale, LandingKeywordMap> = {
  en: {
    primary: 'AI Coding Agents',
    secondary: [
      'Team Workspace',
      'Parallel AI Coding Agents',
      'Git Worktrees',
      'Claude Code',
      'Codex',
      'Live Diff Review',
      'Mobile Access',
    ],
  },
  zh: {
    primary: 'AI 编程 Agent 团队工作区',
    secondary: [
      '并行多开',
      'Claude Code',
      'Codex',
      'Git Worktree 隔离',
      '实时 Diff 审查',
      '团队会话交接',
      '手机远程控制',
    ],
  },
  'zh-hant': {
    primary: 'AI 程式設計 Agent 團隊工作區',
    secondary: [
      '並行開發',
      'Claude Code',
      'Codex',
      'Git Worktree 隔離',
      '即時 Diff 審查',
      '團隊工作階段交接',
      '手機遠端操作',
    ],
  },
  ja: {
    primary: 'AI コーディングエージェント',
    secondary: [
      '並列実行',
      'チームワークスペース',
      'Claude Code',
      'Codex',
      'Git worktree',
      'リアルタイム差分レビュー',
      'スマホ操作・承認',
    ],
  },
  ko: {
    primary: 'AI 코딩 에이전트',
    secondary: [
      '병렬 실행',
      '팀 워크스페이스',
      'Claude Code',
      'Codex',
      'Git 워크트리',
      '실시간 Diff 리뷰',
      '모바일 원격 제어',
    ],
  },
  es: {
    primary: 'Agentes de código IA',
    secondary: [
      'Espacio de trabajo en equipo',
      'En paralelo',
      'Claude Code',
      'Codex',
      'Git worktrees aislados',
      'Diffs en vivo',
      'Control móvil',
    ],
  },
  fr: {
    primary: 'Agents de code IA',
    secondary: [
      'Espace d’équipe',
      'En parallèle',
      'Claude Code',
      'Codex',
      'Worktrees Git isolés',
      'Revue de diff en direct',
      'Contrôle mobile',
    ],
  },
  ru: {
    primary: 'ИИ-агенты разработки',
    secondary: [
      'Командное пространство',
      'Параллельный запуск',
      'Claude Code',
      'Codex',
      'Изолированные Git worktree',
      'Живой diff',
      'Контроль с телефона',
    ],
  },
};

const FEATURES_BY_LOCALE: Record<LandingSeoLocale, readonly LandingFeatureItem[]> = {
  en: [
    {
      name: 'Parallel AI coding agents',
      description: 'Run multiple coding agents at once, each in its own isolated session.',
    },
    {
      name: 'Isolated Git worktrees',
      description: 'Branch and experiment in parallel without clobbering your main checkout.',
    },
    {
      name: 'Live diff review',
      description: 'Review agent code edits and line comments in real time as they land.',
    },
    {
      name: 'Design / preview mode',
      description: 'Open live previews and iterate on UI from the same workspace.',
    },
    {
      name: 'Agent orchestration',
      description:
        'One agent can start, message, and steer other agents across machines and repos.',
    },
    {
      name: 'CLI and automation',
      description:
        'Scripts, CI, and external systems open sessions and kick off work via the same control plane.',
    },
    {
      name: 'Team shared sessions and handoff',
      description: 'Hand off and continue live agent sessions in a shared team workspace.',
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
      name: 'Bring your own subscriptions (ACP)',
      description:
        'Use Claude Code, Codex, Grok, Kimi, and other ACP-compatible agents on your machines.',
    },
    {
      name: 'Mobile control and Dynamic Island',
      description: 'Track progress and answer permission prompts remotely from your phone.',
    },
    {
      name: 'GitHub integration',
      description: 'Connect agent work to repositories, pull requests, and review loops.',
    },
  ],
  zh: [
    {
      name: '并行多开 AI 编程 Agent',
      description: '同时运行多个 Claude Code、Codex 等 Agent，每个任务独立会话互不干扰。',
    },
    {
      name: 'Git Worktree 隔离开发',
      description: '每个会话分配独立 Git worktree，并行改代码不弄乱主分支工作区。',
    },
    {
      name: '实时 Diff 审查与评论',
      description: 'Agent 改动实时呈现在差异视图中，边跑边 review 并同步 PR 评论。',
    },
    {
      name: '设计 / 实时预览模式',
      description: '在同一工作区打开页面实时预览，直接标注并迭代界面。',
    },
    {
      name: '多 Agent 编排调度',
      description: '一个对话即可跨机器、跨仓库拉起并指挥其他 Agent 协同推进。',
    },
    {
      name: 'CLI 守护进程与自动化',
      description: '通过 CLI、脚本和 CI 接入同一控制面，自动创建会话并触发任务。',
    },
    {
      name: '团队共享会话与无缝交接',
      description: '把同事直接拉进正在运行的会话上下文中接力协作，而非发截图或静态链接。',
    },
    {
      name: 'PR、CI 与合入管理',
      description: '在会话内直接跟进 Pull Request、CI 检查项与合入流程。',
    },
    {
      name: '按成员与模型统计用量',
      description: '清晰查看团队每位成员与不同模型的 Token 消耗及费用明细。',
    },
    {
      name: '自带订阅与 ACP 生态',
      description: '在自有机器上直接沿用 Claude Code、Codex、Grok、Kimi 等订阅与 ACP Agent。',
    },
    {
      name: '手机远程控制与灵动岛',
      description: '离开工位也能通过手机和 iPhone 灵动岛查看进度、审批权限并继续发指令。',
    },
    {
      name: 'GitHub 深度集成',
      description: '将 Agent 会话与 GitHub 仓库、Pull Request 及代码审查闭环打通。',
    },
  ],
  'zh-hant': [
    {
      name: '並行多開 AI 程式設計 Agent',
      description: '同時執行多個 Claude Code、Codex 等 Agent，各自擁有獨立工作階段。',
    },
    {
      name: 'Git Worktree 隔離開發',
      description: '在獨立的 Git worktree 中平行修改程式碼，完全不影響主分支工作區。',
    },
    {
      name: '即時 Diff 審查與評論',
      description: 'Agent 的改動即時呈現在差異檢視中，邊執行邊完成程式碼審查。',
    },
    {
      name: '設計 / 即時預覽模式',
      description: '在同一工作區開啟即時預覽並持續迭代介面。',
    },
    {
      name: '多 Agent 調度協作',
      description: '一個 Agent 可跨機器、跨儲存庫啟動、傳訊並引導其他 Agent。',
    },
    {
      name: 'CLI 與自動化控制面',
      description: '指令碼、CI 與外部系統透過同一控制平面開啟工作階段並觸發任務。',
    },
    {
      name: '團隊共享工作階段與交接',
      description: '在共享團隊工作區中直接交接即時工作階段，接續同一脈絡開發。',
    },
    {
      name: 'PR、CI 與合併管理',
      description: '在產品內直接追蹤 Pull Request、檢查項目與合併操作。',
    },
    {
      name: '依成員與模型統計用量',
      description: '依模型與團隊成員檢視 Token 與費用明細。',
    },
    {
      name: '自帶訂閱 / ACP 生態',
      description: '在自己的機器上沿用 Claude Code、Codex、Grok、Kimi 等相容 ACP 的 Agent。',
    },
    {
      name: '手機遠端操作與動態島',
      description: '透過手機與動態島隨時掌握進度、即時回應權限請求。',
    },
    {
      name: 'GitHub 整合',
      description: '將 Agent 工作與儲存庫、Pull Request 及審查流程無縫銜接。',
    },
  ],
  ja: [
    {
      name: 'AI コーディングエージェントの並列実行',
      description: '複数の Claude Code や Codex などのエージェントを独立したセッションで同時実行。',
    },
    {
      name: 'Git worktree による作業分離',
      description: 'メインのチェックアウトを汚さずに複数ブランチで安全に並列開発。',
    },
    {
      name: 'リアルタイム差分レビュー',
      description: 'エージェントの編集内容をリアルタイムに差分ビューで確認・コメント。',
    },
    {
      name: 'デザイン / ライブプレビュー',
      description: '同じワークスペース内でライブプレビューを開いて UI を反復改善。',
    },
    {
      name: 'エージェントオーケストレーション',
      description: '1 つのエージェントから複数マシン・リポジトリの他エージェントを起動・制御。',
    },
    {
      name: 'CLI と自動化',
      description: 'スクリプトや CI、外部システムから同じコントロールプレーンでセッションを起動。',
    },
    {
      name: 'チーム共有セッション・引き継ぎ',
      description: '共有チームワークスペースで会話・差分ごと作業を引き継ぎ、そのまま継続。',
    },
    {
      name: 'PR・CI・マージ管理',
      description: 'Pull Request、チェック状況、マージ操作をプロダクト内で一貫管理。',
    },
    {
      name: 'メンバー別トークン・コスト集計',
      description: 'モデル別・チームメンバー別のトークン使用量とコストを可視化。',
    },
    {
      name: '既存サブスクリプション・ACP 対応',
      description:
        'Claude Code、Codex、Grok、Kimi などの ACP 対応エージェントを自分のマシンで実行。',
    },
    {
      name: 'スマホ操作と Dynamic Island',
      description: 'スマートフォンから進捗を確認し、権限リクエストにリアルタイム承認。',
    },
    {
      name: 'GitHub 連携',
      description: 'エージェントの作業をリポジトリ、PR、レビューサイクルに直接連携。',
    },
  ],
  ko: [
    {
      name: 'AI 코딩 에이전트 병렬 실행',
      description: 'Claude Code, Codex 등 여러 에이전트를 독립 세션에서 동시에 실행합니다.',
    },
    {
      name: '격리된 Git 워크트리',
      description: '메인 체크아웃을 건드리지 않고 안전하게 브랜치를 분기하고 병렬 개발합니다.',
    },
    {
      name: '실시간 Diff 리뷰',
      description: '에이전트가 코드를 수정하는 즉시 변경 사항을 실시간으로 검토하고 코멘트합니다.',
    },
    {
      name: '디자인 / 라이브 프리뷰 모드',
      description: '같은 워크스페이스에서 라이브 프리뷰를 열고 UI를 반복 개선합니다.',
    },
    {
      name: '에이전트 오케스트레이션',
      description:
        '하나의 에이전트가 여러 머신과 저장소에 걸쳐 다른 에이전트를 시작하고 제어합니다.',
    },
    {
      name: 'CLI 및 자동화',
      description:
        '스크립트, CI, 외부 시스템이 동일한 컨트롤 플레인으로 세션을 열고 작업을 실행합니다.',
    },
    {
      name: '팀 공유 세션 및 인수인계',
      description: '공유 팀 워크스페이스에서 대화와 diff 맥락 그대로 작업을 인계하고 이어갑니다.',
    },
    {
      name: 'PR, CI 및 병합',
      description: '제품 안에서 Pull Request, CI 체크, 병합 작업을 한 번에 추적합니다.',
    },
    {
      name: '멤버별 사용량 분석',
      description: '모델과 팀원별 토큰 사용량 및 비용을 한눈에 확인합니다.',
    },
    {
      name: '기존 구독 연동 / ACP 지원',
      description: '내 머신에서 Claude Code, Codex, Grok, Kimi 등 ACP 호환 에이전트를 실행합니다.',
    },
    {
      name: '모바일 원격 제어 및 Dynamic Island',
      description: '휴대폰에서 진행 상황을 확인하고 권한 요청에 즉시 응답합니다.',
    },
    {
      name: 'GitHub 연동',
      description: '에이전트 작업을 저장소, Pull Request, 코드 리뷰 흐름과 연결합니다.',
    },
  ],
  es: [
    {
      name: 'Agentes de código IA en paralelo',
      description:
        'Ejecuta Claude Code, Codex y múltiples agentes a la vez, cada uno en su propia sesión.',
    },
    {
      name: 'Git worktrees aislados',
      description: 'Crea ramas y desarrolla en paralelo sin alterar tu copia de trabajo principal.',
    },
    {
      name: 'Revisión de diffs en vivo',
      description: 'Revisa los cambios de los agentes en tiempo real a medida que llegan.',
    },
    {
      name: 'Modo diseño / vista previa',
      description:
        'Abre vistas previas en vivo e itera sobre la interfaz desde el mismo espacio de trabajo.',
    },
    {
      name: 'Orquestación de agentes',
      description:
        'Un agente puede iniciar, enviar mensajes y dirigir a otros agentes entre máquinas y repositorios.',
    },
    {
      name: 'CLI y automatización',
      description:
        'Scripts, CI y sistemas externos abren sesiones e inician tareas mediante el mismo plano de control.',
    },
    {
      name: 'Sesiones compartidas y traspaso en equipo',
      description: 'Transfiere y continúa sesiones en vivo en un espacio de trabajo compartido.',
    },
    {
      name: 'PR, CI y fusión',
      description:
        'Sigue pull requests, comprobaciones y fusiones directamente dentro del producto.',
    },
    {
      name: 'Uso por miembro',
      description: 'Consulta el consumo de tokens y costes desglosado por modelo y compañero.',
    },
    {
      name: 'Usa tus propias suscripciones (ACP)',
      description:
        'Usa Claude Code, Codex, Grok, Kimi y otros agentes compatibles con ACP en tus máquinas.',
    },
    {
      name: 'Control móvil y Dynamic Island',
      description: 'Sigue el progreso y aprueba permisos de forma remota desde tu teléfono.',
    },
    {
      name: 'Integración con GitHub',
      description:
        'Conecta el trabajo de los agentes con repositorios, pull requests y ciclos de revisión.',
    },
  ],
  fr: [
    {
      name: 'Agents de code IA en parallèle',
      description:
        'Exécutez Claude Code, Codex et plusieurs agents simultanément, chacun dans sa session.',
    },
    {
      name: 'Worktrees Git isolés',
      description:
        'Créez des branches et travaillez en parallèle sans perturber votre copie principale.',
    },
    {
      name: 'Revue de diff en direct',
      description:
        'Passez en revue les modifications des agents en temps réel dès qu’elles arrivent.',
    },
    {
      name: 'Mode design / aperçu en direct',
      description:
        'Ouvrez des aperçus en direct et itérez sur l’interface dans le même espace de travail.',
    },
    {
      name: 'Orchestration d’agents',
      description:
        'Un agent peut démarrer, contacter et piloter d’autres agents sur plusieurs machines et dépôts.',
    },
    {
      name: 'CLI et automatisation',
      description:
        'Scripts, CI et systèmes externes ouvrent des sessions et lancent des tâches via le même plan de contrôle.',
    },
    {
      name: 'Sessions partagées et passage de relais',
      description: 'Passez le relais et poursuivez une session en direct dans un espace d’équipe.',
    },
    {
      name: 'PR, CI et fusion',
      description:
        'Suivez les pull requests, les vérifications et les fusions directement dans le produit.',
    },
    {
      name: 'Consommation par membre',
      description: 'Consultez la consommation de jetons et les coûts par modèle et par coéquipier.',
    },
    {
      name: 'Vos propres abonnements (ACP)',
      description:
        'Utilisez Claude Code, Codex, Grok, Kimi et d’autres agents compatibles ACP sur vos machines.',
    },
    {
      name: 'Contrôle mobile et Dynamic Island',
      description:
        'Suivez l’avancement et répondez aux demandes d’autorisation depuis votre téléphone.',
    },
    {
      name: 'Intégration GitHub',
      description: 'Reliez le travail des agents aux dépôts, pull requests et boucles de revue.',
    },
  ],
  ru: [
    {
      name: 'Параллельный запуск ИИ-агентов для кода',
      description:
        'Запускайте Claude Code, Codex и несколько агентов одновременно, каждого в своей сессии.',
    },
    {
      name: 'Изолированные Git worktree',
      description:
        'Создавайте ветки и ведите параллельную разработку, не затрагивая основную копию.',
    },
    {
      name: 'Просмотр diff в реальном времени',
      description: 'Проверяйте правки агентов и оставляйте комментарии сразу по мере их появления.',
    },
    {
      name: 'Режим дизайна и предпросмотра',
      description:
        'Открывайте живой предпросмотр и дорабатывайте интерфейс в том же рабочем пространстве.',
    },
    {
      name: 'Оркестрация агентов',
      description:
        'Один агент может запускать, отправлять сообщения и направлять других агентов на разных машинах и в разных репозиториях.',
    },
    {
      name: 'CLI и автоматизация',
      description:
        'Скрипты, CI и внешние системы открывают сессии и запускают задачи через единую плоскость управления.',
    },
    {
      name: 'Общие сессии команды и передача контекста',
      description: 'Передавайте живую сессию коллеге и продолжайте работу в общем пространстве.',
    },
    {
      name: 'PR, CI и слияние',
      description: 'Отслеживайте pull request, проверки и слияния прямо в приложении.',
    },
    {
      name: 'Расход по участникам',
      description:
        'Просматривайте расход токенов и затрат в разбивке по моделям и участникам команды.',
    },
    {
      name: 'Собственные подписки и ACP',
      description:
        'Используйте Claude Code, Codex, Grok, Kimi и других ACP-совместимых агентов на своих машинах.',
    },
    {
      name: 'Контроль с телефона и Dynamic Island',
      description: 'Следите за ходом задач и подтверждайте запросы разрешений удалённо с телефона.',
    },
    {
      name: 'Интеграция с GitHub',
      description: 'Связывайте работу агентов с репозиториями, pull request и процессом ревью.',
    },
  ],
};

const META_DESCRIPTION_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'Run Claude Code, Codex, and ACP AI coding agents in parallel with isolated Git worktrees, live diff review, team session handoff, and mobile control.',
  zh: 'Lody 是面向开发团队的 AI 编程 Agent 工作区：支持 Claude Code、Codex 与 ACP 并行多开、Git Worktree 隔离、实时 Diff 审查、团队会话交接与手机远程控制。',
  'zh-hant':
    'Lody 是面向開發團隊的 AI 程式設計 Agent 工作區：支援 Claude Code、Codex 與 ACP 並行開發、Git Worktree 隔離、即時 Diff 審查、團隊工作階段交接與手機遠端操作。',
  ja: 'Claude Code・Codex など ACP 対応 AI コーディングエージェントを Git worktree で安全に並列実行。リアルタイム差分レビュー、チームでのセッション引き継ぎ、スマホからの進捗確認・承認までひとつのワークスペースで。',
  ko: 'Claude Code, Codex 등 ACP 호환 AI 코딩 에이전트를 격리된 Git 워크트리로 병렬 실행하세요. 실시간 Diff 리뷰, 팀 세션 인수인계, 모바일 원격 제어까지 하나의 팀 워크스페이스에서 지원합니다.',
  es: 'Ejecuta Claude Code, Codex y agentes de código IA (ACP) en paralelo con Git worktrees aislados, diffs en vivo, sesiones en equipo y control móvil.',
  fr: 'Exécutez Claude Code, Codex et vos agents de code IA (ACP) en parallèle : worktrees Git isolés, diff en direct, relais d’équipe et contrôle mobile.',
  ru: 'Запускайте Claude Code, Codex и ACP ИИ-агентов для кода параллельно в изолированных Git worktree: живой diff, общие сессии команды и контроль с телефона.',
};

const PAGE_TITLE_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'Lody — Team Workspace for Parallel AI Coding Agents',
  zh: 'Lody — AI 编程 Agent 团队工作区：并行多开与手机协同',
  'zh-hant': 'Lody — AI 程式設計 Agent 團隊工作區：並行開發與行動協作',
  ja: 'Lody — AI コーディングエージェント並列実行チームワークスペース',
  ko: 'Lody — AI 코딩 에이전트 병렬 실행 팀 워크스페이스',
  es: 'Lody — Espacio de trabajo para agentes de código IA en paralelo',
  fr: 'Lody — Espace d’équipe pour agents de code IA en parallèle',
  ru: 'Lody — ИИ-агенты разработки: командное пространство',
};

const OFFERS_DESCRIPTION_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'Free tier and Plus plans available',
  zh: '提供免费版与 Plus 等方案',
  'zh-hant': '提供免費版與 Plus 等方案',
  ja: '無料プランと Plus プランを提供',
  ko: '무료 플랜 및 Plus 요금제 제공',
  es: 'Planes Free y Plus disponibles',
  fr: 'Offre gratuite et forfaits Plus disponibles',
  ru: 'Доступны бесплатный тариф и планы Plus',
};

const LANDING_URL_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'https://lody.ai/',
  zh: 'https://lody.ai/zh/',
  'zh-hant': 'https://lody.ai/zh-hant/',
  ja: 'https://lody.ai/ja/',
  ko: 'https://lody.ai/ko/',
  es: 'https://lody.ai/es/',
  fr: 'https://lody.ai/fr/',
  ru: 'https://lody.ai/ru/',
};

export function landingSeoKeywords(locale: LandingSeoLocale): LandingKeywordMap {
  return KEYWORDS_BY_LOCALE[locale];
}

export function landingFeatures(locale: LandingSeoLocale): readonly LandingFeatureItem[] {
  return FEATURES_BY_LOCALE[locale];
}

export function landingMetaDescription(locale: LandingSeoLocale): string {
  return META_DESCRIPTION_BY_LOCALE[locale];
}

export function landingPageTitle(locale: LandingSeoLocale): string {
  return PAGE_TITLE_BY_LOCALE[locale];
}

/** SoftwareApplication JSON-LD for crawlers and AI agents (no JS required). */
export function landingJsonLd(locale: LandingSeoLocale): Record<string, unknown> {
  const features = landingFeatures(locale);
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Lody',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Windows, Linux, iOS, Android, Web',
    inLanguage: IN_LANGUAGE_BY_LOCALE[locale],
    url: LANDING_URL_BY_LOCALE[locale],
    description: landingMetaDescription(locale),
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: OFFERS_DESCRIPTION_BY_LOCALE[locale],
    },
    featureList: features.map((f) => f.name),
    about: features.map((f) => ({
      '@type': 'Thing',
      name: f.name,
      description: f.description,
    })),
  };
}
