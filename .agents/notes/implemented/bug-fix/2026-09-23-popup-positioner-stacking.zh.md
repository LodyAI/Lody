# 弹层的 z-index 属于 positioner，不属于 popup

Status: implemented
Translation: current

[English](2026-09-23-popup-positioner-stacking.md)

相关：[UI Radix 调用点迁移](../feature/2026-09-22-ui-radix-callsite-migration.zh.md)

## 摘要

Radix 迁移到 `@lody/ui` 之后，所有菜单、popover、select、combobox 和
tooltip 都渲染在任何带正 `z-index` 的 shell 元素**之下**——E2E 抓到
composer 的 `z-10` textarea 把 run-config 菜单完全盖住，菜单项无法点击。
根因是层叠声明放在 positioner 内部的 popup 上：`position: fixed` 的
positioner 本身就是层叠上下文，内部 `z-index` 只排序兄弟节点，而
positioner 自己以 `z-index: auto` 参与竞争，低于所有正数层级。修复把每个
浮动家族的 `z` token 移到各自的 positioner 样式上：`surface.positioner`
为所有 popup 家族的 Content 统一声明这条规则，tooltip 的 chip 在自己的
`z.tooltip` 层级上做同样处理。

## 发现过程

`pnpm e2e:smoke`（真实 Electron）中 `LODY-WORK-001` 失败：Playwright 解析到
`Agent` 菜单项可见且稳定，但其中心点的 `elementFromPoint` 返回 composer
textarea。截图显示菜单绘制在 composer `z-10` 表面之下。

drawer 其实早已学过这条规则——`dialog/surface.ts` 在 `drawerViewport` 上有
注释（"the stacking belongs here, not on the panel"）——但 popup 家族的
`z.popover` 写在内层 `surface.popup` 上。positioner 才是 Base UI 设为
`position: fixed` 的元素；按 CSS 绘制顺序，正 `z-index` 层叠上下文永远绘制
在 `z-index: auto` 的定位元素之上，与 DOM 顺序无关，所以页面里所有 `z-*`
元素都赢过了所有弹层。

## 改动

- `popup/surface.ts` 新增 `surface.positioner`（`outlineStyle: none` +
  `zIndex: z.popover`）并写明层叠理由；`surface.popup` 移除 `zIndex`。
- 五个 popup 家族 `Content`（`Menu`、`ContextMenu`、`Popover`、`Select`、
  `Combobox`）改用 `surface.positioner`，删掉各自文件里
  `{ outlineStyle: 'none' }` 的 positioner 样式。
- `tooltip/chip.ts` 同样把 `z.tooltip` 从 chip 移到 positioner。
- dialog 表面本来就正确：backdrop 和 panel 自身就是 fixed 元素，drawer
  viewport 自带 `z.dialog`。

## 同一轮修复的伴随回归

smoke 还暴露出两个同源的回归——迁移后丢失了原来免费获得的语义：

- `Dialog.Content` 默认渲染关闭按钮；三个原先使用
  `DialogContentWithoutClose` 的迁移调用点补回 `closeButton={false}`
  （设置弹窗、composer 文本预览、session 文件预览及其 story）。
- Base UI 的 `RadioItem`/`CheckboxItem` 默认 `closeOnClick={false}`
  （原生勾选菜单语义），而所有 `Menu.RadioItem` 调用点都是"选一个即完成"
  的选择器，Radix 下会关闭。`@/ui/menu` 适配层现在把 `MenuRadioItem` 的
  `closeOnClick` 默认设为 `true`；checkbox 行保持不关闭的默认。
- Base UI 的 Escape 一次只关一层菜单（`closeParentOnEsc` 需显式开启），
  所以 work-session 页面对象改为按 Escape 直到 `[role="menu"]` 清零，
  而不是只按一次。run-config 菜单的 `OptionItem` 有意保持菜单打开
  （`closeOnClick={false}`），父菜单在子菜单的 Escape 后仍然存在是合法状态。

## 验证

`pnpm e2e:smoke` 五个 P0 场景在真实 Electron 下全部通过；`pnpm check`、
`pnpm format`、`pnpm run docs check` 和边界守卫全绿。除 Electron 套件外
未做浏览器端验证。
