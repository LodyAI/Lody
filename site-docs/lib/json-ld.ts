/** JSON-LD builders reused by route `head()` functions. */

export type FaqItem = {
  question: string;
  answer: string;
};

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
