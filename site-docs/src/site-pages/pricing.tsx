import { PricingPage } from '@site/components/pricing-page';
import { brandTitle, pageHead } from '@site/lib/metadata';
import type { SiteHead } from '@site/lib/metadata';
import { buildLocaleAlternates, localeCode, localizeSitePath, type SiteLocale } from './shared';

const pricingCopy: Record<SiteLocale, { title: string; description: string }> = {
  en: {
    title: 'Pricing — Free, Plus & Enterprise Team Plans',
    description:
      'Compare Lody Free, Plus ($8/seat/mo billed yearly), and Enterprise plans for parallel AI coding agents, unlimited team sessions, and bring-your-own subscriptions.',
  },
  zh: {
    title: '价格方案 — 免费版、Plus 团队版与企业版',
    description:
      '对比 Lody 免费版、Plus（年付 $8/席位/月）与企业版价格方案：支持自带 Claude Code / Codex 订阅、无限团队协作会话与多设备实时同步。',
  },
  'zh-hant': {
    title: '定價方案 — 免費版、Plus 團隊版與企業版',
    description:
      '比較 Lody 免費版、Plus（年繳 $8/席次/月）與企業版方案：支援沿用既有 Claude Code / Codex 訂閱、無限團隊工作階段與跨裝置協作。',
  },
  ja: {
    title: '料金プラン — Free・Plus・Enterprise 比較',
    description:
      'Lody の Free・Plus（年額 $8/シート/月）・Enterprise プランを比較。既存の Claude Code や Codex サブスクリプションを活用し、チームでの AI コーディングエージェント並列実行に対応。',
  },
  ko: {
    title: '요금제 — Free·Plus·Enterprise 플랜 비교',
    description:
      'Lody Free, Plus(연간 결제 시 좌석당 월 $8), Enterprise 요금제를 비교해 보세요. 기존 Claude Code·Codex 구독 연동과 무제한 팀 세션을 지원합니다.',
  },
  es: {
    title: 'Precios — Planes Free, Plus y Enterprise',
    description:
      'Compara los planes Free, Plus ($8/usuario/mes anual) y Enterprise de Lody para ejecutar agentes de código IA en equipo con tus suscripciones existentes.',
  },
  fr: {
    title: 'Tarifs — Forfaits Free, Plus et Enterprise',
    description:
      'Comparez les forfaits Free, Plus (8 $/utilisateur/mois facturé annuellement) et Enterprise de Lody pour exécuter vos agents de code IA en équipe.',
  },
  ru: {
    title: 'Тарифы — Free, Plus и Enterprise для команд',
    description:
      'Сравните тарифы Lody Free, Plus ($8/место/мес при оплате за год) и Enterprise для командной работы с ИИ-агентами разработки и своими подписками.',
  },
};

const pricingAlternates = buildLocaleAlternates('/price');

export function pricingHead(locale: SiteLocale): SiteHead {
  const copy = pricingCopy[locale];
  return pageHead({
    title: brandTitle(copy.title),
    description: copy.description,
    path: localizeSitePath('/price', locale),
    locale: localeCode(locale),
    alternates: pricingAlternates,
  });
}

export function PricingRoutePage({ locale }: { locale: SiteLocale }) {
  return <PricingPage locale={locale} />;
}
