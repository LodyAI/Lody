/**
 * FAQPage JSON-LD helpers for docs. Content stays in the MDX `## FAQ` /
 * `## 常见问题` section; this module only extracts and shapes it.
 */

export type FaqItem = {
  question: string;
  answer: string;
};

const FAQ_SECTION = /(?:^|\n)## (?:FAQ|常见问题)\s*\n/u;

/** Strip MDX emphasis/links so FAQPage text matches the visible prose. */
export function faqPlainText(value: string): string {
  return value
    .replace(/<Callout\b[^>]*>\s*/gu, '')
    .replace(/\s*<\/Callout>/gu, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Read `###` questions under the FAQ heading until the next `##` section.
 * Pages without that heading return an empty list.
 */
export function extractFaqFromMdx(source: string): FaqItem[] {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
  const heading = FAQ_SECTION.exec(body);
  if (!heading || heading.index === undefined) return [];

  const afterHeading = body.slice(heading.index + heading[0].length);
  const nextSection = afterHeading.search(/\n##\s/u);
  const section = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
  const items: FaqItem[] = [];

  for (const part of section.split(/^### /mu).slice(1)) {
    const newline = part.indexOf('\n');
    const question = (newline === -1 ? part : part.slice(0, newline)).trim();
    const answer = faqPlainText(newline === -1 ? '' : part.slice(newline + 1));
    if (question.length > 0 && answer.length > 0) {
      items.push({ question, answer });
    }
  }

  return items;
}

export function faqJsonLd(items: readonly FaqItem[]): Record<string, unknown> | undefined {
  if (items.length === 0) return undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}
