import GithubSlugger from 'github-slugger';

type HeadingTree = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HeadingTree[];
};

function headingText(node: HeadingTree): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.tagName === 'img') return String(node.properties?.alt ?? '');
  return node.children?.map(headingText).join('') ?? '';
}

/** Each document owns duplicate numbering, including headings inside quotes and lists. */
export function rehypeHeadingAnchors() {
  return (tree: unknown) => {
    const slugger = new GithubSlugger();
    const walk = (node: HeadingTree) => {
      if (node.type === 'element' && /^h[1-6]$/.test(node.tagName ?? '')) {
        node.properties = {
          ...node.properties,
          id: slugger.slug(headingText(node)),
          tabIndex: -1,
        };
      }
      node.children?.forEach(walk);
    };
    walk(tree as HeadingTree);
  };
}
