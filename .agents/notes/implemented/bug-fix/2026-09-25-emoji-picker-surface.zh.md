# Emoji 选择器改用所在浮层的色阶，不再用 `--popover`

Status: implemented
Translation: current

[English](2026-09-25-emoji-picker-surface.md)

## 摘要

Agent 角色编辑器里的 emoji 选择器在承载它的浮层内渲染成一块近黑的板子
（`#101010`）：shadcn `frimousse` 注册表代码把根节点刷成 `bg-popover`，而这个
Tailwind 变量在本仓库里取自内置 VS Code 主题的 `editorWidget.background`；承载它的
`@lody/ui` `Popover` 浮层用的则是 StyleX 浮动层 token `colors.raisedBackground`
（Vesper 深色下为 `#232323`）。现在选择器自身不带任何表面色：根节点透明，只有
sticky 分类标题保留填充，直接使用 `raisedBackground`，在明暗两套调色板中都和浮层
一致。同一改动顺带修复了注册表里失效的 `data-[active]:bg-accent`（`--accent` 从未
被声明，格子高亮实际解析为空），改用应用统一的浮层 hover 约定，并收紧了浮层
外围：`EmojiField` 给 `Popover.Content` 传了 `gap-1 p-1`（共享面板的 12px padding
和 10px gap 在密集网格周围显得松）。"恢复为默认"的 ghost 按钮保持在选择器
下方居中——试过整宽左对齐的菜单行样式，效果反而更差。

## 问题与证据

"新建 Agent 角色"对话框中，选择器明显比包裹它的浮层边框更黑。这里汇聚了两套主题
体系：`Popover` 的浮层读 `@lody/ui` 的 StyleX token `popup.background` =
`colors.raisedBackground`，而选择器的注册表 `bg-popover` 读 `--popover`，后者由
`vscode-theme-css.ts` 按 `editorWidget.background → quickInput.background →
panel.background → sideBar.background` 推导。Vesper 把 `editorWidget.background`
设为 `#101010`，于是选择器在本该可见的浮层上又盖了一层更深的颜色。

改动前在 Storybook 实测：根节点和分类标题计算值为 `rgb(16, 16, 16)`；改动后根节点
为 `rgba(0,0,0,0)`，sticky 标题与浮层同为 `rgb(35, 35, 35)`。

## 发现的约束

- frimousse 的分类标题默认 `position: sticky; top: 0`，所以标题仍需要不透明填充，
  否则滚动的行会透出来——它通过 StyleX 使用 `colors.raisedBackground`，而不是去
  引用 popup token。
- 全仓库没有任何地方声明 `--accent`，`data-[active]:bg-accent` 产生的是非法的
  `hsl()`，高亮根本不存在。格子现在使用 `src/ui/AGENTS.md` 的浮层 hover 填充
  （浅色 `bg-foreground/[0.05]`，深色 `bg-white/[0.10]`）。
- Storybook 的 `viteFinal` 此前没有注册 `vite-emojibase-assets.ts`——为选择器
  提供内置数据集的插件。`src/ui/AGENTS.md` 要求每个宿主构建都注册它；Storybook
  现在已注册，否则选择器在 story 里会一直转圈。

## 备选方案

- 在调用处用其他 Tailwind 表面 token（如 `bg-card`）覆盖 `bg-popover`：仍是与浮层
  不同的颜色，且 sticky 标题在 primitive 内部，色差依旧存在。
- 修改 `--popover` 别名规则或 Vesper 的 `editorWidget.background`：会波及所有
  `bg-popover` 消费方（mention 菜单、命令面板、标注浮层、移动端 picker）或所有
  编辑器 widget——对这个缺陷来说影响面太大。

## 验证限度

在 Storybook（`Settings/AgentRoleForm`，深色 + zh_CN）中用前后截图和计算样式比对
验证，滚动列表中 sticky 标题也能正确遮住下方行。浅色模式在结构上同样成立（两侧都
读 `raisedBackground`），但未截图。
