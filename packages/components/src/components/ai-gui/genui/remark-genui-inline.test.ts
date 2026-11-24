import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { remarkGenuiInline } from './remark-genui-inline';

interface TreeNode {
  type: string;
  value?: string;
  children?: TreeNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

function run(markdown: string): TreeNode {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkGenuiInline);
  const tree = processor.parse(markdown);
  return processor.runSync(tree) as unknown as TreeNode;
}

function collect(node: TreeNode, type: string, found: TreeNode[] = []): TreeNode[] {
  if (node.type === type) found.push(node);
  for (const child of node.children ?? []) collect(child, type, found);
  return found;
}

describe('remarkGenuiInline', () => {
  it('rewrites a self-contained inline catalog tag in prose', () => {
    const tree = run('status: <icon name="x-circle" color="danger" inline/> done');
    const nodes = collect(tree, 'genuiInline');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data?.hName).toBe('genui-inline');
    expect(nodes[0].data?.hProperties?.['dataGenuiTag']).toBe('icon');
    expect(JSON.parse(String(nodes[0].data?.hProperties?.['dataGenuiProps']))).toEqual({
      name: 'x-circle',
      color: 'danger',
      inline: true,
    });
  });

  it('rewrites tags inside a GFM table cell', () => {
    const tree = run('| a | b |\n|---|---|\n| <icon name="check"/> | x |');
    const nodes = collect(tree, 'genuiInline');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].data?.hProperties?.['dataGenuiTag']).toBe('icon');
  });

  it('leaves unterminated tags as plain text while streaming', () => {
    const tree = run('status: <icon name="x-ci');
    expect(collect(tree, 'genuiInline')).toHaveLength(0);
    expect(collect(tree, 'html')).toHaveLength(0);
  });

  it('merges a tag pair wrapping plain text into one inline node', () => {
    const tree = run('服务在线 <badge tone="success">running</badge> 其余正常');
    const nodes = collect(tree, 'genuiInline');
    expect(nodes).toHaveLength(1);
    expect(JSON.parse(String(nodes[0].data?.hProperties?.['dataGenuiProps']))).toEqual({
      tone: 'success',
      children: 'running',
    });
    expect(collect(tree, 'html')).toHaveLength(0);
  });

  it('leaves a tag pair with formatted children as html nodes', () => {
    const tree = run('a <badge tone="success">*bold*</badge> b');
    expect(collect(tree, 'genuiInline')).toHaveLength(0);
  });

  it('leaves non-allowlist catalog tags as html nodes', () => {
    const tree = run('<button label="go"/>');
    expect(collect(tree, 'genuiInline')).toHaveLength(0);
    expect(collect(tree, 'html')).toHaveLength(1);
  });

  it('leaves expression props as html nodes', () => {
    const tree = run('<icon name={which}/>');
    expect(collect(tree, 'genuiInline')).toHaveLength(0);
    expect(collect(tree, 'html')).toHaveLength(1);
  });
});
