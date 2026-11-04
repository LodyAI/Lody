import type { Plugin, Processor } from 'unified';

type ParsedTree = ReturnType<NonNullable<Processor['parser']>>;

interface ParseCacheLimits {
  entries: number;
  sourceCharacters: number;
  nodes: number;
  entryCharacters: number;
}

const DEFAULT_LIMITS: ParseCacheLimits = {
  entries: 64,
  sourceCharacters: 1024 * 1024,
  nodes: 8192,
  entryCharacters: 128 * 1024,
};

/** One window-owned cache per fixed parser configuration, before any AST transforms. */
export function createMarkdownParseCache(limits = DEFAULT_LIMITS): Plugin {
  const entries = new Map<string, { tree: ParsedTree; nodes: number }>();
  let sourceCharacters = 0;
  let nodes = 0;

  return function cachedMarkdownParser(this: Processor) {
    const parse = this.parser;
    if (!parse) throw new Error('Markdown parse cache requires remark-parse');
    this.parser = (source, file) => {
      const entry = entries.get(source);
      if (entry) {
        entries.delete(source);
        entries.set(source, entry);
        // Remark and react-markdown mutate trees; neither may mutate the retained input.
        return structuredClone(entry.tree);
      }

      const tree = parse(source, file);
      if (source.length > Math.min(limits.entryCharacters, limits.sourceCharacters)) return tree;
      let count = 0;
      const pending: ParsedTree[] = [tree];
      while (pending.length) {
        const node = pending.pop()!;
        count += 1;
        if (count > limits.nodes) return tree;
        if ('children' in node && Array.isArray(node.children)) {
          if (count + pending.length + node.children.length > limits.nodes) return tree;
          for (const child of node.children) pending.push(child);
        }
      }
      if (limits.entries < 1) return tree;
      while (
        entries.size >= limits.entries ||
        sourceCharacters + source.length > limits.sourceCharacters ||
        nodes + count > limits.nodes
      ) {
        const oldest = entries.entries().next().value!;
        entries.delete(oldest[0]);
        sourceCharacters -= oldest[0].length;
        nodes -= oldest[1].nodes;
      }
      entries.set(source, { tree: structuredClone(tree), nodes: count });
      sourceCharacters += source.length;
      nodes += count;
      return tree;
    };
  };
}
