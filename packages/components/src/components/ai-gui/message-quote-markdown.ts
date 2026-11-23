import { fromDom } from 'hast-util-from-dom';
import { toMdast } from 'hast-util-to-mdast';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const quoteText = '[data-message-quote-text]';
const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

const INLINE_CONTAINER_TYPES = new Set([
  'paragraph',
  'heading',
  'strong',
  'emphasis',
  'delete',
  'link',
  'linkReference',
  'tableCell',
]);

type MdastNode = {
  type: string;
  value?: string;
  alt?: string | null;
  children?: MdastNode[];
};

function extractPlainText(node: MdastNode): string {
  if (
    node.type === 'text' ||
    node.type === 'inlineCode' ||
    node.type === 'code' ||
    node.type === 'inlineMath' ||
    node.type === 'math'
  ) {
    return node.value ?? '';
  }
  if (node.type === 'image') return node.alt ?? '';
  if (node.type === 'break') return ' ';
  if (node.type === 'thematicBreak' || node.type === 'html') return '';
  if (!node.children?.length) return '';
  const separator = INLINE_CONTAINER_TYPES.has(node.type) ? '' : ' ';
  return node.children.map(extractPlainText).filter(Boolean).join(separator);
}

function graphemeLength(text: string): number {
  let count = 0;
  for (const _ of GRAPHEME_SEGMENTER.segment(text)) count += 1;
  return count;
}

/** Format a quoted Markdown snapshot into a plain-text chip excerpt without cutting words. */
export function formatMessageQuoteExcerpt(markdown: string, maxLength = 32): string {
  const tree = markdownParser.parse(markdown) as MdastNode;
  const plain = extractPlainText(tree).replace(/\s+/g, ' ').trim();
  const text = plain || markdown.replace(/\s+/g, ' ').trim();
  if (!text || graphemeLength(text) <= maxLength) return text;

  const budget = Math.max(1, maxLength - 3);
  let fitted = '';
  for (const { segment } of WORD_SEGMENTER.segment(text)) {
    const candidate = fitted + segment;
    if (graphemeLength(candidate.trimEnd()) <= budget) fitted = candidate;
    else break;
  }
  const trimmed = fitted.trimEnd();
  if (trimmed) return `${trimmed}...`;

  const head = Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment)
    .slice(0, budget)
    .join('')
    .trimEnd();
  return `${head}...`;
}

function element(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Capture selected rendered prose as Markdown, retaining partially selected ancestors. */
export function selectedMessageMarkdown(range: Range, root: HTMLElement): string {
  const expanded = range.cloneRange();
  // A partial visual selection of a formula represents the complete formula,
  // matching the existing math-copy behavior.
  const startMath = element(expanded.startContainer)?.closest('.katex-display, .katex');
  const endMath = element(expanded.endContainer)?.closest('.katex-display, .katex');
  if (startMath) expanded.setStartBefore(startMath.closest('.katex-display') ?? startMath);
  if (endMath) expanded.setEndAfter(endMath.closest('.katex-display') ?? endMath);

  const parts: string[] = [];
  for (const region of root.querySelectorAll<HTMLElement>(quoteText)) {
    if (!expanded.intersectsNode(region)) continue;
    const part = region.ownerDocument.createRange();
    part.selectNodeContents(region);
    if (region.contains(expanded.startContainer))
      part.setStart(expanded.startContainer, expanded.startOffset);
    if (region.contains(expanded.endContainer))
      part.setEnd(expanded.endContainer, expanded.endOffset);
    if (part.collapsed) continue;
    let fragment = part.cloneContents();
    let ancestor = element(part.commonAncestorContainer);
    while (ancestor && ancestor !== region) {
      const wrapper = ancestor.cloneNode(false);
      if (ancestor instanceof HTMLOListElement && wrapper instanceof HTMLOListElement) {
        let item = element(part.startContainer)?.closest('li');
        while (item && item.parentElement !== ancestor) item = item.parentElement?.closest('li');
        if (item) wrapper.start = ancestor.start + [...ancestor.children].indexOf(item);
      }
      wrapper.appendChild(fragment);
      fragment = region.ownerDocument.createDocumentFragment();
      fragment.appendChild(wrapper);
      ancestor = ancestor.parentElement;
    }

    const formulas: Array<[string, string]> = [];
    for (const math of fragment.querySelectorAll('.katex')) {
      const latex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
      if (latex == null) continue;
      const display = math.closest('.katex-display');
      let token = `LODYQUOTEMATH${formulas.length}TOKEN`;
      while (region.textContent?.includes(token)) token += 'X';
      formulas.push([token, display ? `$$\n${latex}\n$$` : `$${latex}$`]);
      (display ?? math).replaceWith(region.ownerDocument.createTextNode(token));
    }
    for (const toolbar of fragment.querySelectorAll(
      '[data-streamdown="code-block-toolbar"], button, [aria-hidden="true"]'
    ))
      toolbar.remove();
    for (const code of fragment.querySelectorAll('pre code')) {
      const language = code.closest<HTMLElement>('[data-language]')?.dataset.language;
      if (language) code.classList.add(`language-${language}`);
      const lines = [...code.querySelectorAll('[data-markdown-code-line]')];
      lines.forEach((line, index) => {
        if (index < lines.length - 1 && !line.textContent?.endsWith('\n')) line.append('\n');
      });
    }
    let markdown = toMarkdown(toMdast(fromDom(fragment)), {
      extensions: [gfmToMarkdown()],
      fences: true,
    }).trimEnd();
    for (const [token, latex] of formulas) markdown = markdown.replace(token, () => latex);
    if (markdown) parts.push(markdown);
  }
  return parts.join('\n\n');
}
