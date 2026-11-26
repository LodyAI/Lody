/**
 * Landing SEO / AI-crawler payload: search description, feature list, JSON-LD.
 * Kept free of React so route heads can render the payload during prerender.
 */

import type { SiteLocale } from '@site/src/site-pages/shared';

export type LandingSeoLocale = SiteLocale;

export type LandingFeatureItem = {
  name: string;
  description: string;
};

const FEATURES_BY_LOCALE: Record<LandingSeoLocale, readonly LandingFeatureItem[]> = {
  en: [
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
      description:
        'One agent can start, message, and steer other agents across machines and repos.',
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
  ],
  zh: [
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
  ],
  'zh-hant': [
    {
      name: '並行 Coding Agents',
      description: '同時執行多個 Agent，各自擁有獨立工作階段。',
    },
    {
      name: '隔離 Git Worktree',
      description: '在獨立的 worktree 中修改程式碼，不影響主工作區。',
    },
    {
      name: '即時差異檢視',
      description: 'Agent 的改動即時呈現在差異檢視中，方便審查。',
    },
    {
      name: '設計 / 預覽模式',
      description: '在同一工作區開啟即時預覽並持續迭代介面。',
    },
    {
      name: 'Agent 調度協作',
      description: '一個 Agent 可跨機器、跨儲存庫啟動、傳訊並引導其他 Agent。',
    },
    {
      name: 'CLI 與自動化',
      description: '指令碼、CI 與外部系統透過同一控制平面開啟工作階段並觸發任務。',
    },
    {
      name: '團隊共享工作階段',
      description: '在共享的團隊工作區中交接並接續工作。',
    },
    {
      name: 'PR、CI 與合併',
      description: '在產品內直接追蹤 Pull Request、檢查項目與合併操作。',
    },
    {
      name: '依成員統計用量',
      description: '依模型與團隊成員檢視 Token 與費用明細。',
    },
    {
      name: '自帶訂閱 / ACP',
      description: '在自己的機器上使用 Claude Code、Codex、Grok、Kimi 等相容 ACP 的 Agent。',
    },
    {
      name: '行動裝置與動態島',
      description: '在手機上掌握進度並即時回應權限請求。',
    },
    {
      name: 'GitHub 整合',
      description: '將 Agent 工作與儲存庫、Pull Request 及審查流程無縫銜接。',
    },
  ],
  ja: [
    {
      name: '並列コーディングエージェント',
      description: '複数のエージェントをそれぞれ独立したセッションで同時に実行。',
    },
    {
      name: '分離された Git worktree',
      description: 'メインのチェックアウトを汚さずにブランチ作成や実験が可能。',
    },
    {
      name: 'ライブ差分レビュー',
      description: 'エージェントの編集内容をリアルタイムに差分ビューで確認。',
    },
    {
      name: 'デザイン / プレビューモード',
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
      name: 'チーム共有セッション',
      description: '共有チームワークスペースで作業を引き継ぎ、そのまま継続。',
    },
    {
      name: 'PR・CI・マージ',
      description: 'Pull Request、チェック状況、マージ操作をプロダクト内で一貫管理。',
    },
    {
      name: 'メンバー別利用状況',
      description: 'モデル別・チームメンバー別のトークン使用量とコストを可視化。',
    },
    {
      name: '既存サブスクリプション対応',
      description:
        'Claude Code、Codex、Grok、Kimi などの ACP 対応エージェントを自分のマシンで実行。',
    },
    {
      name: 'モバイルと Dynamic Island',
      description: 'スマートフォンから進捗を確認し、権限リクエストに応答。',
    },
    {
      name: 'GitHub 連携',
      description: 'エージェントの作業をリポジトリ、PR、レビューサイクルに直接連携。',
    },
  ],
  ko: [
    {
      name: '병렬 코딩 에이전트',
      description: '여러 에이전트를 각자의 독립 세션에서 동시에 실행합니다.',
    },
    {
      name: '격리된 Git 워크트리',
      description: '메인 체크아웃을 건드리지 않고 안전하게 브랜치를 분기하고 실험합니다.',
    },
    {
      name: '실시간 Diff 리뷰',
      description: '에이전트가 코드를 수정하는 즉시 변경 사항을 실시간으로 검토합니다.',
    },
    {
      name: '디자인 / 프리뷰 모드',
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
      name: '팀 공유 세션',
      description: '공유 팀 워크스페이스에서 작업을 자연스럽게 인계하고 이어갑니다.',
    },
    {
      name: 'PR, CI 및 병합',
      description: '제품 안에서 Pull Request, CI 체크, 병합 작업을 한 번에 추적합니다.',
    },
    {
      name: '멤버별 사용량',
      description: '모델과 팀원별 토큰 사용량 및 비용을 한눈에 확인합니다.',
    },
    {
      name: '기존 구독 그대로 사용',
      description: '내 머신에서 Claude Code, Codex, Grok, Kimi 등 ACP 호환 에이전트를 실행합니다.',
    },
    {
      name: '모바일 및 Dynamic Island',
      description: '휴대폰에서 진행 상황을 확인하고 권한 요청에 바로 응답합니다.',
    },
    {
      name: 'GitHub 연동',
      description: '에이전트 작업을 저장소, Pull Request, 코드 리뷰 흐름과 연결합니다.',
    },
  ],
  es: [
    {
      name: 'Agentes de código en paralelo',
      description: 'Ejecuta múltiples agentes a la vez, cada uno en su propia sesión.',
    },
    {
      name: 'Worktrees de Git aislados',
      description: 'Crea ramas y experimenta sin alterar tu copia de trabajo principal.',
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
      name: 'Sesiones compartidas en equipo',
      description: 'Transfiere y continúa el trabajo en un espacio de trabajo compartido.',
    },
    {
      name: 'PR, CI y fusión',
      description:
        'Sigue pull requests, comprobaciones y fusiones directamente dentro del producto.',
    },
    {
      name: 'Uso por miembro',
      description: 'Consulta el consumo de tokens y costos desglosado por modelo y compañero.',
    },
    {
      name: 'Usa tus propias suscripciones',
      description:
        'Usa Claude Code, Codex, Grok, Kimi y otros agentes compatibles con ACP en tus máquinas.',
    },
    {
      name: 'Móvil y Dynamic Island',
      description: 'Sigue el progreso y responde a solicitudes de permisos desde tu teléfono.',
    },
    {
      name: 'Integración con GitHub',
      description:
        'Conecta el trabajo de los agentes con repositorios, pull requests y ciclos de revisión.',
    },
  ],
  fr: [
    {
      name: 'Agents de code en parallèle',
      description: 'Exécutez plusieurs agents simultanément, chacun dans sa propre session.',
    },
    {
      name: 'Worktrees Git isolés',
      description:
        'Créez des branches et expérimentez sans perturber votre copie de travail principale.',
    },
    {
      name: 'Revue de diff en direct',
      description:
        'Passez en revue les modifications des agents en temps réel dès qu’elles arrivent.',
    },
    {
      name: 'Mode design / aperçu',
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
      name: 'Sessions partagées en équipe',
      description: 'Passez le relais et poursuivez le travail dans un espace d’équipe partagé.',
    },
    {
      name: 'PR, CI et fusion',
      description:
        'Suivez les pull requests, les vérifications et les fusions directement dans le produit.',
    },
    {
      name: 'Utilisation par membre',
      description: 'Consultez la consommation de jetons et les coûts par modèle et par coéquipier.',
    },
    {
      name: 'Apportez vos propres abonnements',
      description:
        'Utilisez Claude Code, Codex, Grok, Kimi et d’autres agents compatibles ACP sur vos machines.',
    },
    {
      name: 'Mobile et Dynamic Island',
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
      name: 'Параллельные ИИ-агенты для кода',
      description: 'Запускайте несколько агентов одновременно, каждого в собственной сессии.',
    },
    {
      name: 'Изолированные Git worktrees',
      description: 'Создавайте ветки и экспериментируйте, не затрагивая основную рабочую копию.',
    },
    {
      name: 'Просмотр diff в реальном времени',
      description: 'Проверяйте правки агентов сразу по мере их появления.',
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
      name: 'Общие командные сессии',
      description: 'Передавайте и продолжайте работу в общем рабочем пространстве команды.',
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
      name: 'Собственные подписки / ACP',
      description:
        'Используйте Claude Code, Codex, Grok, Kimi и других ACP-совместимых агентов на своих машинах.',
    },
    {
      name: 'Мобильное приложение и Dynamic Island',
      description: 'Следите за ходом задач и подтверждайте запросы разрешений с телефона.',
    },
    {
      name: 'Интеграция с GitHub',
      description: 'Связывайте работу агентов с репозиториями, pull request и процессом ревью.',
    },
  ],
};

