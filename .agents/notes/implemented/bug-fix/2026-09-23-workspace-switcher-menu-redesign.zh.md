# 工作区切换菜单：统一行系统，移除定制卡片

Status: implemented
Translation: current

[English](2026-09-23-workspace-switcher-menu-redesign.md)

## 摘要

工作区切换下拉堆叠了四套互不相关的几何：菜单标签在 `px-2`，操作图标在
`px-2`，单选行的 `ps-8` 选择缩进把内嵌头像和名字推到第三条列，再加一块手写
padding 的当前工作区卡片——它用不同的规格重复展示了勾选行已有的信息，于是
弹层既错位又突兀。重设计把整个卡片删掉：菜单现在是一套统一的行系统（邮箱标
签、工作区单选列表、操作行），所有行共用 20px 引导盒和一条文字列。卡片独有
的 Plan 与成员数信息移到当前工作区自己的单选行行尾（muted 文本），勾选行同
时也是信息最丰富的行。`DropdownMenuRadioItem` 新增 `indicatorSide` 选项，在
行首槽位已承载身份标记时把勾选项移到行尾。

## 决策

`loro-sidebar.tsx` 的切换菜单：

- 移除 `data-current-workspace` 卡片及其分隔线。勾选的单选行本就标识了当前
  工作区；卡片仅多出 "Plus Plan · 3 members" 一行信息，现在以 muted 行尾文
  本渲染在同一行上(`workspace.switcher.plan` / `.planAndMembers` i18n key
  不变）。其他行继续使用 planTier 徽标。
- 单选行保留行首 `WorkspaceAvatar`，改用 `gap-1.5 ps-2 pe-8` 加
  `indicator="check" indicatorSide="end"`：头像与操作行的图标盒对齐，`pe-8`
  为行尾勾选预留空间，徽标/Plan 文本不会压到勾选。
- `DropdownMenuRadioItem`（共享 `ui/dropdown-menu.tsx`）接受
  `indicatorSide?: 'start' | 'end'`，默认 `start`，其他菜单不受影响。按
  `src/ui/AGENTS.md` 的约定扩展原语而非私有覆写。
- 操作行把图标包进 20px 的 `h-5 w-5` 弹性盒并配 `gap-1.5`，使单选行与操作
  行在 `px-2` 处共用一条引导列和一条文字列。
- "Switch workspace" 分组标签保留：卡片移除后它是单选组的锚点。

被否决的替代方案：保留卡片只调样式（仍是为重复信息准备的第二套几何）；去掉
头像（最先实现过，评审中被否——头像是工作区身份）；勾选留行首与头像并排
（重现三列锯齿）；文字对齐到卡片的 56px 列（把所有行推得更深）。

### 已回退的配套改动

同期曾为 Updated 会话列表实现"内聚外疏"——`SessionOpenedByTreeRow` 的
`separated` 属性在 `sidebar-updated-session-list.tsx` 和 `session-list.tsx`
的树组边界加 `mt-1.5`。评审中在落地前被回退：列表维持统一的 `gap-px` 节奏。
调查结论仍然成立——那里感知到的不一致是等间距下双行父行与单行子行的行高差，
而非间距不等——但间距改动被认为没有必要。

## 验证

Storybook(`Components/LodySidebar`，深色）前后对比：菜单现已统一——头像与
操作图标共用一条引导列，所有标签共用一条文字列，当前行展示
"Plus Plan · 3 members" 且勾选在行尾。改动文件 `tsgo --noEmit`、`oxlint`、
`oxfmt` 干净；opened-by 树测试通过（回退恢复原代码路径）。未验证：单选/右键
菜单/修饰键点击交互走未改动的处理器；多账号（邮箱标签）与免费版变体仅经推
演未实际渲染。

## 后续修复，2026-09-26：保留菜单归属与 tooltip 锚点

`18f10b6514` 的 Base UI 迁移把每个桌面工作区单选行放进了各自的
`ContextMenu.Root`。两种菜单共享根上下文，因此单选行读取了关闭中的右键菜单
高亮状态，而不是 dropdown 的状态。tooltip 同时把 `display: contents` 的
右键触发器包装层作为锚点；该元素没有可测量的布局盒，提示因此定位到了视口
原点附近。原先声称两个触发器属性都落在行元素上的注释已经失效。

现在单选行先在 dropdown 上下文中解析，再在其 `render` 回调内部引入右键
菜单。属性、事件和 ref 都落在同一个实际行元素上，tooltip 也以它为触发器。
`ContextMenu.Trigger` 仅对默认包装层应用 `display: contents`，显式 `render`
保留传入元素的布局。切换器触发按钮也移除了迁移残留的重复子按钮。仅增加
CSS hover 或调整 tooltip 偏移无法修复错误的菜单归属与锚点。

组合结构为 `Tooltip.Trigger → Menu.RadioItem → render(ContextMenu.Root
→ ContextMenu.Trigger → div)`：外层菜单拥有选择与高亮状态，内层菜单拥有
右键操作。现有菜单外观与工作区导航意图不变。

回归覆盖扩展了工作区身份与共享菜单测试，检查高亮移动、提示的行触发器、
dropdown 选择与关闭，以及显式渲染右键触发器的 ref、布局和右键行为。

验证：两组侧栏测试共 24 项通过，更新后的菜单测试共 30 项通过。UI 包原有
299 项测试及其类型检查通过，改动文件的 lint 与格式检查通过。使用真实样式
原语的 Chromium 测试页面测得行 y=315、提示 y=322，行保留 flex 布局，高亮
与右键菜单正常。这验证了组件组合，未验证打包后的 Electron。测试复用了已有
依赖缓存；完整 components 类型检查仍报告改动范围外的依赖/类型错误（包括
Effect 类型标识冲突）。`docs check` 被未初始化的 Codex/Grok 子模块链接阻塞，
其错误不涉及本次修改的文档。

PR：[#1022](https://github.com/LodyAI/Lody/pull/1022)。
