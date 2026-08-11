'use client';

/**
 * Public pricing page (`/price`, `/zh/price`).
 *
 * Content and structure were ported from the retired VitePress site. Styles
 * live in `app/pricing.css`.
 *
 * Early-bird yearly Plus ($5/seat/mo = $60/yr) is the fixed public presentation
 * with regular $8 (and monthly $10) as strike-through reference only. Do not
 * gate on `Date.now()` or env end dates — that caused an $8→$5 flash on paint.
 */

import NumberFlow from '@number-flow/react';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';

import { founderCallUrl } from '@site/lib/founder-call';

import { LandingEffects } from './landing-interactions';
import { SiteFooter } from './site-footer';
import { SiteNav } from './site-nav';

/** Spring-ish easing matched to pricing card motion tokens. */
const PRICE_NUMBER_TIMING = {
  duration: 520,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
} as const;

const PRICE_OPACITY_TIMING = {
  duration: 280,
  easing: 'ease-out',
} as const;

export type PricingLocale = 'en' | 'zh';

type BillingCycle = 'yearly' | 'monthly';
type PlanId = 'free' | 'plus' | 'enterprise';
type PlanTone = 'calm' | 'bright' | 'deep';

type PlanFeature = string | { label: string; href: string };

type PricingPlan = {
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

type FeatureAvailability = boolean | string;

type FeatureSection = {
  title: string;
  rows: readonly {
    feature: string;
    availability: readonly FeatureAvailability[];
  }[];
};

type PricingCopy = {
  kicker: string;
  title: string;
  lead: string;
  leadEmphasis: string;
  leadRest: string;
  billing: {
    yearly: string;
    monthly: string;
    save: string;
    earlyBirdSave: string;
    promoLabel: string;
    promoDiscount: string;
    earlyBirdYearlyNote: string;
    regularYearlyPrice: string;
    monthlyPrice: string;
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

/** Regular Plus list prices — strike-through only when early-bird yearly is shown. */
const REGULAR_PLUS_YEARLY = '8';
const REGULAR_PLUS_MONTHLY = '10';
const EARLY_BIRD_PLUS_YEARLY = '5';

const copy = {
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
      earlyBirdSave: '$60/year',
      promoLabel: 'Early-bird offer',
      promoDiscount: '$60/year · locked forever',
      earlyBirdYearlyNote:
        'Pay yearly now to lock $60 per seat per year for this workspace forever.',
      regularYearlyPrice: 'Regular yearly price',
      monthlyPrice: 'Monthly price',
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
        href: '/download',
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
        question: 'What counts as a paid seat?',
        answer:
          'Plus is billed per accepted member inside the upgraded workspace. Pending invitations are not billed until they are accepted.',
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
      earlyBirdSave: '$60/年',
      promoLabel: '早鸟活动',
      promoDiscount: '$60/年 · 永久锁定',
      earlyBirdYearlyNote: '现在选择年付，即可为当前 workspace 永久锁定每席位每年 $60。',
      regularYearlyPrice: '常规年付价格',
      monthlyPrice: '月付价格',
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
        href: '/zh/download',
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
        question: '什么会被计为一个付费 seat？',
        answer:
          'Plus 按升级 workspace 内已接受的成员计费。Pending invitation 不计费，接受邀请后才计入 seat。',
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
} satisfies Record<PricingLocale, PricingCopy>;

export function PricingPage({ locale }: { locale: PricingLocale }) {
  const page = copy[locale];
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('yearly');
  const isYearly = billingCycle === 'yearly';
  // Permanent early-bird presentation (no client clock / env gate).
  const earlyBirdYearlyActive = true;

  const standardPlusPlan = useMemo(() => {
    const plus = page.plans.find((plan) => plan.id === 'plus');
    if (!plus) return null;
    return {
      ...plus,
      yearly: REGULAR_PLUS_YEARLY,
      monthly: REGULAR_PLUS_MONTHLY,
    };
  }, [page.plans]);

  const plans = useMemo(
    () =>
      page.plans.map((plan) =>
        earlyBirdYearlyActive && plan.id === 'plus'
          ? {
              ...plan,
              yearly: EARLY_BIRD_PLUS_YEARLY,
              yearlyNote: page.billing.earlyBirdYearlyNote,
            }
          : plan
      ),
    [earlyBirdYearlyActive, page.billing.earlyBirdYearlyNote, page.plans]
  );

  return (
    <div className="landing-page-root marketing-shell">
      <LandingEffects />
      <SiteNav locale={locale} languageHref={locale === 'zh' ? '/price' : '/zh/price'} />
      <main className="landing pricing-page" data-billing={billingCycle}>
        <div aria-hidden="true" className="pricing-ambient">
          <span className="pricing-ambient-orb pricing-ambient-orb-1" />
          <span className="pricing-ambient-orb pricing-ambient-orb-2" />
          <span className="pricing-ambient-orb pricing-ambient-orb-3" />
          <span className="pricing-ambient-grid" />
        </div>

        <section className="pricing-hero">
          <h1 className="pricing-hero-title reveal delay-1">{page.title}</h1>
          <p className="pricing-hero-lead reveal delay-2">
            <span className="pricing-hero-lead-emphasis">{page.leadEmphasis}</span>{' '}
            <span className="pricing-hero-lead-rest">{page.leadRest}</span>
          </p>
        </section>

        <section aria-label={page.plansLabel} className="pricing-plans">
          <div className="pricing-toolbar scroll-reveal">
            <div
              className="pricing-toolbar-shell"
              role="group"
              aria-label={page.billing.toggleLabel}
            >
              <div aria-hidden="true" className="pricing-toolbar-track">
                <span className="pricing-toolbar-thumb" />
              </div>
              <button
                aria-pressed={!isYearly}
                className={`pricing-toolbar-option${!isYearly ? ' is-active' : ''}`}
                onClick={() => setBillingCycle('monthly')}
                type="button"
              >
                {page.billing.monthly}
              </button>
              <button
                aria-pressed={isYearly}
                className={`pricing-toolbar-option${isYearly ? ' is-active' : ''}`}
                onClick={() => setBillingCycle('yearly')}
                type="button"
              >
                {page.billing.yearly}
                <span className="pricing-toolbar-tag">
                  {earlyBirdYearlyActive ? page.billing.earlyBirdSave : page.billing.save}
                </span>
              </button>
            </div>
          </div>

          <div className="pricing-grid">
            {plans.map((plan, index) => (
              <PricingCard
                earlyBirdYearlyActive={earlyBirdYearlyActive}
                isYearly={isYearly}
                key={plan.id}
                monthlyPriceLabel={page.billing.monthlyPrice}
                plan={plan}
                promoDiscount={page.billing.promoDiscount}
                promoLabel={page.billing.promoLabel}
                regularYearlyPriceLabel={page.billing.regularYearlyPrice}
                standardPlusPlan={standardPlusPlan}
                style={{ '--card-index': String(index) } as CSSProperties}
              />
            ))}
          </div>

          <p className="pricing-fineprint">{page.finePrint}</p>
        </section>

        <section
          aria-label={page.featuresLabel}
          className="pricing-included"
          id="included-features"
        >
          <div className="pricing-section-heading scroll-reveal">
            <h2>{page.featuresHeading}</h2>
            <p>
              <span className="pricing-section-lead-prefix">{page.featuresLeadPrefix}</span>{' '}
              <span className="pricing-section-lead-rest">{page.featuresLeadRest}</span>
            </p>
          </div>

          <div className="pricing-feature-table-wrap scroll-reveal">
            <div className="pricing-feature-table" role="table" aria-label={page.featuresLabel}>
              <div className="pricing-feature-table-head" role="row">
                <div
                  className="pricing-feature-table-cell pricing-feature-name"
                  role="columnheader"
                >
                  {page.comparisonFeatureLabel}
                </div>
                {page.comparisonColumns.map((column) => (
                  <div
                    className="pricing-feature-table-cell pricing-feature-plan"
                    key={column}
                    role="columnheader"
                  >
                    {column}
                  </div>
                ))}
              </div>

              {page.featureSections.map((section) => (
                <FeatureSectionBlock key={section.title} section={section} />
              ))}
            </div>
          </div>
        </section>

        <section aria-label={page.faqLabel} className="pricing-faq">
          {/* No scroll-reveal on FAQ items: IO opacity toggles felt like collapse. */}
          <div className="pricing-section-heading">
            <h2>{page.faqHeading}</h2>
            {page.faqLead ? <p>{page.faqLead}</p> : null}
          </div>

          <div className="pricing-faq-list">
            {page.faqs.map((faq, index) => (
              <details className="pricing-faq-item" key={faq.question} open={index === 0}>
                <summary>
                  <span className="pricing-faq-question">{faq.question}</span>
                  <span aria-hidden="true" className="pricing-faq-marker">
                    <span />
                    <span />
                  </span>
                </summary>
                <div className="pricing-faq-answer">
                  <p>{faq.answer}</p>
                </div>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter locale={locale} />
    </div>
  );
}

function FeatureSectionBlock({ section }: { section: FeatureSection }) {
  return (
    <>
      <div className="pricing-feature-section-row" role="row">
        <div className="pricing-feature-section-title" role="cell">
          {section.title}
        </div>
      </div>
      {section.rows.map((row) => (
        <div className="pricing-feature-row" key={row.feature} role="row">
          <div className="pricing-feature-table-cell pricing-feature-name" role="cell">
            {row.feature}
          </div>
          {row.availability.map((value, index) => (
            <div
              className="pricing-feature-table-cell pricing-feature-value"
              key={`${row.feature}-${index}`}
              role="cell"
            >
              {value === true ? (
                <span className="pricing-feature-check" aria-label="Included">
                  <CheckIcon />
                </span>
              ) : (
                <span className="pricing-feature-value-text">{value as ReactNode}</span>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function PricingCard({
  earlyBirdYearlyActive,
  isYearly,
  plan,
  promoDiscount,
  promoLabel,
  regularYearlyPriceLabel,
  monthlyPriceLabel,
  standardPlusPlan,
  style,
}: {
  earlyBirdYearlyActive: boolean;
  isYearly: boolean;
  plan: PricingPlan;
  promoDiscount: string;
  promoLabel: string;
  regularYearlyPriceLabel: string;
  monthlyPriceLabel: string;
  standardPlusPlan: PricingPlan | null;
  style: CSSProperties;
}) {
  const currentPrice = isYearly ? plan.yearly : plan.monthly;
  const note = isYearly ? plan.yearlyNote : plan.monthlyNote;
  const numericPrice =
    isNumeric(plan.yearly) && isNumeric(plan.monthly) ? Number(currentPrice) : null;
  const isMailto = plan.href.startsWith('mailto:');
  const showPromoBanner = plan.id === 'plus' && earlyBirdYearlyActive && isYearly;
  const showPromoReference =
    plan.id === 'plus' && earlyBirdYearlyActive && isYearly && standardPlusPlan !== null;

  return (
    <article
      className={[
        'pricing-card',
        `pricing-card-${plan.tone}`,
        plan.featured ? 'pricing-card-featured' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-billing={isYearly ? 'yearly' : 'monthly'}
      style={style}
    >
      <span aria-hidden="true" className="pricing-card-glow" />

      <header className="pricing-card-head">
        <span
          className={`pricing-plan-eyebrow${plan.featured ? '' : ' is-placeholder'}`}
          aria-hidden={plan.featured ? undefined : true}
        >
          {plan.featured ? plan.eyebrow : ''}
        </span>
        <h2 className="pricing-plan-name">{plan.name}</h2>
        <p className="pricing-plan-desc">{plan.description}</p>
      </header>

      {plan.id === 'plus' && earlyBirdYearlyActive ? (
        <div
          className={`pricing-promo-slot${showPromoBanner ? ' is-open' : ''}`}
          aria-hidden={!showPromoBanner}
        >
          <div className="pricing-promo-slot-inner">
            <div className="pricing-promo-banner">
              <span>{promoLabel}</span>
              <strong>{promoDiscount}</strong>
            </div>
          </div>
        </div>
      ) : null}

      <div className="pricing-price-row">
        {plan.prefix ? <span className="pricing-price-prefix">{plan.prefix}</span> : null}
        {numericPrice !== null ? (
          <NumberFlow
            aria-label={`${currentPrice}${plan.unit}`}
            className="pricing-price-value"
            format={{ useGrouping: false }}
            opacityTiming={PRICE_OPACITY_TIMING}
            spinTiming={PRICE_NUMBER_TIMING}
            transformTiming={PRICE_NUMBER_TIMING}
            value={numericPrice}
            willChange
          />
        ) : (
          <span className="pricing-price-custom">{currentPrice}</span>
        )}
        {plan.id === 'plus' && standardPlusPlan ? (
          <span
            className={`pricing-price-reference-slot${showPromoReference ? ' is-open' : ''}`}
            aria-hidden={!showPromoReference}
          >
            <span
              className="pricing-price-reference"
              aria-label={
                showPromoReference
                  ? `${regularYearlyPriceLabel} ${standardPlusPlan.prefix}${standardPlusPlan.yearly}; ${monthlyPriceLabel} ${standardPlusPlan.prefix}${standardPlusPlan.monthly}`
                  : undefined
              }
            >
              <s aria-hidden="true">
                {standardPlusPlan.prefix}
                {standardPlusPlan.yearly}
              </s>
              <s aria-hidden="true">
                {standardPlusPlan.prefix}
                {standardPlusPlan.monthly}
              </s>
            </span>
          </span>
        ) : null}
        {plan.unit ? <span className="pricing-price-unit">{plan.unit}</span> : null}
      </div>

      <p className="pricing-price-note">
        <span className="pricing-price-note-text" key={note}>
          {note}
        </span>
      </p>

      <a
        className={`pricing-card-cta${plan.featured ? ' pricing-card-cta-primary' : ''}`}
        href={plan.href}
        rel={isMailto ? 'noopener' : undefined}
        target={isMailto ? '_blank' : '_self'}
      >
        <span>{plan.cta}</span>
        <ArrowIcon />
      </a>

      {plan.secondaryCta ? (
        <a
          className="pricing-card-secondary-cta"
          href={plan.secondaryCta.href}
          rel="noreferrer"
          target="_blank"
        >
          {plan.secondaryCta.label}
        </a>
      ) : null}

      <ul className="pricing-card-features">
        {plan.features.map((feature) => {
          const key = typeof feature === 'string' ? feature : feature.label;
          return (
            <li key={key}>
              <CheckIcon className="pricing-card-check" />
              {typeof feature === 'string' ? (
                <span>{feature}</span>
              ) : (
                <a className="pricing-card-feature-link" href={feature.href}>
                  {feature.label}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 16 16">
      <path
        d="M3.5 8.5l3 3 6-7"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" className="pricing-card-cta-arrow" fill="none" viewBox="0 0 16 16">
      <path
        d="M3 8h10M9 4l4 4-4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.75"
      />
    </svg>
  );
}

function isNumeric(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

export default PricingPage;
