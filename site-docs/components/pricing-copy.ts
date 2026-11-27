import { founderCallUrl } from '@site/lib/founder-call';
import { localizeSitePath, type SiteLocale } from '@site/src/site-pages/shared';

export type PlanId = 'free' | 'plus' | 'enterprise';
export type PlanTone = 'calm' | 'bright' | 'deep';
export type PlanFeature = string | { label: string; href: string };

export type PricingPlan = {
  id: PlanId;
  name: string;
  eyebrow: string;
  yearly: string;
  monthly: string;
  prefix: string;
  unit: string;
  yearlyNote: string;
  monthlyNote: string;
  description: string;
  featured?: boolean;
  cta: string;
  href: string;
  /** Optional low-key link under the primary CTA (e.g. book a founder call). */
  secondaryCta?: { label: string; href: string };
  tone: PlanTone;
  features: readonly PlanFeature[];
};

export type FeatureAvailability = boolean | string;

export type FeatureSection = {
  title: string;
  rows: readonly {
    feature: string;
    availability: readonly FeatureAvailability[];
  }[];
};

export type PricingCopy = {
  kicker: string;
  title: string;
  lead: string;
  leadEmphasis: string;
  leadRest: string;
  billing: {
    yearly: string;
    monthly: string;
    save: string;
    toggleLabel: string;
  };
  plansLabel: string;
  featuresLabel: string;
  faqLabel: string;
  featuresHeading: string;
  featuresLeadPrefix: string;
  featuresLeadRest: string;
  comparisonFeatureLabel: string;
  comparisonColumns: readonly string[];
  includedLabel: string;
  faqHeading: string;
  faqLead: string;
  finePrint: string;
  plans: readonly PricingPlan[];
  featureSections: readonly FeatureSection[];
  faqs: readonly {
    question: string;
    answer: string;
  }[];
};

/** Standard Plus list prices per seat per month. */
const REGULAR_PLUS_YEARLY = '8';
const REGULAR_PLUS_MONTHLY = '10';

