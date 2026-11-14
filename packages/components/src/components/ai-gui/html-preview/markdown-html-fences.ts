import type { Processor } from 'unified';

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { createMarkdownParseCache } from '@/lib/markdown-parse-cache';

type Tree = ReturnType<NonNullable<Processor['parser']>> & {
  children?: Tree[];
  tagName?: string;
  properties?: Record<string, unknown>;
};
type File = Parameters<NonNullable<Processor['parser']>>[1];

/** Mark closure from the parser's fence tokens, including nested containers. */
export function remarkFenceClosure(this: Processor) {
  const data = this.data();
  const extensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  extensions.push({
    enter: {
      codeFencedFence() {
        const node = this.stack.findLast((entry) => entry.type === 'code');
        if (!node) return;
        const properties = ((node.data ??= {}).hProperties ??= {});
        properties.dataIncomplete = properties.dataIncomplete !== true;
      },
    },
  });
  return (tree: Tree, file: File) => {
    const closure = new Map<number, boolean>();
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      const offset = node.position?.start.offset;
      if (node.type === 'code' && offset !== undefined) {
        const data = node.data as { hProperties?: { dataIncomplete?: boolean } } | undefined;
        closure.set(offset, data?.hProperties?.dataIncomplete !== false);
      }
      if (Array.isArray(node.children)) pending.push(...node.children);
    }
    file.data.lodyFenceClosure = closure;
  };
}

/** Restore parser-owned closure after raw HTML parsing and sanitization. */
export function rehypeFenceClosure() {
  return (tree: Tree, file: File) => {
    const closure = file.data.lodyFenceClosure as Map<number, boolean>;
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.type === 'element' && node.tagName === 'code') {
        node.properties!.dataIncomplete = closure.get(node.position?.start.offset ?? -1);
      }
      if (Array.isArray(node.children)) pending.push(...node.children);
    }
  };
}

const parser = unified().use(remarkParse).use(createMarkdownParseCache());

export function hasHtmlCodeBlock(source: string): boolean {
  const tree = parser.parse(source);
  const pending = [...tree.children];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.type === 'code' && node.lang === 'html') return true;
    if ('children' in node) pending.push(...(node.children as typeof pending));
  }
  return false;
}
