# 设置页统一使用偏好设置的行写法

Status: implemented
Translation: current

[English](2026-09-26-settings-row-grammar.md)

## 摘要

设置窗口改成平铺后，owner 逐个评价了各 Tab：偏好设置好，关于还可以；账号、通用、账单很不好；
外观、Agent 角色很怪；Agents 不是特别好。对照代码，好的 Tab 都用同一种写法：每组有按意思起的
标题，每一行都是 `CompactRow`，右边只有一个答案，全部由公共样式组成，自定义样式只有六个左右。
差的 Tab 各自发明了行（多控件的记录卡片、头像、Badge、垃圾桶图标、进度条、第四种字号），而且在
同一页里把带框的记录卡片和平铺的偏好行放在一起。现在账号和通用两页完全改用偏好设置的写法。记录
也写成行：名称、一行状态、一个答案（一个值、一个菜单或一个按钮），其余操作移进那个菜单或记录自己
的详情页。其他 Tab 尚未改造。

## 诊断

基于 `main`（8f4b9f49）上 `packages/components/src/components/settings` 的代码统计：

| Tab | owner 评价 | 自定义 StyleX 样式 | 破坏写法的地方 |
| --- | --- | --- | --- |
| 偏好设置 | 好 | 6 | 无：分组有标题，每行用开关或一个 Select 回答 |
| 关于 | 还可以 | 9 | 无 |
| 账号 | 很不好 | 31 | 邮箱挂在标题旁；机器行有 Badge、Agent 图标堆叠、“配置”、目录菜单和图标按钮；退出登录在页面中间 |
| 通用 | 很不好 | （同一文件） | 成员带头像、ghost 角色菜单和红色垃圾桶；邀请有信封图标块和两个操作；带框与平铺混排 |
| 账单 | 很不好 | 52 | 十个分组只有两个标题；1.125em 的方案名；进度条、强调色对勾的权益列表、六个 Badge、文字链接操作、嵌套滚动区 |
| 外观 | 怪 | 12 | 第一组无标题，放着主题和语言；字号出现两次、两种控件；一块终端预览 |
| Agent 角色 | 怪 | catalog | catalog 行：12px 名称配图标底块，每行两个 Badge |
| Agents | 一般 | 46 + 22 | Provider 行带内联用量条，操作悬停才出现 |

原因不在平铺还是卡片：偏好设置本身是平铺的，owner 也否定了“去掉平铺”的尝试（“不是这个的问题”）。
被取代的尝试 PR #997 是在账号页已有的自定义布局上继续精修（机器列的 subgrid，然后是已绑定账号卡片），
已关闭。

## 决定

- 设置页的一行就是一个 `CompactRow`：名称，可选的说明（只写名称说不出的内容），和一个答案。
- 记录也是行。机器：名称，“本机 · 在线 · darwin · 私有 · 6 个 Agent · 10 个目录”，以及打开其设置
  的**管理**。Agent、共享和目录都在那一页，所以行上的 Agent 图标堆叠、“配置”按钮和目录菜单都去掉了。
  Token：备注，然后是预览 · 来源 · 创建时间 · 最近使用，然后是**撤销**。成员：名称、邮箱，角色是一个
  菜单，菜单里也能移出工作区。邀请：邮箱、角色，状态是一个菜单，可复制链接或撤回邀请。
- 已绑定账号保持 `main` 的样子：个人资料里的一行，右边是那排服务 Logo。按服务分行的分组试过，被 owner 否掉。
- 账号页顺序：个人资料（邮箱、用户名、头像、已绑定账号）、我的机器、CLI Token，最后是登录
  （密码，然后退出登录）。
- 在平铺窗口里，这两页没有带框的分组。标题处执行操作的按钮是文字（“创建 Token”“邀请成员”），不是单独的图标。
- Token 日期跟随产品语言（`toIntlLocaleOrEn`），而不是系统语言。

## 设置面板的白色页面（回归修复）

`surface.canvas` 是 `colors.elevatedBackground`，本意是面板自身的底色：浅色下为白色，因为
`[data-settings-surface]` 把 `--card` 换成了 `--popover`。自 #961 起，产品调色板在根节点上声明
`elevatedBackground: hsl(var(--card))`。CSS 自定义属性在声明它的节点上求值，子节点继承的是算好的值，
所以面板上的替换传不到这个 token。在 `Settings/DesktopSettingsModal` story 里实测，页面是
`rgb(239,239,241)`（根节点的 card），导航栏约 94.7%：导航栏那一档消失，整个 Dialog 发灰。
`productSettingsSurfacePalette`（`lody-ui-palette.stylex.ts`）在面板上重新声明 `elevatedBackground`
和 `secondaryBackground`，让它们按面板自己的 `--card` 求值。页面重新量得 `rgb(255,255,255)`，导航栏
保留深一档，深色模式不变（替换只在浅色下生效）。

## 局限与后续

账单、外观、Agent 角色、Agents 和其他 catalog（MCP、分享、快捷指令）仍然给记录加框；之后按同一张表
逐个改，每页一个 PR。移出成员和撤回邀请现在要点两下（菜单，再点选项），原来是一个图标。

## 验证

- `Settings/AccountSettings/DesktopPaneAccount` 与 `DesktopPaneWorkspace` 在窗口作用域和材质下渲染两页。
  前（三个组件临时换回 `main`）后截图，中文，两种配色。
- `tests/account-machines-overview.test.tsx` 覆盖状态行、本机标注和唯一的“管理”按钮。
- 面板底色在 Chromium 里用 `getComputedStyle` 实测两种配色；jsdom 不计算 StyleX 样式，所以没有单元测试覆盖。
- 未在打包后的 Electron 应用中验证。

相关：[设置页的节奏与材质](2026-09-25-settings-rhythm-and-image-peek.zh.md)。
