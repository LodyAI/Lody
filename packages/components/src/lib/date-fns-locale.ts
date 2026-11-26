import type { Locale } from 'date-fns';
import { enUS } from 'date-fns/locale/en-US';
import { es } from 'date-fns/locale/es';
import { fr } from 'date-fns/locale/fr';
import { ja } from 'date-fns/locale/ja';
import { ko } from 'date-fns/locale/ko';
import { ru } from 'date-fns/locale/ru';
import { zhCN } from 'date-fns/locale/zh-CN';
import { zhTW } from 'date-fns/locale/zh-TW';
import { normalizeSupportedLanguage, type SupportedLanguage } from '@lody/shared/language';

const DATE_FNS_LOCALE_BY_LANGUAGE: Record<SupportedLanguage, Locale> = {
  en: enUS,
  zh_CN: zhCN,
  zh_Hant: zhTW,
  ja,
  ko,
  es,
  fr,
  ru,
};

/** Resolve a product language / BCP-47 tag onto its deep-imported date-fns locale. */
export function getDateFnsLocale(language: string | null | undefined): Locale {
  const normalized = normalizeSupportedLanguage(language) ?? 'en';
  return DATE_FNS_LOCALE_BY_LANGUAGE[normalized];
}