export const PRICING_COPY: Record<SiteLocale, PricingCopy> = {
  en: {
    kicker: 'Pricing',
    title: 'Bring every agent run into one team workspace.',
    lead: 'Start free. Upgrade a workspace when unlimited sessions and shared team operations become how your team ships.',
    leadEmphasis: 'Start free.',
    leadRest:
      'Upgrade a workspace when unlimited sessions and shared team operations become how your team ships.',
    billing: {
      yearly: 'Yearly',
      monthly: 'Monthly',
      save: 'Save 20%',
      toggleLabel: 'Toggle yearly or monthly billing',
    },
    plansLabel: 'Pricing plans',
    featuresLabel: 'All features',
    faqLabel: 'Frequently asked questions',
    featuresHeading: 'Everything that comes with every plan.',
    featuresLeadPrefix: 'A workspace built around real multi-agent work:',
    featuresLeadRest:
      'parallel runs, isolated worktrees, shared context, and clean handoff from prompt to PR.',
    comparisonFeatureLabel: 'Features',
    comparisonColumns: ['Free', 'Plus', 'Enterprise'],
    includedLabel: 'Included',
    faqHeading: 'Questions before upgrading.',
    faqLead: '',
    finePrint: 'Prices in USD. Yearly billing is one upfront charge per seat for 12 months.',
    plans: [
      {
        id: 'free',
        name: 'Free',
        eyebrow: 'Explore',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: 'Free forever',
        monthlyNote: 'Free forever',
        description: 'Run real agents in a small workspace footprint. Always free.',
        cta: 'Get started',
        href: localizeSitePath('/download', 'en'),
        tone: 'calm',
        features: [
          '2 workspaces',
          '200 sessions per workspace',
          '30 turns per session',
          'Up to 3 team members',
          'Mobile access',
          '40+ agent support, BYOK',
          'Multi-device management',
          { label: 'More features', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: 'Most teams choose',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ seat / month',
        yearlyNote: 'Billed yearly',
        monthlyNote: 'Billed monthly',
        description:
          'For teams that keep one Lody workspace open all day and want fewer coordination gaps.',
        featured: true,
        cta: 'Upgrade in web app',
        href: '/login',
        tone: 'bright',
        features: [
          'Unlimited conversations',
          'Unlimited turns per conversation',
          'Unlimited team members',
          'Seat billing for accepted members in this workspace',
          'End-to-end encryption (coming soon)',
        ],
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        eyebrow: 'Custom',
        yearly: 'Custom',
        monthly: 'Custom',
        prefix: '',
        unit: '',
        yearlyNote: 'Procurement and security review',
        monthlyNote: 'Procurement and security review',
        description: 'For organizations with contracts, governance, and deployment requirements.',
        cta: 'Contact us',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: 'Book a founder call', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          'Custom contracts and invoicing',
          'Security and procurement support',
          'SSO and access controls',
          'Deployment and rollout guidance',
          'Dedicated support channel',
        ],
      },
    ],
    featureSections: [
      {
        title: 'Workspace and team',
        rows: [
          { feature: 'Workspaces', availability: ['2', 'Unlimited', 'Unlimited'] },
          {
            feature: 'Sessions per workspace',
            availability: ['Up to 200', 'Unlimited', 'Unlimited'],
          },
          {
            feature: 'Turns per session',
            availability: ['Up to 30', 'Unlimited', 'Unlimited'],
          },
          {
            feature: 'Team members',
            availability: ['Up to 3', 'Unlimited', 'Unlimited'],
          },
          {
            feature: 'Private conversations and private projects',
            availability: [true, true, true],
          },
          { feature: 'Shared agents, skills, and context', availability: [true, true, true] },
          { feature: 'Shared team machines when enabled', availability: [true, true, true] },
        ],
      },
      {
        title: 'Mobile and remote',
        rows: [
          { feature: 'Native iOS and Android apps', availability: [true, true, true] },
          {
            feature: 'Push notifications and iOS Live Activities',
            availability: [true, true, true],
          },
          { feature: 'Mobile diff review and approvals', availability: [true, true, true] },
          {
            feature: 'Responsive preview with visual annotations',
            availability: [true, true, true],
          },
          {
            feature: 'Image input and arbitrary file attachments',
            availability: [true, true, true],
          },
        ],
      },
      {
        title: 'Agent runtimes',
        rows: [
          {
            feature: 'Claude Code, Codex, OpenCode, Kimi, and 40+ coding agents',
            availability: [true, true, true],
          },
          { feature: 'Custom ACP agents', availability: [true, true, true] },
          { feature: 'BYOK with your own agent accounts', availability: [true, true, true] },
          { feature: 'Slash commands, modes, and model options', availability: [true, true, true] },
        ],
      },
      {
        title: 'GitHub and PRs',
        rows: [
          { feature: 'Repository, issue, and PR context', availability: [true, true, true] },
          { feature: 'Automatic PR binding and CI status sync', availability: [true, true, true] },
          {
            feature: 'PR panel for comments, reviews, and merges',
            availability: [true, true, true],
          },
          { feature: 'Sync diff comments to GitHub Review', availability: [true, true, true] },
        ],
      },
    ],
    faqs: [
      {
        question: 'Do you charge for AI tokens?',
        answer:
          'No. Lody only charges for the collaboration workspace. You keep using your own Claude Code, Codex, or model-provider account at zero markup.',
      },
      {
        question: 'How are new members billed?',
        answer:
          'Invitations are free. When someone joins a Plus workspace, they use an empty paid seat at no extra cost. Otherwise, a new seat is added and prorated daily from their join date. They can start using Plus immediately.',
      },
      {
        question: 'When do you collect the extra charge?',
        answer:
          'Not immediately. On monthly plans, the next renewal includes next month’s seats plus this month’s prorated additions. On yearly plans, additions are charged on the next monthly anniversary of your subscription, covering the time from joining to annual renewal.',
      },
      {
        question: 'What happens when a member leaves?',
        answer:
          'Removal or departure does not refund the current term or cancel charges already incurred. The empty seat can be reused at no extra cost until renewal. Your seat count decreases at the next monthly or annual renewal.',
      },
      {
        question: 'What if I added someone by mistake?',
        answer:
          'Remove them, then contact contact@lody.ai within 3 days of the invoice date for a refund of their prorated seat charge.',
      },
      {
        question: 'Does canceling or deleting a workspace cancel outstanding charges?',
        answer:
          'No. Charges already incurred are still due on the original billing date. Deleting a workspace does not bring that date forward.',
      },
      {
        question: 'Can we start free and upgrade later?',
        answer:
          'Yes. Free is built for real evaluation. Upgrade the moment the workspace or session limits become the bottleneck — your data and sessions stay put.',
      },
      {
        question: 'Can I switch between monthly and yearly billing?',
        answer:
          'Yes. You can change the billing cadence at any time. The new billing period starts immediately, with unused time credited by Stripe.',
      },
      {
        question: 'When should we contact you?',
        answer:
          'Choose Enterprise if you need procurement support, security review, custom terms, or rollout planning for a larger organization. Email us at contact@lody.ai.',
      },
    ],
  },
  zh: {
    kicker: '价格',
    title: '让你的团队和 Agent 一起协作',
    lead: '免费开始。当某个 workspace 需要无限 session 和稳定协作流程时，再升级到按席位付费。',
    leadEmphasis: '免费开始。',
    leadRest: '当某个 workspace 需要无限 session 和稳定协作流程时，再升级到按席位付费。',
    billing: {
      yearly: '年付',
      monthly: '月付',
      save: '省 20%',
      toggleLabel: '切换年付或月付',
    },
    plansLabel: '价格方案',
    featuresLabel: '全部功能',
    faqLabel: '常见问题',
    featuresHeading: '每个方案都包含的能力。',
    featuresLeadPrefix: '围绕真实的多 Agent 协作设计：',
    featuresLeadRest: '并行执行、隔离 worktree、共享上下文，以及从 prompt 到 PR 的清晰交接。',
    comparisonFeatureLabel: '功能',
    comparisonColumns: ['免费版', 'Plus', '企业版'],
    includedLabel: '包含',
    faqHeading: '升级前可能会问的问题。',
    faqLead: '',
    finePrint: '价格以美元计算。年付为按席位一次性支付 12 个月费用。',
    plans: [
      {
        id: 'free',
        name: '免费版',
        eyebrow: '探索',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: '永久免费',
        monthlyNote: '永久免费',
        description: '在小型 workspace 中用真实 Agent 试用 Lody，永久免费。',
        cta: '开始使用',
        href: localizeSitePath('/download', 'zh'),
        tone: 'calm',
        features: [
          '2 个 workspace',
          '每个 workspace 200 条 session',
          '每个 session 30 轮对话',
          '最多 3 名团队成员',
          '移动端访问',
          '40+ Agent 支持，BYOK',
          '多设备管理',
          { label: '更多功能', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: '多数团队选择',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ 席位 / 月',
        yearlyNote: '按年计费',
        monthlyNote: '按月计费',
        description: '把一个 Lody workspace 作为日常协作入口的团队，减少沟通断层。',
        featured: true,
        cta: '在 Web 应用中升级',
        href: '/login',
        tone: 'bright',
        features: [
          '无限对话数量',
          '无限对话轮次',
          '团队成员不限',
          '只按当前 workspace 已接受成员计 seat',
          '端到端加密（即将到来）',
        ],
      },
      {
        id: 'enterprise',
        name: '企业版',
        eyebrow: '定制',
        yearly: '定制',
        monthly: '定制',
        prefix: '',
        unit: '',
        yearlyNote: '采购及安全审查',
        monthlyNote: '采购及安全审查',
        description: '为有合同、治理、安全审查和部署需求的组织设计。',
        cta: '联系我们',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: '和创始人聊聊', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          '定制合同与发票',
          '安全与采购支持',
          'SSO 与访问控制',
          '部署与落地指导',
          '专属支持渠道',
        ],
      },
    ],
    featureSections: [
      {
        title: '工作区与团队',
        rows: [
          { feature: 'workspace 数量', availability: ['2 个', '不限', '不限'] },
          {
            feature: '每个 workspace 的 session 对话',
            availability: ['最多 200 个', '不限', '不限'],
          },
          {
            feature: '每个 session 的对话轮次',
            availability: ['最多 30 轮', '不限', '不限'],
          },
          { feature: '团队成员', availability: ['最多 3 人', '不限', '不限'] },
          { feature: '私人对话与私人项目', availability: [true, true, true] },
          { feature: '共享 Agents、Skills 与上下文', availability: [true, true, true] },
          { feature: '按需共享团队机器', availability: [true, true, true] },
        ],
      },
      {
        title: '移动与远端',
        rows: [
          { feature: 'iOS 与 Android 原生应用', availability: [true, true, true] },
          { feature: '推送通知与 iOS 实时活动', availability: [true, true, true] },
          { feature: '移动端 diff review 与审批', availability: [true, true, true] },
          { feature: '响应式预览与视觉标注', availability: [true, true, true] },
          { feature: '图像输入与任意文件附件', availability: [true, true, true] },
        ],
      },
      {
        title: 'Agent 运行时',
        rows: [
          {
            feature: '支持 Claude Code、Codex、OpenCode、Kimi 等 40+ Coding Agents',
            availability: [true, true, true],
          },
          { feature: '自定义 ACP Agent', availability: [true, true, true] },
          { feature: 'BYOK，继续使用自己的 Agent 账号', availability: [true, true, true] },
          { feature: '斜杠命令、模式与模型选项', availability: [true, true, true] },
        ],
      },
      {
        title: 'GitHub 与 PR',
        rows: [
          { feature: '仓库、Issue 与 PR 上下文', availability: [true, true, true] },
          { feature: '自动绑定 PR，同步 CI 状态', availability: [true, true, true] },
          { feature: 'PR 面板查看评论、Review 与合并', availability: [true, true, true] },
          { feature: 'Diff 评论同步到 GitHub Review', availability: [true, true, true] },
        ],
      },
    ],
    faqs: [
      {
        question: 'Lody 会对 AI token 收费吗？',
        answer:
          '不会。Lody 只对协作 workspace 收费。你继续使用自己的 Claude Code、Codex 或模型供应商账号，零加价。',
      },
      {
        question: '新增成员怎么收费？',
        answer:
          '邀请不收费，成员实际加入 Plus 工作区后才计费。有空闲的付费席位就免费复用；没有则新增一个席位，从加入当天按天折算。加入后即可使用 Plus。',
      },
      {
        question: '新增席位什么时候扣款？',
        answer:
          '不会立即扣款。月付：下次续费合并收取下个月的席位费和本月新增的折算费。年付：在下一个月度账单日（订阅日期对应的每月日期），收取加入日至年度到期的折算费。',
      },
      {
        question: '成员被移除或退出后呢？',
        answer:
          '本期不退款，已产生的费用仍需支付。空出的席位本期内可免费换人，到下次月度或年度续费时才减少席位数。',
      },
      {
        question: '误加了成员怎么办？',
        answer: '先移除成员，再于账单日起 3 天内联系 contact@lody.ai，可退还该成员的席位折算费。',
      },
      {
        question: '取消续费或删除工作区后，还要付费吗？',
        answer: '已产生的费用仍按原账单日收取，删除工作区不会提前扣款。',
      },
      {
        question: '可以先免费试用，之后再升级吗？',
        answer:
          '可以。免费版适合用真实工作流评估。当 workspace 或 session 限制开始成为瓶颈时再升级，数据与 session 不会受影响。',
      },
      {
        question: '可以在月付和年付之间切换吗？',
        answer: '可以。计费周期随时可切换，新周期立即开始，未使用的原周期金额由 Stripe 抵扣。',
      },
      {
        question: '什么时候应该联系我们？',
        answer:
          '如果你需要采购支持、安全审查、定制条款或大型组织 rollout 规划，建议选择企业版并联系我们。请发邮件至 contact@lody.ai。',
      },
    ],
  },
  'zh-hant': {
    kicker: '定價',
    title: '將每一次 Agent 執行納入同一個團隊工作區。',
    lead: '免費開始。當工作區需要無限工作階段與穩定的團隊協作流程時，再依席次升級。',
    leadEmphasis: '免費開始。',
    leadRest: '當工作區需要無限工作階段與穩定的團隊協作流程時，再依席次升級。',
    billing: {
      yearly: '年繳',
      monthly: '月繳',
      save: '省 20%',
      toggleLabel: '切換年繳或月繳',
    },
    plansLabel: '定價方案',
    featuresLabel: '全部功能',
    faqLabel: '常見問題',
    featuresHeading: '每個方案都包含的核心能力。',
    featuresLeadPrefix: '專為真實的多 Agent 協作打造：',
    featuresLeadRest: '並行執行、隔離的 worktree、共享上下文，以及從 prompt 到 PR 的順暢交接。',
    comparisonFeatureLabel: '功能',
    comparisonColumns: ['免費版', 'Plus', '企業版'],
    includedLabel: '包含',
    faqHeading: '升級前常見問題。',
    faqLead: '',
    finePrint: '價格以美元計價。年繳方案將依席次一次預收 12 個月費用。',
    plans: [
      {
        id: 'free',
        name: '免費版',
        eyebrow: '探索',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: '永久免費',
        monthlyNote: '永久免費',
        description: '在小型工作區中以真實 Agent 體驗 Lody，永久免費。',
        cta: '開始使用',
        href: localizeSitePath('/download', 'zh-hant'),
        tone: 'calm',
        features: [
          '2 個工作區',
          '每個工作區 200 個工作階段',
          '每個工作階段 30 輪對話',
          '最多 3 位團隊成員',
          '行動裝置存取',
          '支援 40+ Agent，自備金鑰（BYOK）',
          '多裝置管理',
          { label: '更多功能', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: '多數團隊選擇',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ 席次 / 月',
        yearlyNote: '按年計費',
        monthlyNote: '按月計費',
        description: '適合全天使用單一 Lody 工作區並希望減少協作斷層的團隊。',
        featured: true,
        cta: '於 Web 應用程式升級',
        href: '/login',
        tone: 'bright',
        features: [
          '無限對話次數',
          '每場對話無限輪次',
          '團隊成員人數無上限',
          '僅針對此工作區已接受邀請的成員計費',
          '端對端加密（即將推出）',
        ],
      },
      {
        id: 'enterprise',
        name: '企業版',
        eyebrow: '客製方案',
        yearly: '客製報價',
        monthly: '客製報價',
        prefix: '',
        unit: '',
        yearlyNote: '採購與資安審查',
        monthlyNote: '採購與資安審查',
        description: '為需要客製合約、治理規範與部署支援的組織設計。',
        cta: '聯絡我們',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: '與創辦人聊聊', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          '客製合約與發票開立',
          '資安與採購審查支援',
          'SSO 與存取權限控管',
          '部署與導入規劃指導',
          '專屬支援管道',
        ],
      },
    ],
    featureSections: [
      {
        title: '工作區與團隊',
        rows: [
          { feature: '工作區數量', availability: ['2 個', '無上限', '無上限'] },
          {
            feature: '每個工作區的工作階段',
            availability: ['最多 200 個', '無上限', '無上限'],
          },
          {
            feature: '每個工作階段的對話輪次',
            availability: ['最多 30 輪', '無上限', '無上限'],
          },
          { feature: '團隊成員', availability: ['最多 3 人', '無上限', '無上限'] },
          { feature: '私人對話與私人專案', availability: [true, true, true] },
          { feature: '共享 Agents、Skills 與上下文', availability: [true, true, true] },
          { feature: '啟用時可共享團隊機器', availability: [true, true, true] },
        ],
      },
      {
        title: '行動端與遠端',
        rows: [
          { feature: 'iOS 與 Android 原生應用程式', availability: [true, true, true] },
          { feature: '推播通知與 iOS 即時動態', availability: [true, true, true] },
          { feature: '行動端 diff 審查與核准', availability: [true, true, true] },
          { feature: '響應式預覽與視覺標註', availability: [true, true, true] },
          { feature: '圖片輸入與任意檔案附件', availability: [true, true, true] },
        ],
      },
      {
        title: 'Agent 執行環境',
        rows: [
          {
            feature: '支援 Claude Code、Codex、OpenCode、Kimi 等 40+ 程式設計 Agent',
            availability: [true, true, true],
          },
          { feature: '自訂 ACP Agent', availability: [true, true, true] },
          { feature: 'BYOK，繼續使用自己的 Agent 帳號', availability: [true, true, true] },
          { feature: '斜線指令、模式與模型選項', availability: [true, true, true] },
        ],
      },
      {
        title: 'GitHub 與 PR',
        rows: [
          { feature: '儲存庫、Issue 與 PR 上下文', availability: [true, true, true] },
          { feature: '自動綁定 PR 並同步 CI 狀態', availability: [true, true, true] },
          { feature: 'PR 面板檢視留言、Review 與合併', availability: [true, true, true] },
          { feature: 'Diff 留言同步至 GitHub Review', availability: [true, true, true] },
        ],
      },
    ],
    faqs: [
      {
        question: 'Lody 會對 AI token 收費嗎？',
        answer:
          '不會。Lody 僅針對協作工作區收費。您可繼續使用自己的 Claude Code、Codex 或模型供應商帳號，完全零加價。',
      },
      {
        question: '新增成員如何計費？',
        answer:
          '寄送邀請免費。成員加入 Plus 工作區時，若有閒置的付費席次將免費沿用；否則會新增一個席次，並自加入當日起按日比例計算費用。加入後即可立即使用 Plus。',
      },
      {
        question: '額外席次的費用何時扣款？',
        answer:
          '不會立即扣款。月繳方案會在下次續訂時一併收取下個月的席次費用與本月新增的比例費用；年繳方案則會在下一個月度帳單日收取自加入日至年度續約日的比例費用。',
      },
      {
        question: '成員離開或被移除後怎麼處理？',
        answer:
          '移除或退出不會退還當期費用，也不會取消已產生的款項。空出的席次可在續約前免費供其他成員使用，席次總數將於下次月繳或年繳續訂時調降。',
      },
      {
        question: '如果不小心加錯成員怎麼辦？',
        answer:
          '請先移除該成員，並於帳單開立日起 3 天內聯絡 contact@lody.ai，我們將退還該成員按比例計算的席次費用。',
      },
      {
        question: '取消訂閱或刪除工作區會取消未結清費用嗎？',
        answer: '不會。已產生的費用仍須於原定帳單日支付，刪除工作區不會使扣款日提前。',
      },
      {
        question: '可以先免費試用再升級嗎？',
        answer:
          '可以。免費版專為真實流程評估設計。當工作區或工作階段上限成為瓶頸時隨時可升級，您的所有資料與工作階段都會完整保留。',
      },
      {
        question: '可以在月繳與年繳之間切換嗎？',
        answer:
          '可以。您隨時都能變更計費週期，新週期將立即生效，原週期未使用的金額將由 Stripe 自動折抵。',
      },
      {
        question: '什麼時候應該聯絡我們？',
        answer:
          '若您的組織需要採購支援、資安審查、客製合約條款或大規模導入規劃，請選擇企業版並寄信至 contact@lody.ai。',
      },
    ],
  },
  ja: {
    kicker: '料金',
    title: 'すべてのエージェント実行を、ひとつのチームワークスペースへ。',
    lead: 'まずは無料で。無制限のセッションとチーム全体での運用が必要になったタイミングでアップグレードできます。',
    leadEmphasis: 'まずは無料で。',
    leadRest:
      '無制限のセッションとチーム全体での運用が必要になったタイミングでアップグレードできます。',
    billing: {
      yearly: '年額',
      monthly: '月額',
      save: '20% オフ',
      toggleLabel: '年額または月額課金を切り替え',
    },
    plansLabel: '料金プラン',
    featuresLabel: 'すべての機能',
    faqLabel: 'よくある質問',
    featuresHeading: 'すべてのプランに含まれる機能。',
    featuresLeadPrefix: '本格的なマルチエージェント開発のためのワークスペース：',
    featuresLeadRest:
      '並列実行、独立した worktree、共有コンテキスト、プロンプトから PR までのスムーズな引き継ぎ。',
    comparisonFeatureLabel: '機能',
    comparisonColumns: ['Free', 'Plus', 'Enterprise'],
    includedLabel: '含まれます',
    faqHeading: 'アップグレード前のよくある質問。',
    faqLead: '',
    finePrint:
      '価格はすべて米ドル（USD）表記です。年額プランは 1 シートあたり 12 か月分の一括請求となります。',
    plans: [
      {
        id: 'free',
        name: 'Free',
        eyebrow: 'まずは試す',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: 'ずっと無料',
        monthlyNote: 'ずっと無料',
        description: '小規模なワークスペースで実際のエージェントを実行できます。ずっと無料。',
        cta: 'はじめる',
        href: localizeSitePath('/download', 'ja'),
        tone: 'calm',
        features: [
          'ワークスペース 2 つまで',
          'ワークスペースあたり 200 セッション',
          '1 セッションあたり 30 ターン',
          'チームメンバー最大 3 名',
          'モバイルアクセス',
          '40+ エージェント対応・BYOK',
          'マルチデバイス管理',
          { label: 'すべての機能を見る', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: '多くのチームに選ばれています',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ シート / 月',
        yearlyNote: '年額一括請求',
        monthlyNote: '月額請求',
        description:
          'ひとつの Lody ワークスペースを日常の開発拠点として使い、連携の抜け漏れを減らしたいチーム向け。',
        featured: true,
        cta: 'Web アプリでアップグレード',
        href: '/login',
        tone: 'bright',
        features: [
          '無制限の会話数',
          '会話あたりのターン数無制限',
          'チームメンバー無制限',
          '参加承認済みメンバー数に応じたシート課金',
          'エンドツーエンド暗号化（近日公開）',
        ],
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        eyebrow: 'カスタム',
        yearly: 'お問い合わせ',
        monthly: 'お問い合わせ',
        prefix: '',
        unit: '',
        yearlyNote: '調達・セキュリティ審査対応',
        monthlyNote: '調達・セキュリティ審査対応',
        description: '個別契約、ガバナンス、セキュリティ審査、導入支援が必要な組織向け。',
        cta: 'お問い合わせ',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: '創業者と話す', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          '個別契約・請求書払い',
          'セキュリティおよび調達審査の支援',
          'SSO とアクセス制御',
          '導入・展開ガイド',
          '専用サポートチャネル',
        ],
      },
    ],
    featureSections: [
      {
        title: 'ワークスペースとチーム',
        rows: [
          { feature: 'ワークスペース数', availability: ['2', '無制限', '無制限'] },
          {
            feature: 'ワークスペースあたりのセッション数',
            availability: ['最大 200', '無制限', '無制限'],
          },
          {
            feature: 'セッションあたりのターン数',
            availability: ['最大 30', '無制限', '無制限'],
          },
          { feature: 'チームメンバー', availability: ['最大 3 名', '無制限', '無制限'] },
          {
            feature: 'プライベート会話・プライベートプロジェクト',
            availability: [true, true, true],
          },
          { feature: 'エージェント・スキル・コンテキストの共有', availability: [true, true, true] },
          { feature: '有効化時のチームマシン共有', availability: [true, true, true] },
        ],
      },
      {
        title: 'モバイルとリモート',
        rows: [
          { feature: 'iOS・Android ネイティブアプリ', availability: [true, true, true] },
          { feature: 'プッシュ通知と iOS ライブアクティビティ', availability: [true, true, true] },
          { feature: 'モバイルでの差分レビューと承認', availability: [true, true, true] },
          { feature: 'ビジュアル注釈付きレスポンシブプレビュー', availability: [true, true, true] },
          { feature: '画像入力と任意のファイル添付', availability: [true, true, true] },
        ],
      },
      {
        title: 'エージェントランタイム',
        rows: [
          {
            feature: 'Claude Code、Codex、OpenCode、Kimi を含む 40+ コーディングエージェント',
            availability: [true, true, true],
          },
          { feature: 'カスタム ACP エージェント', availability: [true, true, true] },
          {
            feature: 'ご自身のエージェントアカウントを使う BYOK',
            availability: [true, true, true],
          },
          { feature: 'スラッシュコマンド、モード、モデル選択', availability: [true, true, true] },
        ],
      },
      {
        title: 'GitHub と PR',
        rows: [
          { feature: 'リポジトリ・Issue・PR コンテキスト', availability: [true, true, true] },
          { feature: 'PR の自動紐付けと CI ステータス同期', availability: [true, true, true] },
          { feature: 'コメント・レビュー・マージ用 PR パネル', availability: [true, true, true] },
          { feature: '差分コメントの GitHub Review 同期', availability: [true, true, true] },
        ],
      },
    ],
    faqs: [
      {
        question: 'AI トークンに対して課金されますか？',
        answer:
          'いいえ。Lody はコラボレーション用ワークスペースのみに課金します。Claude Code、Codex、各種モデルプロバイダーのご自身のアカウントを上乗せなしでそのまま利用できます。',
      },
      {
        question: '新しいメンバーの課金はどうなりますか？',
        answer:
          '招待は無料です。Plus ワークスペースにメンバーが参加すると、空いている有料シートがあれば追加料金なしで割り当てられます。空きがない場合は新しいシートが追加され、参加日から日割りで計算されます。参加直後から Plus を利用できます。',
      },
      {
        question: '追加シートの料金はいつ請求されますか？',
        answer:
          '即時請求ではありません。月額プランでは次回更新時に翌月分と当月の日割り追加分が合算されます。年額プランでは、翌月の契約応答日に参加日から年次更新日までの日割り分が請求されます。',
      },
      {
        question: 'メンバーが退出・削除された場合はどうなりますか？',
        answer:
          '当期分の返金や発生済み料金のキャンセルは行われません。空いたシートは次回更新まで追加料金なしで別のメンバーに再利用でき、次回更新時にシート数が減少します。',
      },
      {
        question: '誤ってメンバーを追加してしまった場合は？',
        answer:
          'メンバーを削除したうえで、請求書発行日から 3 日以内に contact@lody.ai までご連絡ください。該当シートの日割り料金を返金いたします。',
      },
      {
        question: '解約やワークスペース削除で未精算の請求はキャンセルされますか？',
        answer:
          'いいえ。すでに発生した料金は当初の請求日に支払う必要があります。ワークスペースを削除しても請求日が早まることはありません。',
      },
      {
        question: '無料で始めて後からアップグレードできますか？',
        answer:
          'はい。Free プランは実運用での検証を前提にしています。ワークスペースやセッション数の上限に達したタイミングでアップグレードでき、既存のデータやセッションはそのまま維持されます。',
      },
      {
        question: '月額と年額の切り替えはできますか？',
        answer:
          'はい。請求サイクルはいつでも変更できます。新しい請求期間は即座に開始され、未使用期間の金額は Stripe によりクレジット精算されます。',
      },
      {
        question: 'どのようなときに問い合わせればよいですか？',
        answer:
          '調達支援、セキュリティ審査、個別契約、大規模導入計画が必要な場合は Enterprise をお選びのうえ contact@lody.ai までご連絡ください。',
      },
    ],
  },
  ko: {
    kicker: '요금',
    title: '모든 에이전트 실행을 하나의 팀 워크스페이스에서.',
    lead: '무료로 시작하세요. 무제한 세션과 팀 단위 협업 운영이 필요해질 때 워크스페이스를 업그레이드할 수 있습니다.',
    leadEmphasis: '무료로 시작하세요.',
    leadRest:
      '무제한 세션과 팀 단위 협업 운영이 필요해질 때 워크스페이스를 업그레이드할 수 있습니다.',
    billing: {
      yearly: '연간 결제',
      monthly: '월간 결제',
      save: '20% 할인',
      toggleLabel: '연간 또는 월간 결제 전환',
    },
    plansLabel: '요금제',
    featuresLabel: '전체 기능',
    faqLabel: '자주 묻는 질문',
    featuresHeading: '모든 요금제에 기본으로 포함되는 기능.',
    featuresLeadPrefix: '실제 멀티 에이전트 협업을 위해 설계된 워크스페이스:',
    featuresLeadRest:
      '병렬 실행, 격리된 worktree, 공유 컨텍스트, 그리고 프롬프트에서 PR까지의 깔끔한 인수인계.',
    comparisonFeatureLabel: '기능',
    comparisonColumns: ['Free', 'Plus', 'Enterprise'],
    includedLabel: '포함됨',
    faqHeading: '업그레이드 전 자주 묻는 질문.',
    faqLead: '',
    finePrint:
      '모든 가격은 USD 기준입니다. 연간 결제는 시트당 12개월 요금을 선불로 일괄 청구합니다.',
    plans: [
      {
        id: 'free',
        name: 'Free',
        eyebrow: '둘러보기',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: '평생 무료',
        monthlyNote: '평생 무료',
        description: '소규모 워크스페이스에서 실제 에이전트를 실행해 보세요. 평생 무료입니다.',
        cta: '시작하기',
        href: localizeSitePath('/download', 'ko'),
        tone: 'calm',
        features: [
          '워크스페이스 2개',
          '워크스페이스당 세션 200개',
          '세션당 30턴',
          '팀 멤버 최대 3명',
          '모바일 앱 접근',
          '40+ 에이전트 지원, BYOK',
          '멀티 디바이스 관리',
          { label: '더 많은 기능 보기', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: '대부분의 팀이 선택',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ 시트 / 월',
        yearlyNote: '연간 청구',
        monthlyNote: '월간 청구',
        description:
          '하루 종일 Lody 워크스페이스를 열어두고 협업 공백을 줄이고자 하는 팀을 위한 요금제.',
        featured: true,
        cta: '웹 앱에서 업그레이드',
        href: '/login',
        tone: 'bright',
        features: [
          '무제한 대화',
          '대화당 무제한 턴',
          '무제한 팀 멤버',
          '워크스페이스에 합류한 멤버 기준 시트 과금',
          '종단 간 암호화(출시 예정)',
        ],
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        eyebrow: '맞춤형',
        yearly: '맞춤 견적',
        monthly: '맞춤 견적',
        prefix: '',
        unit: '',
        yearlyNote: '조달 및 보안 검토',
        monthlyNote: '조달 및 보안 검토',
        description: '맞춤 계약, 거버넌스, 보안 검토 및 배포 요건이 있는 조직을 위한 요금제.',
        cta: '문의하기',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: '창업자와 통화 예약', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          '맞춤 계약 및 세금계산서/인보이스',
          '보안 및 조달 심사 지원',
          'SSO 및 접근 제어',
          '배포 및 도입 가이드',
          '전담 지원 채널',
        ],
      },
    ],
    featureSections: [
      {
        title: '워크스페이스 및 팀',
        rows: [
          { feature: '워크스페이스', availability: ['2개', '무제한', '무제한'] },
          {
            feature: '워크스페이스당 세션',
            availability: ['최대 200개', '무제한', '무제한'],
          },
          {
            feature: '세션당 턴 수',
            availability: ['최대 30턴', '무제한', '무제한'],
          },
          { feature: '팀 멤버', availability: ['최대 3명', '무제한', '무제한'] },
          { feature: '비공개 대화 및 비공개 프로젝트', availability: [true, true, true] },
          { feature: '공유 에이전트, 스킬 및 컨텍스트', availability: [true, true, true] },
          { feature: '허용 시 팀 머신 공유', availability: [true, true, true] },
        ],
      },
      {
        title: '모바일 및 원격',
        rows: [
          { feature: '네이티브 iOS 및 Android 앱', availability: [true, true, true] },
          { feature: '푸시 알림 및 iOS 실시간 현황', availability: [true, true, true] },
          { feature: '모바일 diff 리뷰 및 승인', availability: [true, true, true] },
          { feature: '시각적 주석이 포함된 반응형 미리보기', availability: [true, true, true] },
          { feature: '이미지 입력 및 임의 파일 첨부', availability: [true, true, true] },
        ],
      },
      {
        title: '에이전트 런타임',
        rows: [
          {
            feature: 'Claude Code, Codex, OpenCode, Kimi 등 40+ 코딩 에이전트',
            availability: [true, true, true],
          },
          { feature: '커스텀 ACP 에이전트', availability: [true, true, true] },
          { feature: '기존 에이전트 계정 그대로 사용(BYOK)', availability: [true, true, true] },
          { feature: '슬래시 명령어, 모드 및 모델 옵션', availability: [true, true, true] },
        ],
      },
      {
        title: 'GitHub 및 PR',
        rows: [
          { feature: '리포지토리, 이슈 및 PR 컨텍스트', availability: [true, true, true] },
          { feature: '자동 PR 연결 및 CI 상태 동기화', availability: [true, true, true] },
          { feature: '댓글, 리뷰, 병합을 위한 PR 패널', availability: [true, true, true] },
          { feature: 'Diff 댓글을 GitHub Review로 동기화', availability: [true, true, true] },
        ],
      },
    ],
    faqs: [
      {
        question: 'AI 토큰 비용을 별도로 청구하나요?',
        answer:
          '아니요. Lody는 협업 워크스페이스 요금만 청구합니다. Claude Code, Codex 또는 보유한 모델 제공자 계정을 추가 마크업 없이 그대로 사용하세요.',
      },
      {
        question: '새 멤버는 어떻게 과금되나요?',
        answer:
          '초대는 무료입니다. Plus 워크스페이스에 멤버가 합류하면 빈 유료 시트가 있을 경우 추가 비용 없이 배정됩니다. 빈 시트가 없으면 새 시트가 추가되며 합류일부터 일할 계산됩니다. 합류 즉시 Plus를 사용할 수 있습니다.',
      },
      {
        question: '추가 시트 요금은 언제 청구되나요?',
        answer:
          '즉시 결제되지 않습니다. 월간 요금제는 다음 갱신 시 다음 달 시트 요금과 이번 달 일할 추가분이 합산됩니다. 연간 요금제는 다음 월간 구독 기념일에 합류일부터 연간 갱신일까지의 일할 금액이 청구됩니다.',
      },
      {
        question: '멤버가 나가면 어떻게 되나요?',
        answer:
          '멤버 제거 또는 탈퇴 시 현재 결제 기간은 환불되지 않으며 이미 발생한 요금도 취소되지 않습니다. 비어 있는 시트는 갱신 전까지 추가 비용 없이 다른 멤버에게 재사용할 수 있으며, 다음 갱신 시 시트 수가 줄어듭니다.',
      },
      {
        question: '실수로 멤버를 추가한 경우 어떻게 하나요?',
        answer:
          '해당 멤버를 제거한 뒤 청구서 발행일로부터 3일 이내에 contact@lody.ai로 문의하시면 일할 계산된 시트 요금을 환불해 드립니다.',
      },
      {
        question: '구독을 취소하거나 워크스페이스를 삭제하면 미납 요금도 취소되나요?',
        answer:
          '아니요. 이미 발생한 요금은 원래 결제일에 정상 청구됩니다. 워크스페이스를 삭제하더라도 결제일이 앞당겨지지는 않습니다.',
      },
      {
        question: '무료로 시작해서 나중에 업그레이드할 수 있나요?',
        answer:
          '네. Free 요금제는 실제 워크플로 검증을 위해 마련되었습니다. 워크스페이스나 세션 한도가 필요를 넘어서면 언제든 업그레이드할 수 있으며 기존 데이터와 세션은 그대로 유지됩니다.',
      },
      {
        question: '월간 결제와 연간 결제 간 전환이 가능한가요?',
        answer:
          '네. 언제든지 결제 주기를 변경할 수 있습니다. 새 결제 주기는 즉시 시작되며 남은 기간의 금액은 Stripe에서 크레딧으로 정산됩니다.',
      },
      {
        question: '언제 영업팀에 문의해야 하나요?',
        answer:
          '대규모 조직을 위한 조달 지원, 보안 검토, 맞춤 계약 조건 또는 도입 계획이 필요하다면 Enterprise를 선택하고 contact@lody.ai로 이메일을 보내주세요.',
      },
    ],
  },
  es: {
    kicker: 'Precios',
    title: 'Reúne cada ejecución de agente en un solo espacio de equipo.',
    lead: 'Empieza gratis. Actualiza tu espacio de trabajo cuando las sesiones ilimitadas y la colaboración compartida sean parte del ritmo de tu equipo.',
    leadEmphasis: 'Empieza gratis.',
    leadRest:
      'Actualiza tu espacio de trabajo cuando las sesiones ilimitadas y la colaboración compartida sean parte del ritmo de tu equipo.',
    billing: {
      yearly: 'Anual',
      monthly: 'Mensual',
      save: 'Ahorra 20%',
      toggleLabel: 'Alternar entre facturación anual y mensual',
    },
    plansLabel: 'Planes de precios',
    featuresLabel: 'Todas las funciones',
    faqLabel: 'Preguntas frecuentes',
    featuresHeading: 'Todo lo que incluye cada plan.',
    featuresLeadPrefix:
      'Un espacio de trabajo diseñado para el trabajo real con múltiples agentes:',
    featuresLeadRest:
      'ejecuciones paralelas, worktrees aislados, contexto compartido y un traspaso limpio del prompt al PR.',
    comparisonFeatureLabel: 'Funciones',
    comparisonColumns: ['Gratis', 'Plus', 'Enterprise'],
    includedLabel: 'Incluido',
    faqHeading: 'Dudas antes de actualizar.',
    faqLead: '',
    finePrint:
      'Precios en USD. La facturación anual se cobra por adelantado por cada puesto para 12 meses.',
    plans: [
      {
        id: 'free',
        name: 'Gratis',
        eyebrow: 'Explorar',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: 'Gratis para siempre',
        monthlyNote: 'Gratis para siempre',
        description: 'Ejecuta agentes reales en un espacio pequeño. Siempre gratis.',
        cta: 'Empezar',
        href: localizeSitePath('/download', 'es'),
        tone: 'calm',
        features: [
          '2 espacios de trabajo',
          '200 sesiones por espacio de trabajo',
          '30 turnos por sesión',
          'Hasta 3 miembros del equipo',
          'Acceso móvil',
          'Más de 40 agentes compatibles, BYOK',
          'Gestión multidispositivo',
          { label: 'Más funciones', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: 'El más elegido por equipos',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ puesto / mes',
        yearlyNote: 'Facturación anual',
        monthlyNote: 'Facturación mensual',
        description:
          'Para equipos que trabajan todo el día en Lody y quieren menos fricción al coordinarse.',
        featured: true,
        cta: 'Actualizar en la app web',
        href: '/login',
        tone: 'bright',
        features: [
          'Conversaciones ilimitadas',
          'Turnos ilimitados por conversación',
          'Miembros del equipo ilimitados',
          'Facturación por puesto según miembros aceptados en el espacio',
          'Cifrado de extremo a extremo (próximamente)',
        ],
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        eyebrow: 'A medida',
        yearly: 'A medida',
        monthly: 'A medida',
        prefix: '',
        unit: '',
        yearlyNote: 'Compras y revisión de seguridad',
        monthlyNote: 'Compras y revisión de seguridad',
        description: 'Para organizaciones con requisitos de contratos, gobierno y despliegue.',
        cta: 'Contáctanos',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: 'Hablar con un fundador', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          'Contratos y facturación a medida',
          'Soporte de seguridad y compras',
          'SSO y controles de acceso',
          'Guía de despliegue y adopción',
          'Canal de soporte dedicado',
        ],
      },
    ],
    featureSections: [
      {
        title: 'Espacio de trabajo y equipo',
        rows: [
          { feature: 'Espacios de trabajo', availability: ['2', 'Ilimitados', 'Ilimitados'] },
          {
            feature: 'Sesiones por espacio de trabajo',
            availability: ['Hasta 200', 'Ilimitadas', 'Ilimitadas'],
          },
          {
            feature: 'Turnos por sesión',
            availability: ['Hasta 30', 'Ilimitados', 'Ilimitados'],
          },
          {
            feature: 'Miembros del equipo',
            availability: ['Hasta 3', 'Ilimitados', 'Ilimitados'],
          },
          {
            feature: 'Conversaciones privadas y proyectos privados',
            availability: [true, true, true],
          },
          { feature: 'Agentes, skills y contexto compartidos', availability: [true, true, true] },
          {
            feature: 'Máquinas del equipo compartidas al habilitarse',
            availability: [true, true, true],
          },
        ],
      },
      {
        title: 'Móvil y remoto',
        rows: [
          { feature: 'Aplicaciones nativas de iOS y Android', availability: [true, true, true] },
          {
            feature: 'Notificaciones push y Live Activities en iOS',
            availability: [true, true, true],
          },
          {
            feature: 'Revisión de diffs y aprobaciones en móvil',
            availability: [true, true, true],
          },
          {
            feature: 'Vista previa adaptable con anotaciones visuales',
            availability: [true, true, true],
          },
          {
            feature: 'Entrada de imágenes y archivos adjuntos',
            availability: [true, true, true],
          },
        ],
      },
      {
        title: 'Entornos de ejecución de agentes',
        rows: [
          {
            feature: 'Claude Code, Codex, OpenCode, Kimi y más de 40 agentes de programación',
            availability: [true, true, true],
          },
          { feature: 'Agentes ACP personalizados', availability: [true, true, true] },
          { feature: 'BYOK con tus propias cuentas de agente', availability: [true, true, true] },
          {
            feature: 'Comandos con barra, modos y opciones de modelo',
            availability: [true, true, true],
          },
        ],
      },
      {
        title: 'GitHub y PRs',
        rows: [
          { feature: 'Contexto de repositorios, issues y PRs', availability: [true, true, true] },
          {
            feature: 'Vinculación automática de PRs y sincronización de CI',
            availability: [true, true, true],
          },
          {
            feature: 'Panel de PR para comentarios, revisiones y fusiones',
            availability: [true, true, true],
          },
          {
            feature: 'Sincronización de comentarios de diff con GitHub Review',
            availability: [true, true, true],
          },
        ],
      },
    ],
    faqs: [
      {
        question: '¿Cobran por los tokens de IA?',
        answer:
          'No. Lody solo cobra por el espacio de trabajo colaborativo. Sigues usando tu propia cuenta de Claude Code, Codex o proveedor de modelos sin recargo alguno.',
      },
      {
        question: '¿Cómo se facturan los nuevos miembros?',
        answer:
          'Las invitaciones son gratuitas. Cuando alguien se une a un espacio Plus, ocupa un puesto pagado disponible sin coste adicional. Si no hay ninguno libre, se añade un puesto nuevo prorrateado por día desde su fecha de ingreso y puede usar Plus de inmediato.',
      },
      {
        question: '¿Cuándo se cobra el cargo adicional?',
        answer:
          'No se cobra al instante. En planes mensuales, la próxima renovación incluye los puestos del mes siguiente más los prorrateos de este mes. En planes anuales, las altas se cobran en el siguiente aniversario mensual de tu suscripción, cubriendo desde el ingreso hasta la renovación anual.',
      },
      {
        question: '¿Qué ocurre cuando un miembro se marcha?',
        answer:
          'La eliminación o salida no reembolsa el periodo actual ni cancela cargos ya generados. El puesto libre puede reutilizarse sin coste adicional hasta la renovación, cuando se ajustará el total de puestos.',
      },
      {
        question: '¿Qué pasa si añadí a alguien por error?',
        answer:
          'Elimina a esa persona y escribe a contact@lody.ai dentro de los 3 días posteriores a la fecha de la factura para solicitar el reembolso del puesto prorrateado.',
      },
      {
        question: '¿Cancelar o eliminar un espacio de trabajo cancela cargos pendientes?',
        answer:
          'No. Los cargos ya generados siguen venciéndose en su fecha original de facturación. Eliminar un espacio no adelanta esa fecha.',
      },
      {
        question: '¿Podemos empezar gratis y actualizar más adelante?',
        answer:
          'Sí. El plan Gratis está pensado para una evaluación real. Actualiza en cuanto los límites de espacios o sesiones se queden cortos: tus datos y sesiones permanecerán intactos.',
      },
      {
        question: '¿Puedo cambiar entre facturación mensual y anual?',
        answer:
          'Sí. Puedes cambiar la frecuencia en cualquier momento. El nuevo periodo comienza de inmediato y Stripe acredita el tiempo no utilizado.',
      },
      {
        question: '¿Cuándo conviene contactarlos?',
        answer:
          'Elige Enterprise si necesitas soporte de compras, revisión de seguridad, términos personalizados o planificación de despliegue para una organización grande. Escríbenos a contact@lody.ai.',
      },
    ],
  },
  fr: {
    kicker: 'Tarifs',
    title: "Réunissez chaque exécution d'agent dans un seul espace d'équipe.",
    lead: "Commencez gratuitement. Passez à l'offre supérieure lorsqu'un nombre illimité de sessions et des opérations d'équipe partagées deviennent votre quotidien.",
    leadEmphasis: 'Commencez gratuitement.',
    leadRest:
      "Passez à l'offre supérieure lorsqu'un nombre illimité de sessions et des opérations d'équipe partagées deviennent votre quotidien.",
    billing: {
      yearly: 'Annuel',
      monthly: 'Mensuel',
      save: '-20 %',
      toggleLabel: 'Basculer entre facturation annuelle et mensuelle',
    },
    plansLabel: 'Offres tarifaires',
    featuresLabel: 'Toutes les fonctionnalités',
    faqLabel: 'Questions fréquentes',
    featuresHeading: 'Tout ce qui est inclus dans chaque offre.',
    featuresLeadPrefix: 'Un espace conçu pour le vrai travail multi-agents :',
    featuresLeadRest:
      'exécutions en parallèle, worktrees isolés, contexte partagé et passation fluide du prompt à la PR.',
    comparisonFeatureLabel: 'Fonctionnalités',
    comparisonColumns: ['Gratuit', 'Plus', 'Enterprise'],
    includedLabel: 'Inclus',
    faqHeading: 'Questions avant de passer au niveau supérieur.',
    faqLead: '',
    finePrint:
      'Prix en USD. La facturation annuelle correspond à un paiement initial de 12 mois par siège.',
    plans: [
      {
        id: 'free',
        name: 'Gratuit',
        eyebrow: 'Découvrir',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: 'Gratuit pour toujours',
        monthlyNote: 'Gratuit pour toujours',
        description: 'Exécutez de vrais agents dans un petit espace de travail. Toujours gratuit.',
        cta: 'Commencer',
        href: localizeSitePath('/download', 'fr'),
        tone: 'calm',
        features: [
          '2 espaces de travail',
          '200 sessions par espace de travail',
          '30 tours par session',
          "Jusqu'à 3 membres d'équipe",
          'Accès mobile',
          '40+ agents pris en charge, BYOK',
          'Gestion multi-appareils',
          { label: 'Plus de fonctionnalités', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: 'Le choix de la plupart des équipes',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ siège / mois',
        yearlyNote: 'Facturé annuellement',
        monthlyNote: 'Facturé mensuellement',
        description:
          'Pour les équipes qui gardent un espace Lody ouvert toute la journée et veulent réduire les ruptures de coordination.',
        featured: true,
        cta: "Mettre à niveau dans l'app web",
        href: '/login',
        tone: 'bright',
        features: [
          'Conversations illimitées',
          'Tours illimités par conversation',
          "Membres d'équipe illimités",
          'Facturation au siège pour les membres acceptés dans cet espace',
          'Chiffrement de bout en bout (bientôt disponible)',
        ],
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        eyebrow: 'Sur mesure',
        yearly: 'Sur mesure',
        monthly: 'Sur mesure',
        prefix: '',
        unit: '',
        yearlyNote: 'Achats et revue de sécurité',
        monthlyNote: 'Achats et revue de sécurité',
        description:
          'Pour les organisations ayant des exigences de contrat, gouvernance et déploiement.',
        cta: 'Nous contacter',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: 'Échanger avec un fondateur', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          'Contrats et facturation sur mesure',
          'Accompagnement sécurité et achats',
          "SSO et contrôles d'accès",
          'Accompagnement au déploiement',
          'Canal de support dédié',
        ],
      },
    ],
    featureSections: [
      {
        title: 'Espace de travail et équipe',
        rows: [
          { feature: 'Espaces de travail', availability: ['2', 'Illimités', 'Illimités'] },
          {
            feature: 'Sessions par espace de travail',
            availability: ["Jusqu'à 200", 'Illimitées', 'Illimitées'],
          },
          {
            feature: 'Tours par session',
            availability: ["Jusqu'à 30", 'Illimités', 'Illimités'],
          },
          {
            feature: "Membres d'équipe",
            availability: ["Jusqu'à 3", 'Illimités', 'Illimités'],
          },
          {
            feature: 'Conversations privées et projets privés',
            availability: [true, true, true],
          },
          { feature: 'Agents, skills et contexte partagés', availability: [true, true, true] },
          { feature: "Machines d'équipe partagées si activées", availability: [true, true, true] },
        ],
      },
      {
        title: 'Mobile et à distance',
        rows: [
          { feature: 'Applications natives iOS et Android', availability: [true, true, true] },
          {
            feature: 'Notifications push et Live Activities iOS',
            availability: [true, true, true],
          },
          { feature: 'Revue de diffs et validations sur mobile', availability: [true, true, true] },
          {
            feature: 'Aperçu adaptatif avec annotations visuelles',
            availability: [true, true, true],
          },
          {
            feature: "Entrée d'images et pièces jointes quelconques",
            availability: [true, true, true],
          },
        ],
      },
      {
        title: "Moteurs d'agents",
        rows: [
          {
            feature: 'Claude Code, Codex, OpenCode, Kimi et 40+ agents de code',
            availability: [true, true, true],
          },
          { feature: 'Agents ACP personnalisés', availability: [true, true, true] },
          { feature: 'BYOK avec vos propres comptes agents', availability: [true, true, true] },
          {
            feature: 'Commandes slash, modes et choix de modèles',
            availability: [true, true, true],
          },
        ],
      },
      {
        title: 'GitHub et PR',
        rows: [
          { feature: 'Contexte dépôt, issue et PR', availability: [true, true, true] },
          { feature: 'Liaison automatique de PR et statut CI', availability: [true, true, true] },
          {
            feature: 'Panneau PR pour commentaires, revues et fusions',
            availability: [true, true, true],
          },
          {
            feature: 'Synchronisation des commentaires diff vers GitHub Review',
            availability: [true, true, true],
          },
        ],
      },
    ],
    faqs: [
      {
        question: 'Facturez-vous les tokens IA ?',
        answer:
          "Non. Lody facture uniquement l'espace de travail collaboratif. Vous continuez d'utiliser votre propre compte Claude Code, Codex ou fournisseur de modèles sans aucune marge.",
      },
      {
        question: 'Comment sont facturés les nouveaux membres ?',
        answer:
          "Les invitations sont gratuites. Lorsqu'une personne rejoint un espace Plus, elle utilise un siège payant vacant sans surcoût. Sinon, un nouveau siège est ajouté et calculé au prorata journalier dès son arrivée. Elle bénéficie immédiatement de Plus.",
      },
      {
        question: 'Quand le supplément est-il prélevé ?',
        answer:
          "Pas immédiatement. En facturation mensuelle, le renouvellement suivant inclut les sièges du mois suivant plus les ajouts au prorata du mois en cours. En facturation annuelle, les ajouts sont facturés à la date anniversaire mensuelle suivante, couvrant la période jusqu'au renouvellement annuel.",
      },
      {
        question: "Que se passe-t-il lorsqu'un membre part ?",
        answer:
          "Le retrait ou le départ ne rembourse pas la période en cours et n'annule pas les frais déjà engagés. Le siège libéré peut être réattribué sans surcoût jusqu'au renouvellement, date à laquelle votre nombre de sièges diminue.",
      },
      {
        question: "Et si j'ai ajouté quelqu'un par erreur ?",
        answer:
          'Retirez la personne, puis écrivez à contact@lody.ai dans les 3 jours suivant la date de facture pour obtenir le remboursement du siège au prorata.',
      },
      {
        question: 'Annuler ou supprimer un espace annule-t-il les frais en attente ?',
        answer:
          "Non. Les frais déjà engagés restent dus à la date de facturation initiale. La suppression d'un espace n'avance pas cette échéance.",
      },
      {
        question: 'Pouvons-nous commencer gratuitement puis évoluer ?',
        answer:
          "Oui. L'offre Gratuite est conçue pour une évaluation en conditions réelles. Passez à Plus dès que les limites deviennent contraignantes : vos données et sessions restent intactes.",
      },
      {
        question: 'Puis-je basculer entre facturation mensuelle et annuelle ?',
        answer:
          'Oui. Vous pouvez changer de rythme de facturation à tout moment. La nouvelle période démarre immédiatement et le temps non utilisé est crédité par Stripe.',
      },
      {
        question: 'Quand faut-il vous contacter ?',
        answer:
          'Choisissez Enterprise si vous avez besoin de support achats, revue sécurité, conditions sur mesure ou déploiement à grande échelle. Écrivez-nous à contact@lody.ai.',
      },
    ],
  },
  ru: {
    kicker: 'Тарифы',
    title: 'Соберите все запуски агентов в одном рабочем пространстве команды.',
    lead: 'Начните бесплатно. Переходите на платный тариф, когда неограниченные сессии и совместная работа станут основой процессов вашей команды.',
    leadEmphasis: 'Начните бесплатно.',
    leadRest:
      'Переходите на платный тариф, когда неограниченные сессии и совместная работа станут основой процессов вашей команды.',
    billing: {
      yearly: 'Ежегодно',
      monthly: 'Ежемесячно',
      save: 'Скидка 20%',
      toggleLabel: 'Переключить годовую или помесячную оплату',
    },
    plansLabel: 'Тарифные планы',
    featuresLabel: 'Все возможности',
    faqLabel: 'Частые вопросы',
    featuresHeading: 'Всё, что входит в каждый тариф.',
    featuresLeadPrefix: 'Рабочее пространство для реальной мультиагентной разработки:',
    featuresLeadRest:
      'параллельные запуски, изолированные worktree, общий контекст и понятная передача задачи от промпта до PR.',
    comparisonFeatureLabel: 'Возможности',
    comparisonColumns: ['Free', 'Plus', 'Enterprise'],
    includedLabel: 'Включено',
    faqHeading: 'Вопросы перед обновлением тарифа.',
    faqLead: '',
    finePrint:
      'Цены указаны в USD. При годовой оплате взимается предоплата за 12 месяцев за каждое место.',
    plans: [
      {
        id: 'free',
        name: 'Free',
        eyebrow: 'Попробовать',
        yearly: '0',
        monthly: '0',
        prefix: '$',
        unit: '',
        yearlyNote: 'Бесплатно навсегда',
        monthlyNote: 'Бесплатно навсегда',
        description:
          'Запускайте реальных агентов в небольшом рабочем пространстве. Всегда бесплатно.',
        cta: 'Начать',
        href: localizeSitePath('/download', 'ru'),
        tone: 'calm',
        features: [
          '2 рабочих пространства',
          '200 сессий на рабочее пространство',
          '30 ходов в сессии',
          'До 3 участников команды',
          'Доступ с мобильных устройств',
          '40+ агентов, BYOK',
          'Управление несколькими устройствами',
          { label: 'Все возможности', href: '#included-features' },
        ],
      },
      {
        id: 'plus',
        name: 'Plus',
        eyebrow: 'Выбор большинства команд',
        yearly: REGULAR_PLUS_YEARLY,
        monthly: REGULAR_PLUS_MONTHLY,
        prefix: '$',
        unit: '/ место / мес',
        yearlyNote: 'Оплата раз в год',
        monthlyNote: 'Оплата раз в месяц',
        description:
          'Для команд, которые весь день работают в общем пространстве Lody и хотят меньше разрывов в коммуникации.',
        featured: true,
        cta: 'Обновить в веб-приложении',
        href: '/login',
        tone: 'bright',
        features: [
          'Неограниченное число диалогов',
          'Неограниченное число ходов в диалоге',
          'Неограниченное число участников команды',
          'Оплата только за принявших приглашение участников пространства',
          'Сквозное шифрование (скоро)',
        ],
      },
      {
        id: 'enterprise',
        name: 'Enterprise',
        eyebrow: 'Индивидуально',
        yearly: 'По запросу',
        monthly: 'По запросу',
        prefix: '',
        unit: '',
        yearlyNote: 'Закупки и проверка безопасности',
        monthlyNote: 'Закупки и проверка безопасности',
        description:
          'Для организаций с требованиями к договорам, управлению доступом и развёртыванию.',
        cta: 'Связаться с нами',
        href: 'mailto:sales@lody.ai',
        secondaryCta: { label: 'Созвониться с основателем', href: founderCallUrl('pricing') },
        tone: 'deep',
        features: [
          'Индивидуальные договоры и счета',
          'Поддержка закупок и аудита безопасности',
          'SSO и разграничение доступа',
          'Сопровождение развёртывания и внедрения',
          'Выделенный канал поддержки',
        ],
      },
    ],
    featureSections: [
      {
        title: 'Рабочее пространство и команда',
        rows: [
          {
            feature: 'Рабочие пространства',
            availability: ['2', 'Без ограничений', 'Без ограничений'],
          },
          {
            feature: 'Сессий на рабочее пространство',
            availability: ['До 200', 'Без ограничений', 'Без ограничений'],
          },
          {
            feature: 'Ходов в сессии',
            availability: ['До 30', 'Без ограничений', 'Без ограничений'],
          },
          {
            feature: 'Участники команды',
            availability: ['До 3', 'Без ограничений', 'Без ограничений'],
          },
          {
            feature: 'Приватные диалоги и приватные проекты',
            availability: [true, true, true],
          },
          { feature: 'Общие агенты, навыки и контекст', availability: [true, true, true] },
          { feature: 'Общие командные машины при включении', availability: [true, true, true] },
        ],
      },
      {
        title: 'Мобильный и удалённый доступ',
        rows: [
          { feature: 'Нативные приложения для iOS и Android', availability: [true, true, true] },
          {
            feature: 'Push-уведомления и iOS Live Activities',
            availability: [true, true, true],
          },
          {
            feature: 'Просмотр diff и подтверждения на телефоне',
            availability: [true, true, true],
          },
          {
            feature: 'Адаптивный предпросмотр с визуальными заметками',
            availability: [true, true, true],
          },
          {
            feature: 'Отправка изображений и любых файловых вложений',
            availability: [true, true, true],
          },
        ],
      },
      {
        title: 'Среды запуска агентов',
        rows: [
          {
            feature: 'Claude Code, Codex, OpenCode, Kimi и ещё 40+ агентов',
            availability: [true, true, true],
          },
          { feature: 'Пользовательские ACP-агенты', availability: [true, true, true] },
          { feature: 'BYOK со своими учётными записями агентов', availability: [true, true, true] },
          { feature: 'Слеш-команды, режимы и выбор моделей', availability: [true, true, true] },
        ],
      },
      {
        title: 'GitHub и PR',
        rows: [
          { feature: 'Контекст репозиториев, issue и PR', availability: [true, true, true] },
          {
            feature: 'Автопривязка PR и синхронизация статусов CI',
            availability: [true, true, true],
          },
          {
            feature: 'Панель PR для комментариев, ревью и слияний',
            availability: [true, true, true],
          },
          {
            feature: 'Синхронизация комментариев к diff с GitHub Review',
            availability: [true, true, true],
          },
        ],
      },
    ],
    faqs: [
      {
        question: 'Взимаете ли вы плату за токены ИИ?',
        answer:
          'Нет. Lody берёт плату только за совместное рабочее пространство. Вы продолжаете использовать свои учётные записи Claude Code, Codex или провайдера моделей без какой-либо наценки.',
      },
      {
        question: 'Как тарифицируются новые участники?',
        answer:
          'Приглашения бесплатны. Когда новый участник присоединяется к пространству Plus, он занимает свободное оплаченное место без доплат. Если свободных мест нет, добавляется новое место с подневным перерасчётом со дня присоединения, и доступ к Plus открывается сразу.',
      },
      {
        question: 'Когда списывается дополнительная плата?',
        answer:
          'Не сразу. На помесячном тарифе следующее продление включает места на следующий месяц и пропорциональные доплаты за текущий. На годовом тарифе доплаты списываются в следующую ежемесячную дату подписки за период от присоединения до годового продления.',
      },
      {
        question: 'Что происходит, если участник покидает команду?',
        answer:
          'Удаление или выход участника не возвращает оплату за текущий период и не отменяет уже начисленные суммы. Освободившееся место можно передать другому участнику без доплат до продления, когда число мест уменьшится.',
      },
      {
        question: 'Что делать, если участника добавили по ошибке?',
        answer:
          'Удалите участника и напишите на contact@lody.ai в течение 3 дней с даты счёта — мы вернём пропорциональную стоимость этого места.',
      },
      {
        question: 'Отменяет ли удаление рабочего пространства уже начисленные платежи?',
        answer:
          'Нет. Уже начисленные суммы подлежат оплате в исходную дату списания. Удаление рабочего пространства не переносит эту дату на более ранний срок.',
      },
      {
        question: 'Можно ли начать бесплатно и обновиться позже?',
        answer:
          'Да. Тариф Free рассчитан на полноценную проверку в работе. Обновляйтесь, как только упрётесь в лимиты пространств или сессий — все ваши данные и диалоги сохранятся.',
      },
      {
        question: 'Можно ли переключаться между помесячной и годовой оплатой?',
        answer:
          'Да. Период оплаты можно сменить в любой момент. Новый период начинается сразу, а неиспользованный остаток засчитывается через Stripe.',
      },
      {
        question: 'Когда стоит связаться с нами?',
        answer:
          'Выбирайте Enterprise, если вам нужны сопровождение закупок, аудит безопасности, индивидуальные условия или план внедрения для крупной организации. Напишите нам на contact@lody.ai.',
      },
    ],
  },
};
