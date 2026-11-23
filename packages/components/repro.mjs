import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const cases = [
  '完成了，PR 已开：**https://github.com/LodyAI/Lody/pull/317**，分支 `fix/x`。',
  '见 https://github.com/LodyAI/Lody/pull/317，分支',
  '见 https://example.com/a。然后',
  '**https://example.com/a**，b',
];
for (const src of cases) {
  const proc = unified().use(remarkParse).use(remarkGfm);
  const tree = proc.runSync(proc.parse(src), { toString: () => src, value: src });
  console.log('SRC:', src);
  console.log(JSON.stringify(tree.children[0].children, (k, v) => (k === 'position' ? undefined : v), 1));
  console.log('---');
}
