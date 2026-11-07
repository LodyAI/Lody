import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHeadlessEditor } from '@lexical/headless';
import { CodeNode } from '@lexical/code-core';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { ListNode, ListItemNode } from '@lexical/list';
import {
  $generateNodesFromMarkdownString,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  CHECK_LIST,
  CODE,
  HEADING,
  HIGHLIGHT,
  INLINE_CODE,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
} from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $isElementNode } from 'lexical';

const GFM = [
  HEADING,
  QUOTE,
  CHECK_LIST,
  UNORDERED_LIST,
  ORDERED_LIST,
  CODE,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_ITALIC_UNDERSCORE,
  BOLD_STAR,
  BOLD_UNDERSCORE,
  HIGHLIGHT,
  ITALIC_STAR,
  ITALIC_UNDERSCORE,
  STRIKETHROUGH,
  LINK,
];

const serialize = (node) => {
  const json = node.exportJSON();
  if ($isElementNode(node)) json.children = node.getChildren().map(serialize);
  return json;
};

const root = join(import.meta.dirname, 'markdown');
for (const file of readdirSync(join(root, 'inputs'))
  .filter((name) => name.endsWith('.md'))
  .sort()) {
  const editor = createHeadlessEditor({
    nodes: [
      HeadingNode,
      QuoteNode,
      CodeNode,
      ListNode,
      ListItemNode,
      LinkNode,
      AutoLinkNode,
    ],
    onError: (error) => {
      throw error;
    },
  });
  const markdown = readFileSync(join(root, 'inputs', file), 'utf8').replace(
    /\n$/,
    '',
  );
  let nodes = [];
  editor.update(
    () => {
      nodes = $generateNodesFromMarkdownString(markdown, GFM, true).map(
        serialize,
      );
    },
    { discrete: true },
  );
  writeFileSync(
    join(root, 'expected', file.replace(/\.md$/, '.json')),
    JSON.stringify(nodes, null, 2) + '\n',
  );
}
