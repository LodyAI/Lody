import { getUrlReferenceKind } from '@lody/shared';
import type { Mention } from '@/ui/mention/index';

export const MAX_REFERENCE_PASTE_LENGTH = 16_384;

function trimUrlPunctuation(value: string): string {
  let url = value.replace(/[.,;!]+$/, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ]) {
    while (url.endsWith(close) && url.split(close).length > url.split(open).length) {
      url = url.slice(0, -1);
    }
  }
  return url;
}

export function findPastedUrlReferences(text: string, offset = 0): Mention[] {
  if (text.length > MAX_REFERENCE_PASTE_LENGTH) return [];
  const references: Mention[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    const raw = trimUrlPunctuation(match[0]);
    const kind = getUrlReferenceKind(raw);
    if (!kind) continue;
    references.push({
      start: offset + match.index,
      end: offset + match.index + raw.length,
      value: raw,
      kind,
    });
  }
  return references;
}
