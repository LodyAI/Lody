/**
 * Docs FAQ lookup. Visible copy stays in the MDX `## FAQ` / `## 常见问题`
 * section; `scripts/generate-docs-faq.mjs` extracts it.
 */

import { docsFaqByPath } from './docs-faq.generated';
import type { FaqItem } from './json-ld';

export type { FaqItem } from './json-ld';
export { faqJsonLd } from './json-ld';

export function docsFaqForPath(sitePath: string): readonly FaqItem[] {
  return docsFaqByPath[sitePath] ?? [];
}
