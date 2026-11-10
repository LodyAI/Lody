import { expect, type Locator } from '@playwright/test';

/**
 * The composer's text, read in the page from either composer element: the
 * mention editor (one paragraph of text, line breaks and chips) or the plain
 * textarea a composer without mention sources renders.
 */
export function composerText(composer: Locator): Promise<string> {
  return composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement) return element.value;
    let text = '';
    element.querySelectorAll(':scope > p').forEach((paragraph, index) => {
      if (index > 0) text += '\n';
      paragraph.childNodes.forEach((node) => {
        if (node instanceof HTMLBRElement) {
          if (!node.hasAttribute('data-lexical-managed-linebreak')) text += '\n';
        } else {
          text += node.textContent ?? '';
        }
      });
    });
    return text;
  });
}

/** `toHaveValue` for a composer, retried like any web-first assertion. */
export async function expectComposerText(composer: Locator, expected: string | RegExp) {
  const poll = expect.poll(() => composerText(composer));
  if (typeof expected === 'string') await poll.toBe(expected);
  else await poll.toMatch(expected);
}

/** The composer element on a page: the mention editor or its plain textarea. */
export const COMPOSER_INPUT = '[data-lody-composer-input]';
