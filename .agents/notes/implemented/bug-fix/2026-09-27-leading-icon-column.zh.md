# 选择器弹层与侧栏导航共享前导图标列

Status: implemented
Translation: current

[English](2026-09-27-leading-icon-column.md)

## 摘要

两个表面悄悄建立了各自的前导网格。桌面端 run-config 与 permission 弹层
按左边缘与触发器对齐打开，但弹层表面在行内边距之前还叠加了自身 4px 的
`popup.inset`，于是每行图标都比触发器图标右移约 4 CSS px。与此同时，侧栏
导航行（新对话／定时任务／搜索）把 16px 图标包进 20px 的 `w-5` 槽位，使
每个导航 glyph 比侧栏已有前导列（wordmark 文本、组标签与项目行共享的 +14
内容边缘）右移 2px。两处修复遵循同一契约：弹层的可见边缘保持在触发器
边缘上，而内部行回探穿过 `popup.inset`（`marginInline: -4px`，与
`composerSurface.popupList` 记录的同一回探手法），使行内前导列落在触发器
自身的列上——共享边缘加一个 item pad；导航槽位收缩为 16px 图标盒
（`w-4`），落在 +14 边缘、标签落在共享的 +38 文本列。纯图标 permission
触发器的 glyph 通过起始侧外边距同样落到共享列上；设置账户头像骑在导航
图标列的中线上。机器选择器按负责人决定保留原有几何：更早的 `alignOffset`
方案已被否决（它把整个可见表面滑出触发器），随后负责人又豁免了机器菜单
的回探修复。Playwright 实测与两条持久 e2e 规约钉住每条轴，包括弹层边缘
保持贴合这一条。

## 弹层约束

`@lody/ui` 的菜单表面把列表包在 `popup.inset`（4px）里，每行再叠加
`itemPaddingX`（8px）：行的 16px 前导图标盒从弹层左边 +12 处开始。带
文字标签的 composer 触发器内边距 8px，其前导 glyph 从触发器左边 +8 开始。
`align="start"` 使弹层左边与触发器左边重合，于是行图标落在触发器前导
位置右侧 4px；配合 14px 的触发器 glyph，比其中心右移 5px——在 2x 设备
像素下即肉眼可见的约 8–10px。

机器选择器保留的正是这套几何：弹层与触发器边缘贴合、行保留 inset——
负责人审阅各方案后豁免了它，所以那里的偏移是有意为之而非缺陷。

这个约束是双边的，这正是它不直观之处：

1. 弹层的可见边缘必须保持在触发器边缘上——弹层在空间上是触发器的
   子对象，靠滑动表面去对齐列会让它脱离父级（第一版实现犯的错）。
2. 行内前导列必须延续触发器的前导列。

inset 固化在共享表面里，两条约束一起钉死了内部几何：行前导列位于
`边缘 + itemPaddingX` = +8，因此行盒必须回探穿过这 4px inset 直到可见
边缘。这个回探是产品侧的内容盒——`composerSurface.menuList` 用
`marginInline: calc(-1 * space[1])` 包住 `Menu.Content` 的子节点——与
`popupList` 在 `Popover.Content` 里做的回探是同一手法（它的
`margin: space[1] - space[3]` 把列表拉回 popover 的 inset 线）。表面
自身的 padding 不变；`popupMenu` 的 `overflowX: hidden` 会把其中的
`Menu.Separator` 裁剪成它本就绘制的贯通线。

```text
trigger          弹层边缘 = 触发器边缘
[+8][glyph] ->   行回探穿过 inset：图标盒在 +8
                 \-> 同一 16px 盒、同一列；填充横向铺满表面
```

## 回探表达的含义

`menuList` 编码的是"弹层共享触发器的内容网格"：前导列在边缘 +8，尾部
内容在边缘 −8，行悬停填充横贯整个表面宽度（与分隔线一致——分隔线本就
贯通到弹层两缘）。

- run-config 菜单（`desktop-run-config-menu.tsx`）：带文字标签的触发器
  内边距 8px、前导 glyph 16px——`menuList` 使行图标盒精确落在同一 +8
  盒上。
- permission 菜单：纯图标触发器是 28px 方块，居中放置 16px 盒于 +6——
  这个盒行无法触及而不溢出表面。触发器改用 `iconOnlyGlyphLead`
  （`marginInlineStart: space[1]`）：按居中 margin-box 计算，其边框盒
  落在 [+8, +24]，与带标签触发器及菜单行共享的 +8 列一致。
- 机器菜单（`DesktopMachineMenu`）两者都不用：行保留 inset 的 +12 列、
  触发器保留 14px Monitor——原始状态，按负责人决定保留。

## 设置账户头像

设置导航的 `listRow` 把 16px 图标盒放在 +8..+24（中心 +16），标签在
+32。账户行的 24px `UserAvatar` 与该盒共享左边缘，中心因此右移 4px。
`surface.listRowAvatar` 用 `marginInline: -4px` 包裹头像：头像边框盒向
两侧各越过 16px 列槽 4px，中心落在图标中线上，而 margin 盒仍止于 +24，
标签保持共享的 +32 列。仅桌面入口使用；移动端账户行保持自身几何。

