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
    if (child.type !== 'text' || !child.value?.includes(':codex-file-citation{')) return undefined;
    const pattern = /:codex-file-citation\{((?:\s*[\w-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*)\}/gu;
    const nodes: MdastNode[] = [];
    let cursor = 0;
    for (const match of child.value.matchAll(pattern)) {
      const attributes = [...match[1]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)];
      const paths = attributes.filter((attribute) => attribute[1] === 'path');
      if (paths.length !== 1) continue;
      const path = (paths[0]![2] ?? paths[0]![3] ?? '').trim();
      if (!path || /[\r\n]/u.test(path) || path.includes(String.fromCharCode(0))) continue;
      // Encode literal filename punctuation before the existing href boundary decodes it.
      const windowsDrivePath = /^[a-z]:[\\/]/iu.test(path);
      if (!windowsDrivePath && /^[a-z][a-z\d+.-]*:/iu.test(path)) continue;
      const normalizedPath = path.replace(/\\/gu, '/');
      const href = normalizedPath
        .split('/')
        .map((segment, index) =>
          windowsDrivePath && index === 0 ? segment : encodeURIComponent(segment)
        )
        .join('/');
      if (!isMarkdownAgentFileHref(href)) continue;
      if (match.index > cursor)
        nodes.push({ type: 'text', value: child.value.slice(cursor, match.index) });
      nodes.push({
        type: 'link',
        url: href,
        children: [{ type: 'text', value: normalizedPath.split('/').pop() ?? path }],
        data: { hProperties: { 'data-codex-file-citation': true, 'data-file-path-source': path } },
      });
      cursor = match.index + match[0].length;
    }
    if (!nodes.length) return undefined;
    if (cursor < child.value.length) nodes.push({ type: 'text', value: child.value.slice(cursor) });
    return nodes;
  };
  const walk = (node: MdastNode) => {
    if (['link', 'linkReference', 'code', 'inlineCode'].includes(node.type)) return;
    if (!Array.isArray(node.children)) return;
    node.children = node.children.flatMap((child) => {
      const replacement = transform(child);
      if (replacement) return replacement;
      walk(child);
      return [child];
    });
  };
  if (typeof tree === 'object' && tree !== null) walk(tree as MdastNode);
};
