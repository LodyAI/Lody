import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { createHeadlessEditor } from '@lexical/headless';
import { $generateNodesFromDOM } from '@lexical/html';
import { CodeNode } from '@lexical/code-core';
import { LinkNode, AutoLinkNode } from '@lexical/link';
import { ListNode, ListItemNode } from '@lexical/list';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { $isElementNode } from 'lexical';

const window = new Window();
for (const key of [
  'HTMLElement',
  'Node',
  'Text',
  'Document',
  'DocumentFragment',
  'HTMLAnchorElement',
  'HTMLOListElement',
  'CSSStyleRule',
  'Element',
]) {
  globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.document = window.document;

const serialize = (node) => {
  const json = node.exportJSON();
  if ($isElementNode(node)) json.children = node.getChildren().map(serialize);
  return json;
};

const root = join(import.meta.dirname, 'html');
for (const file of readdirSync(join(root, 'inputs'))
  .filter((name) => name.endsWith('.html'))
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
  const dom = new window.DOMParser().parseFromString(
    readFileSync(join(root, 'inputs', file), 'utf8'),
    'text/html',
  );
  let nodes = [];
  editor.update(
    () => {
      nodes = $generateNodesFromDOM(editor, dom).map(serialize);
    },
    { discrete: true },
  );
  writeFileSync(
    join(root, 'expected', file.replace(/\.html$/, '.json')),
    JSON.stringify(nodes, null, 2) + '\n',
  );
}
