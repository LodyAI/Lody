# 分享图片功能覆盖移动端

Status: implemented
Translation: current

[English](2026-09-18-mobile-share-as-image.md)

## 摘要

分享对话图片此前只在桌面端验收过：移动端会话菜单里没有入口，移动端
`SessionDetail` 分支也从未挂载预览组件，因此该功能在手机上完全不可达——尽管
`ChatShareImageDialog` 本身已经带有一个符合 spec 的底部 Drawer 分支。修复落在组合层
而不是新组件：移动端菜单增加一个扁平动作，移动端返回路径补上一个挂载点。接线过程
中暴露出桌面端从未遇到的手机约束：会话左边缘属于会话抽屉的侧滑返回区
（`EDGE_ZONE_PX`），而选择复选框恰好作为点击目标放在那里。移动端上复选框改为内缩的
被动状态徽标，整行保持为点击目标——与移动端列表自带的多选行同款拆分——选择工具栏的
按钮也改用默认尺寸而非 `sm`。

## 发现

缺口不在预览组件本身。`ChatShareImageDialog` 早已写好 `Drawer` 分支（`h-[92dvh]`、
抓手条、居中标题、关闭按钮、弹性预览区、safe-area 底部），由 `useIsMobile()` 切换，
与 spec 的"桌面用 dialog、手机用底部 drawer"一致。缺的是它周围的一切：
`session-detail.tsx` 里移动端的 `mobileMenuActions` 列表在 Copy URL 就结束了，移动端
返回路径挂载了所有会话对话框唯独缺这一个。选择能力本身已经是共享的——
`SessionChatInterface` 暴露 `startShareImageSelection`，并在两个端上都在 composer 位置
渲染 `MessageSelectionToolbar`。

## 决策

移动端菜单在 Copy URL 之后增加一个扁平的 `share-image` 动作，仅当聊天界面确实在屏
幕上时显示（`!activeDraftTab && !hasActiveViewerTab`）——这正是桌面端头部菜单隐式依
赖的条件，因为该动作会在已挂载的会话里启动选择。处理函数原样复用
`handleShareAsImage`；预览挂载原样复用 `shareImageTarget` 与
`handleShareImageCompleted`，桌面与移动端共享同一状态机与同一条完成路径（确认 →
复制/导出 → 取消选择 → toast）。

复选框不能留在原位。`EDGE_ZONE_PX` 把左边缘留给了侧滑返回，`left-0` 的可交互复选框
在手机上既点不到又会被视觉裁掉——而且 `VList` 的 `contain: strict` 让行内元素无法像
composer 那样叠到手势区之上。`mobile-project-screen` 的移动端多选行早已解决了同
样的问题：复选框变成只展示状态的非交互徽标，整行承担点击。选择行采用同样的拆分——
仅移动端使用 `left-3`、`pointer-events-none`、`aria-hidden`、`tabIndex=-1`——工具栏按钮
取默认尺寸，与 Drawer 自己的动作行对主要触控目标的取舍一致。徽标本身仍留在手势区
内，这之所以成立是因为它是被动的："左缘控件必须内缩超过 `EDGE_ZONE_PX`"这条规则约
束的是点击目标，而这里的点击目标是整行。

## 取舍与限制

被动徽标意味着移动端用户不能直接点复选框本身，整行是唯一目标——这是本仓库手机端的
既有惯例，但与桌面端是有意的差异。菜单动作在 viewer tab 或草稿激活时是隐藏（而非禁
用），与周围动作的行为一致——空 tab 仍然会弹出"no conversation"提示，与桌面端相同。
已通过 typecheck 与既有的 message-selection/export 测试验证；drawer 与 dialog 分支目前
没有行为测试，属于 Storybook 验证的状态。