## 侧栏导航行

`NavButton` 曾把每个 16px glyph 包在 `h-5 w-5`（20px）槽位里，置于 `px-2`
按钮、`px-1.5` 列之中：图标盒 +16、墨色约 +18、标签 +42。侧栏其余前导
元素都用 +14 内容边缘——wordmark 文本（墨色 +14.5）、会话行前导槽
（+15）、项目文件夹图标（盒 +14／墨色 +15.5）以及下方的 +38 文本列。
槽位改为 `w-4`：16px glyph 填满槽位，图标盒落在 +14，中心 +22（恰为
会话行前导槽中心），墨色 +15.5-16 与文件夹图标一致，标签落在共享的
+38 列。高度保持 `h-5`（20px），行的视觉线不变。

同一改动让三个导航行都出现在 Story 中：`LoroSidebar` 的 story 此前未传
`onSchedulesClicked`（生产环境总是传入），导致定时任务行在所有 story
截图中不可见。

## 备选方案

- 用 `alignOffset={-4}`（permission 为 -6）把整个弹层滑回 `popup.inset`：
  图标对齐了，但可见表面整体移出触发器——弹层边缘悬在空白画布上，肉眼
  可见地脱离父级。在视觉评审中被否决；偏移属于内容而非表面。
- 改为把触发器前导 glyph 挪到弹层的 +12 列（再垫深 4px）：菜单不动，但
  选择器芯片相对相邻芯片变成 12/8 不对称，而 28px 纯图标触发器把 glyph
  放到 +12 会明显顶到自己边缘。否决；应让弹层跟随触发器的列，而不是
  反过来。
- 把 `popup.inset` 缩到 0 或把行 padding 改成 4px：会全局改动所有菜单
  表面的外沟槽，不只是选择器弹层。范围过大，否决。
- 逐行改前导槽（对 `Menu.Item` 用 `paddingInlineStart`）：行自身 padding
  属于 `@lody/ui` 的视觉设计，调用方 className 不可重设。否决；
  回探外边距才是调用方自有的部分。
- 侧栏：不改槽位、改行的 `px-2`（`pl-1.5`）——图标盒位置相同但保留
  20px 不可见框，且标签落在 +40，偏离共享的 +38 文本列。否决；
  多余的槽位 padding 才是缺陷。

## 验证

- `LockedAgent` story：run-config 弹层边缘 48 = 触发器边缘 48，Plan/Fast
  图标盒在 +8；permission 弹层边缘 207.5 = 触发器边缘 207.5，行图标中心
  在 +16 = 经起始侧外边距调整后的触发器 glyph 中心。
- `DesktopSettingsModal` preferences story：账户头像中心修复前 134.4 vs
  导航图标中线 130.4；修复后头像中心精确等于 130.4，标签仍在 +32 列。
- `LoroSidebar` 默认 story：导航图标墨色修复前 17.5 vs wordmark 轴 14.5；
  修复后图标盒 +14 = wordmark 文本边缘，墨色 +15.5 与项目文件夹一致，
  三个标签都落在 +38 文本列。
- `composer-submission-focus.spec.ts` 对 run-config 与 permission 菜单
  同时断言：弹层左边缘与触发器左边缘差 ≤0.75px（表面不脱父），且每行
  前导图标中心与触发器 glyph 中心差 ≤0.75px——在修复前代码与被否决的
  `alignOffset` 变体上均失败。机器用例被有意省略：选择器保留自身网格
  时不钉任何断言。
- `sidebar-nav-leading-column.spec.ts` 钉住每个导航图标盒左边缘与
  wordmark 文本边缘一致、标签在轴 +24——在修复前代码上以恰好的 2px
  槽位 padding 失败。

## 限制

- 契约按表面生效且明确不完整：机器选择器按负责人决定豁免（其弹层保留
  inset 网格），其他 `align` 对齐的 `Menu.Content` 弹层尚未审计；应用该
  规则意味着用 `menuList` 包住行、并让触发器前导标记落在同一 +8 盒上——
  项目选择器的搜索弹层（`unified-project-selector.tsx`）是同类偏移的
  已知遗留。
- 这些菜单的行悬停填充现在触及弹层横向两缘（与分隔线本就贯通的画法
  一致）：这是消耗 inset 的可见代价，也正是"弹层是触发器的子对象"
  应有的样子。
- 容差为亚像素级（0.75–1px）：弹层锚定落在小数坐标上，不同环境可能差
  1 CSS px 以内；glyph 墨色在盒内本就内缩约 2px。
- `tsgo` 类型检查在本 worktree 的无关文件中报告约 321 个历史遗留
  `TS7006` 错误（干净树上数量一致）；均不涉及本次改动文件。
