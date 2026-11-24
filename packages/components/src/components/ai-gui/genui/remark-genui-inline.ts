/**
 * Remark plugin for inline catalog tags: catalog tags written directly in
 * ordinary markdown (inside a table cell, a sentence) map to the same
 * GENUI_CATALOG renderer as fenced surfaces — literal props and plain-text
 * children only, no state, no events. Anything else stays an html node and
 * follows the renderer's normal (non-raw-HTML) handling.
 *
 * Two shapes are recognized: self-closing `<icon ... />` and the pair form
 * `<badge ...>text</badge>` when micromark emits it as adjacent
 * html/text/html siblings. Streaming commits on the closing `>`: an
 * unterminated `<icon name="x-ci` is plain text until the tag closes, so
 * half-written markup never mounts.
 */
import { parseView, type UiElement, type UiNode } from '@lody/genui';
import type { Plugin } from 'unified';
import { GENUI_INLINE_TAGS } from './genui-catalog.js';

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

function singleInlineElement(node: UiNode): UiElement | undefined {
  if (node.kind !== 'element' || node.tag !== '#fragment') return undefined;
  const elements = node.children.filter((child) => child.kind === 'element');
  if (elements.length !== 1) return undefined;
  const only = elements[0];
  return only.kind === 'element' ? only : undefined;
}

function literalProps(element: UiElement): Record<string, unknown> | undefined {
  if (!GENUI_INLINE_TAGS.has(element.tag)) return undefined;
  const props: Record<string, unknown> = {};
  for (const prop of element.props) {
    if (prop.spread || prop.value.kind !== 'literal') return undefined;
    props[prop.name] = prop.value.value;
  }
  return props;
}

function tryParse(source: string): { tag: string; props: Record<string, unknown> } | undefined {
  let element: UiElement | undefined;
  try {
    element = singleInlineElement(parseView(source));
  } catch {
    element = undefined;
  }
  if (!element || element.children.some((child) => child.kind === 'element')) return undefined;
  const props = literalProps(element);
  return props ? { tag: element.tag, props } : undefined;
}

function rewrite(node: MdastNode, tag: string, props: Record<string, unknown>): void {
  node.type = 'genuiInline';
  node.value = undefined;
  node.children = [];
  node.data = {
    hName: 'genui-inline',
    hProperties: { dataGenuiTag: tag, dataGenuiProps: JSON.stringify(props) },
  };
}

function closeTagOf(node: MdastNode): string | undefined {
  const match = node.type === 'html' ? node.value?.trim().match(/^<\/([a-zA-Z][\w-]*)\s*>$/) : null;
  return match?.[1];
}

function processChildren(node: MdastNode): void {
  const children = node.children;
  if (!children) return;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type !== 'html' || typeof child.value !== 'string') {
      walk(child);
      continue;
    }
    const selfClosed = tryParse(child.value);
    if (selfClosed) {
      rewrite(child, selfClosed.tag, selfClosed.props);
      continue;
    }
    const open = tryParse(child.value.replace(/>\s*$/, '/>'));
    if (!open || child.value.includes('/>')) continue;
    for (let j = i + 1; j < children.length; j++) {
      const sibling = children[j];
      if (closeTagOf(sibling) === open.tag) {
        const inner = children.slice(i + 1, j);
        if (inner.length > 0 && inner.every((part) => part.type === 'text')) {
          rewrite(child, open.tag, {
            ...open.props,
            children: inner.map((part) => part.value).join(''),
          });
          children.splice(i + 1, j - i);
          break;
        }
      }
      if (sibling.type === 'html') break;
    }
  }
}

function walk(node: MdastNode): void {
  if (node.type === 'html' && typeof node.value === 'string') {
    const match = tryParse(node.value);
    if (match) rewrite(node, match.tag, match.props);
  }
  processChildren(node);
}

export const remarkGenuiInline: Plugin = () => {
  return (tree) => {
    walk(tree as unknown as MdastNode);
  };
};
