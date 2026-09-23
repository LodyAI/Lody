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
