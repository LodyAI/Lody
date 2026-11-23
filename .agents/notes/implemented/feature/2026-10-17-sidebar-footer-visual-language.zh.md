# 侧边栏底栏视觉语言

Status: implemented
Translation: current

[English](2026-10-17-sidebar-footer-visual-language.md)

## 摘要

桌面侧边栏的顶部和底部看起来像两套产品：顶部与导航行使用侧边栏自己的文字色和填充，
底部则由通用 ghost 按钮（自带悬停色、字重和圆角）搭成，上面还有一条在页面卡片圆角处断掉的细线。
现在底栏使用导航行的材质：去掉顶部分隔线，workspace 控件按导航行排布，图标按钮与顶部共用同一份样式。
底栏两侧更宽（12px，原为 6px），因为 6px 显得局促；高度仍保持紧凑的 36px。
代价是桌面底栏不再沿用 UI 原语的 ghost 样式。未在运行中的应用里检查过。

## 决策与依据

- 页面卡片本来就靠明暗而不是线与窗口分开，所以桌面底栏去掉 `border-t`；
  移动端抽屉旁没有卡片，保留该线。
- `sidebarSurface.iconButton`（`sidebar-surface.ts`）是唯一的纯图标控件：
  28px、`radius.small`，静止为弱化文字色，悬停升为行文字色并带悬停填充，当前页面用 `selected`。
  底栏的 `IconButton` 和顶部的 `SidebarHeaderIconButton` 都使用它；移动端仍是 48px 的 ghost 按钮。
- workspace 控件是 `button`，使用 `sidebarSurface.row` 与 `footerRow`：
  固定 28px（任何界面字号下都与图标按钮等高），16px 头像位于 16px 图标列，字重为行的常规字重。
  这取代了此前[底部入口 Spec](../../../../specs/sidebar-footer.md) 中的 20px 头像和 500 字重；
  该 Spec 已更新，仍为 `draft`。
- 间距：底栏左右各 12px（此前为 6px），上下仍为 4px。
  workspace 行左右各 6px 内边距，使头像距边缘 18px，与右侧设置图标一致。
  [紧凑底栏记录](2026-10-04-sidebar-footer-density.zh.md)中的 28px 控件、4px 间隔和 4px 上下内边距不变。
  头像因此比导航图标列靠右 3px。曾尝试加高底栏，因增加的高度而放弃。
- 未采用的方案：通过 `className` 改写 `@lody/ui` 的 ghost `Button`，组件规则禁止这样做。

## 验证限制

编写环境没有 Node 工具链，因此未运行测试、类型检查，也未做桌面端检查。
请运行 `pnpm check`、侧边栏测试套件和文档检查，并在明暗两种主题下查看底栏。
Updated 列表的行比工作区列表和导航行矮 2px，本记录不改变这一点。
