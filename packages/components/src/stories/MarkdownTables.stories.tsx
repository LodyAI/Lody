import type { Meta, StoryObj } from '@storybook/react';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { MarkdownFileResources } from '@/components/ai-gui/markdown-file-image';
import { createFakeFileWorkspaceProvider } from '@/lib/file-workspace-provider';

const svg = (width: number, height: number, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#324967"/><text x="24" y="${Math.round(height / 2)}" fill="white" font-size="28">${label}</text></svg>`;

const provider = createFakeFileWorkspaceProvider({
  files: [
    { path: 'images/wide-chart.svg', kind: 'text', sourceState: 'live-readonly' },
    { path: 'images/small.svg', kind: 'text', sourceState: 'live-readonly' },
  ],
  snapshots: {
    'images/wide-chart.svg': {
      kind: 'text',
      text: svg(1600, 240, 'A very wide chart, 1600x240'),
    },
    'images/small.svg': { kind: 'text', text: svg(96, 48, 'small') },
  },
});

const STATUS_REPORT = `## 当前状态

| 项目 | 链接 / 路径 | 状态 |
| --- | --- | --- |
| OSS：升级到 Electron 43 | [LodyAI/Lody #1154](https://github.com/LodyAI/Lody/pull/1154) | Draft，已通过 CI；需要 @wibus-wee 确认两项例外：electron-vite 6 beta 与 19 项隔离依赖 |
| 私有仓库：构建工具适配 | [loro-dev/lody #3708](https://github.com/loro-dev/lody/pull/3708) | Draft |
| production cloud 测试包 | [~/Code/lody-build/.lody-build/artifacts/20260930-150322-66477/mac-arm64/Lody.app](/Users/me/Code/lody-build/.lody-build/artifacts/20260930-150322-66477/mac-arm64/Lody.app) | 用 #3708 版本的构建工具构建，Electron 43.7.1，自动更新已关闭 |`;

const SHORT_KEY_VALUE = `| 字段 | 值 |
| --- | --- |
| 版本 | 1.4.2 |
| 平台 | macOS |
| 状态 | ✅ 通过 |`;

const SHORT_WIDE_HEADERS = `| Option | Default | Required |
| --- | :---: | :---: |
| \`--port\` | 6006 | no |
| \`--host\` | localhost | no |`;

const PROSE_CELLS = `| Approach | Pros | Cons |
| --- | --- | --- |
| Auto layout | The browser picks column widths from content, so short columns stay compact and prose columns take the remaining width. | A single unbreakable token (a path or URL) can dominate the table and squeeze everything else. |
| Fixed layout | Predictable, equal columns that never depend on content. | Short columns waste space while long ones wrap aggressively; the header row alone decides widths. |
| Hybrid | Short columns keep their natural width; long columns wrap. | Needs a per-column heuristic. |`;

const MIXED_ELEMENTS = `| 元素 | 示例 | 说明 |
| --- | --- | --- |
| 行内代码 | \`useLayoutEffect\` / \`packages/components/src/components/ai-gui/markdown-table.tsx\` | 长路径需要可以在任意位置折行 |
| 文件链接 | [markdown-renderer.tsx](packages/components/src/components/ai-gui/markdown-renderer.tsx#L201) | 文件图标与文件名作为一个整体 |
| 强调 | **加粗**、*斜体*、~~删除线~~ | 混合 CJK 与 English words |
| 链接 | [Storybook docs](https://storybook.js.org/docs) 和 https://github.com/LodyAI/Lody/pull/1154/files#diff-0123456789abcdef | 裸 URL 也不应撑爆表格 |
| 数学 | $$E = mc^2$$ | KaTeX inline |
| 换行 | 第一行<br>第二行 | \`<br>\` 仅在允许 HTML 时生效 |
| 空单元格 |  | 空 |
| Emoji | 🚀 ✅ ⚠️ | 🙂 |`;

const NUMERIC = `| Package | Files | Lines added | Lines removed | Coverage |
| :--- | ---: | ---: | ---: | ---: |
| \`@lody/components\` | 128 | 4,213 | 1,907 | 82.4% |
| \`@lody/shared\` | 12 | 311 | 45 | 91.0% |
| \`apps/cli\` | 7 | 58 | 3 | 76.3% |`;

const MANY_COLUMNS = `| ID | Name | Owner | Machine | Branch | Status | Created | Updated | Tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
| 1 | Electron 43 upgrade | zxch3n | mac-studio | feat/electron-43 | Draft | 2026-09-28 | 2026-09-30 | 1,204,331 | $12.40 |
| 2 | 构建工具适配 | Leeeon233 | linux-builder-01 | chore/build-tooling | Review | 2026-09-29 | 2026-09-30 | 98,112 | $1.02 |`;

const LONG_UNBREAKABLE = `| Key | Value |
| --- | --- |
| sha256 | 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a089f86d081884c7d659a2feaa0c55ad015 |
| path | /Users/someone/Library/Application Support/Lody/managed-runtimes/acp-extension-codex/0.42.1/darwin-arm64/bin/acp-extension-codex |`;

const LONG_PROSE_CELL = `| 模块 | 说明 | 负责人 |
| --- | --- | --- |
| 渲染管线 | ${'markdown 表格的列宽由浏览器 auto layout 决定：先算每列的 min-content 与 max-content，再按比例分配剩余空间。'.repeat(4)} | zxch3n |
| 滚动容器 | 短描述 | Leeeon233 |`;

const CELL_WITH_IMAGES = `| 截图 | 说明 | 备注 |
| --- | --- | --- |
| ![宽图](../images/wide-chart.svg) | 1600px 宽的图片 | 图片列不应该把这两列挤没，它们的内容仍然需要足够的宽度来排版 |
| ![小图](../images/small.svg) 与文字混排 | 小图 + 文本同行 | 短备注 |`;

const BIG_GRID = (() => {
  const cols = 16;
  const header = `| ${Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(' | ')} |`;
  const divider = `| ${' --- |'.repeat(cols)}`;
  const rows = Array.from(
    { length: 40 },
    (_row, r) =>
      `| ${Array.from({ length: cols }, (_col, c) =>
        (r + c) % 9 === 0 ? `单元格 ${r + 1}-${c + 1} 长一点的内容` : `${r + 1}-${c + 1}`
      ).join(' | ')} |`
  );
  return [header, divider, ...rows].join('\n');
})();

const MEGA_COMPLEX = (() => {
  const headers = [
    'ID',
    '任务',
    '负责人',
    '状态',
    '分支',
    'PR',
    '文件',
    '耗时',
    'Tokens',
    '成本',
    '标签A',
    '标签B',
    '标签C',
    '备注',
  ];
  const cells = (r: number): string[] => [
    `#${r + 1}`,
    r % 3 === 0 ? `重构 markdown 表格列宽分配策略，覆盖边界场景 ${r}` : `任务 ${r + 1}`,
    ['zxch3n', 'Leeeon233', 'wibus-wee'][r % 3],
    ['Draft', '✅ Done', 'Review'][r % 3],
    `\`feat/table-${r + 1}\``,
    `[LodyAI/Lody #${1100 + r}](https://github.com/LodyAI/Lody/pull/${1100 + r})`,
    r % 4 === 0
      ? `[src/components/ai-gui/markdown-table.tsx](/Users/me/Code/lody/packages/components/src/components/ai-gui/markdown-table.tsx)`
      : `packages/components/src/${r % 2 ? 'lib' : 'hooks'}/mod-${r + 1}.ts`,
    `${((r * 37) % 90) + 5} min`,
    `${(r + 1) * 42331}`,
    `$${((r + 1) * 1.37).toFixed(2)}`,
    r % 5 === 0 ? '🚀' : '—',
    r % 2 ? `后端` : `前端`,
    r % 4 === 1 ? 'electron-vite-6-beta-超长标签字串' : `tag-${r}`,
    r % 6 === 0
      ? '备注里也有很长的一段话，用来测试复杂表格里散文单元格的换行和列宽分配是否依然合理'
      : `备注 ${r + 1}`,
  ];
  return [
    `| ${headers.join(' | ')} |`,
    `| ${' --- |'.repeat(headers.length)}`,
    ...Array.from({ length: 24 }, (_, r) => `| ${cells(r).join(' | ')} |`),
  ].join('\n');
})();

const SCENARIOS = [
  ['Status report (reported case)', STATUS_REPORT],
  ['Short key/value', SHORT_KEY_VALUE],
  ['Short table, aligned columns', SHORT_WIDE_HEADERS],
  ['Prose cells', PROSE_CELLS],
  ['Mixed inline elements', MIXED_ELEMENTS],
  ['Numeric, right aligned', NUMERIC],
  ['Many columns', MANY_COLUMNS],
  ['Long unbreakable tokens', LONG_UNBREAKABLE],
  ['One very long prose cell', LONG_PROSE_CELL],
  ['Images in cells', CELL_WITH_IMAGES],
  ['16 columns × 40 rows', BIG_GRID],
  ['14 columns × 24 rows, mixed content', MEGA_COMPLEX],
] as const;

function TableGallery({ width }: { width: number }) {
  return (
    // The preview pins html/body/#storybook-root at overflow:hidden to match
    // production, so the gallery owns its own scroller.
    <div className="scrollbar-pro flex h-full flex-col gap-8 overflow-y-auto p-6">
      {SCENARIOS.map(([title, markdown]) => (
        <section key={title} className="flex flex-col gap-2">
          <div className="text-xs text-muted-foreground">{title}</div>
          <div style={{ width }} className="outline outline-1 outline-dashed outline-border">
            <MarkdownFileResources
              provider={provider}
              documentPath="docs/tables.md"
              automatic
              active
            >
              <MarkdownRenderer text={markdown} allowHtml />
            </MarkdownFileResources>
          </div>
        </section>
      ))}
    </div>
  );
}

const meta = {
  title: 'Conversation/Markdown tables',
  component: TableGallery,
  parameters: { layout: 'fullscreen' },
  args: { width: 720 },
} satisfies Meta<typeof TableGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ConversationWidth: Story = {};
export const NarrowPanel: Story = { args: { width: 480 } };
/** Phone rules follow the viewport: pick a mobile viewport to see them. */
export const Phone: Story = {
  args: { width: 360 },
  globals: { viewport: { value: 'mobile2', isRotated: false } },
};
