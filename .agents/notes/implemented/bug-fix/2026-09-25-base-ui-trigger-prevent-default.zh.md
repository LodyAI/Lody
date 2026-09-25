# Base UI 触发器忽略 `preventDefault`，需用 `preventBaseUIHandler`

Status: implemented
Translation: current

[English](2026-09-25-base-ui-trigger-prevent-default.md)

## 摘要

设置弹窗触发器迁移到 `@lody/ui`（Base UI）之后，双击「关于」页中的「查看声明」
不再能揭示开发者模式：第一次点击就打开了开源许可弹窗，第二次点击落在了弹窗
背板上。Base UI 会合并用户 handler 与内部 handler，而 `event.preventDefault()`
并不能阻止内部 handler——只有 Base UI 自己的 `event.preventBaseUIHandler()`
才能退出。现在触发器在 `onClick` 中调用它，并保留延迟 400ms 的单击打开逻辑，
使双击可以取消待打开的弹窗并揭示开发者模式行。已通过 Storybook + Playwright
验证：双击揭示该行且不再打开弹窗，单击仍会正常打开弹窗。

## 决策与归属

`OpenSourceAttributionsDialog` 拥有点击时序约定：单击在 400ms 后执行
`setOpen(true)`，`onDoubleClick` 清除定时器并调用调用方的揭示回调。新增的
关键点是 `onClick` 中的 `preventBaseUIHandler()` 调用——通过类型断言访问，
因为 Base UI 把该方法挂在合并后的事件上，但 React `MouseEvent` 类型并不暴露它。

曾考虑过只依赖延迟定时器、让 Base UI 内部 handler 照常运行——但内部 handler
会在第一次点击时立即打开弹窗，定时器无法拦截，手势依旧失效。因此必须调用
`preventBaseUIHandler` 才能让定时器真正接管打开时机。

同一改动还把桌面运行配置菜单加宽（`min-w-48` → `min-w-60`，约 194px → 240px）
避免内容拥挤，并移除了独立权限模式菜单中重复的 `Menu.GroupLabel`（其触发按钮
本身已带「权限」标签）。

## 证据与验证

- [归因弹窗触发器](../../../../packages/components/src/components/settings/open-source-attributions-dialog.tsx)
- [运行配置与权限菜单](../../../../packages/components/src/components/sessions/desktop-run-config-menu.tsx)
- [About 页揭示接线](../../../../packages/components/src/components/settings/about-setting.tsx)

针对 Storybook 故事 `sessions-composerrunconfigmenu--menu` 与
`settings-desktopsettingsmodal--about-tab` 做了 Playwright 前后对比：运行配置
菜单宽度由 193.58px 变为 240px；权限菜单去掉了重复标题；双击结果由「弹窗打开、
行仍隐藏」变为「行被揭示、弹窗保持关闭」；单击仍会在延迟后打开归因弹窗。
范围内 `tsgo` 类型检查、`oxlint`、`oxfmt --check` 与 `pnpm run docs check`
均通过。双击窗口是真实时钟定时器，故该行为以 Playwright 验收为准，未补单测。
