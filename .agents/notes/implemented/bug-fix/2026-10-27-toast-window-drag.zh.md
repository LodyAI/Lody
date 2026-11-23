# 窗口拖拽条上方的 Toast 控件

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1943

[English](2026-10-27-toast-window-drag.md)

## 摘要

用户报告的 Toast 关闭按钮位于桌面窗口顶部区域。通过 portal 渲染的 Toast
卡片虽然启用了指针事件，却没有排除原生窗口拖拽，其控件仍受 Electron
窗口拖拽命中检测影响。共用 Toast 卡片现声明 `-webkit-app-region: no-drag`，
viewport 仍保持指针穿透。补丁尚未在运行中的桌面应用内验证。

## 证据与范围

现有 Tailwind 拖拽排除规则覆盖 `app-region-drag` 的后代控件，Toast portal
不在该子树内。CSS 层叠与 `pointer-events: auto` 本身无法排除原生拖拽。
排除样式放在每张可见卡片上，保留卡片间空隙的拖拽行为，同时覆盖关闭按钮和
操作按钮，不改变事件处理逻辑。

本次扩展了[反馈组件](../feature/2026-09-12-ui-feedback-primitives.md)的实现。
现有反馈组件测试覆盖关闭按钮移除通知，但 DOM 环境无法验证 Electron 原生
命中检测。已尝试包级类型检查和测试，均因缺少依赖（`@types/node` 与 `vitest`）
而无法执行；桌面指针交互验证仍待完成。