const META_DESCRIPTION_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'Lody is a team workspace for running AI coding agents in parallel with isolated Git worktrees, live diff review, GitHub integration, and mobile access.',
  zh: 'Lody 是团队 AI Coding Agent 工作区，支持并行 Agent、隔离 Git Worktree、实时 Diff Review、GitHub 集成、跨设备协作与移动端访问。',
  'zh-hant':
    'Lody 是團隊專用的 AI Coding Agent 工作區，支援並行 Agent、隔離 Git Worktree、即時 Diff 審查、GitHub 整合、跨裝置協作與行動端存取。',
  ja: 'Lody は AI コーディングエージェントを並列実行するためのチームワークスペースです。分離された Git worktree、ライブ差分レビュー、GitHub 連携、モバイルアクセスを備えています。',
  ko: 'Lody는 격리된 Git 워크트리, 실시간 Diff 리뷰, GitHub 연동, 모바일 액세스로 AI 코딩 에이전트를 병렬 실행하는 팀 워크스페이스입니다.',
  es: 'Lody es un espacio de trabajo en equipo para ejecutar agentes de código con IA en paralelo, con worktrees de Git aislados, revisión de diffs en vivo, integración con GitHub y acceso móvil.',
  fr: 'Lody est un espace de travail d’équipe pour exécuter des agents de code IA en parallèle avec des worktrees Git isolés, la revue de diff en direct, l’intégration GitHub et l’accès mobile.',
  ru: 'Lody — командное рабочее пространство для параллельного запуска ИИ-агентов разработки с изолированными Git worktree, просмотром diff в реальном времени, интеграцией с GitHub и мобильным доступом.',
};

const PAGE_TITLE_BY_LOCALE: Record<LandingSeoLocale, string> = {
  en: 'Lody - Run your agents in parallel, safely',
  zh: 'Lody - 安全地并行运行你的 Agents',
  'zh-hant': 'Lody - 安全地並行執行你的 Agents',
  ja: 'Lody - エージェントを安全に並列実行',
  ko: 'Lody - 에이전트를 안전하게 병렬 실행하세요',
  es: 'Lody - Ejecuta tus agentes en paralelo y con seguridad',
  fr: 'Lody - Exécutez vos agents en parallèle, en toute sécurité',
  ru: 'Lody — Безопасный параллельный запуск ИИ-агентов',
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
