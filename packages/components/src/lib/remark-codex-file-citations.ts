import { isMarkdownAgentFileHref } from './markdown-agent-file-link';

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
  data?: { hProperties?: Record<string, unknown> };
};

// Recognize citations before URL/path linkification can split their attributes.
// Code spans and fences remain literal examples, just like ordinary Markdown.
export const remarkCodexFileCitations = () => (tree: unknown) => {
  const transform = (child: MdastNode): MdastNode[] | undefined => {
    if (child.type !== 'text' || !child.value?.includes(':codex-file-citation{')) return;
    const pattern = /:codex-file-citation\{((?:\s*[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*)\}/gu;
    const nodes: MdastNode[] = [];
    let cursor = 0;
    for (const match of child.value.matchAll(pattern)) {
      const attributes = [...match[1]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)];
      const paths = attributes.filter((attribute) => attribute[1] === 'path');
      if (paths.length !== 1) continue;
      const path = (paths[0]![2] ?? paths[0]![3] ?? '').trim();
      if (!path || /[\r\n\0]/u.test(path)) continue;
      // Encode literal filename punctuation before the existing href boundary decodes it.
      const href = path.split('/').map(encodeURIComponent).join('/');
      if (!isMarkdownAgentFileHref(href) || /^[a-z][a-z\d+.-]*:/iu.test(path)) continue;
      if (match.index > cursor)
        nodes.push({ type: 'text', value: child.value.slice(cursor, match.index) });
      nodes.push({
        type: 'link',
        url: href,
        children: [{ type: 'text', value: path.split('/').pop() ?? path }],
        data: { hProperties: { 'data-codex-file-citation': true } },
      });
      cursor = match.index + match[0].length;
    }
    if (!nodes.length) return;
    if (cursor < child.value.length) nodes.push({ type: 'text', value: child.value.slice(cursor) });
    return nodes;
  };
  const walk = (node: MdastNode) => {
    if (['link', 'linkReference', 'code', 'inlineCode'].includes(node.type)) return;
    node.children = node.children?.flatMap((child) => {
      const replacement = transform(child);
      if (replacement) return replacement;
      walk(child);
      return [child];
    });
  };
  if (typeof tree === 'object' && tree !== null) walk(tree as MdastNode);
};
