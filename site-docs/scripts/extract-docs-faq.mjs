/** Shared MDX FAQ extractor for generate-docs-faq and tests. */

const FAQ_SECTION = /(?:^|\n)## (?:FAQ|常见问题)\s*\n/u;

export function faqPlainText(value) {
  return value
    .replace(/<Callout\b[^>]*>\s*/gu, '')
    .replace(/\s*<\/Callout>/gu, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/\*([^*]+)\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\r\n/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Read `###` questions under `## FAQ` / `## 常见问题` until the next `##`.
 * Pages without that heading return an empty list.
 */
export function extractFaqFromMdx(source) {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, '');
  const heading = FAQ_SECTION.exec(body);
  if (!heading || heading.index === undefined) return [];

  const afterHeading = body.slice(heading.index + heading[0].length);
  const nextSection = afterHeading.search(/\n##\s/u);
  const section = nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection);
  const items = [];

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
