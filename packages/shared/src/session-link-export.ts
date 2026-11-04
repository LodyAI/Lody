import { fromMarkdown } from 'mdast-util-from-markdown';
import { buildSessionLink, parseSessionLink, SESSION_LINK_SCHEMES } from './session-link';

const schemePattern = [...SESSION_LINK_SCHEMES, 'session']
  .map((scheme) => scheme.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
  .join('|');
const sessionScheme = new RegExp(`(?:${schemePattern}):\\/\\/`, 'u');
const sessionUri = new RegExp(
  `(?:${schemePattern}):\\/\\/[^\\s<>()[\\]\\x60"'*,;。，；：！？]+`,
  'gu'
);

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

/** Preserve original Markdown bytes outside resource URIs, including nested code examples. */
export function normalizeSessionLinksForExport(markdown: string, workspaceId?: string): string {
  if (!sessionScheme.test(markdown)) return markdown;
  const opaque: { start: number; end: number }[] = [];
  const textRanges: { start: number; end: number }[] = [];
  const visit = (node: MarkdownNode): void => {
    if (
      node.type === 'text' &&
      node.position?.start.offset !== undefined &&
      node.position.end.offset !== undefined
    ) {
      textRanges.push({ start: node.position.start.offset, end: node.position.end.offset });
    }
    if (['code', 'inlineCode', 'html', 'image'].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) opaque.push({ start, end });
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  let rangeIndex = 0;
  let textIndex = 0;
  return markdown.replace(sessionUri, (raw, offset: number) => {
    while (opaque[rangeIndex] && opaque[rangeIndex]!.end <= offset) rangeIndex += 1;
    const protectedRange = opaque[rangeIndex];
    if (protectedRange && protectedRange.start < offset + raw.length) return raw;
    // A URI embedded in another URL (e.g. ?next=session://...) is not a resource link.
    while (textRanges[textIndex] && textRanges[textIndex]!.end <= offset) textIndex += 1;
    const textRange = textRanges[textIndex];
    const inText = textRange && textRange.start <= offset;
    if (
      offset > 0 &&
      !(inText && textRange.start === offset) &&
      !/[\s(<*]/u.test(markdown[offset - 1]!)
    )
      return raw;
    // Markdown emphasis is excluded by the token regex; sentence punctuation
    // is not part of our restricted identifier/query alphabet.
    const token = inText ? raw.slice(0, textRange.end - offset) : raw;
    const uri = token.replace(/[.,;:!?。，；：！？]+$/u, '');
    const link = parseSessionLink(uri);
    return link
      ? buildSessionLink({ ...link, workspaceId: link.workspaceId ?? workspaceId }) +
          raw.slice(uri.length)
      : raw;
  });
}
