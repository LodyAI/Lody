/**
 * Docs FAQ lookup across all supported locales. Visible copy stays in each
 * page's localized MDX FAQ section; `scripts/generate-docs-faq.mjs` extracts it.
 */

import { docsFaqByPath } from './docs-faq.generated';
import type { FaqItem } from './json-ld';

export type { FaqItem } from './json-ld';
export { faqJsonLd } from './json-ld';

export function docsFaqForPath(sitePath: string): readonly FaqItem[] {
  const normalized = sitePath.length > 1 ? sitePath.replace(/\/+$/u, '') : sitePath;
  return docsFaqByPath[normalized] ?? [];
}
