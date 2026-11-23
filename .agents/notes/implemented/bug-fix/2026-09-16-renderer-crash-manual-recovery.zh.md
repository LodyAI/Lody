# 渲染进程崩溃后等待用户再重试

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/742

[English](2026-09-16-renderer-crash-manual-recovery.md)

## 摘要

Electron 渲染进程崩溃会销毁通常用于上报前端异常的进程，而 Electron 或 React 错误边界的自动重试都会在用户分享前移除诊断信息。现在主进程会对原生退出进行分类，React 错误边界在 `resetKeys` 改变时仍保留可复制的后备界面；二者都会等待用户明确选择恢复操作。本地专用构建仍禁用遥测，PostHog 不可达时上报仍是尽力而为；代价是用户需要自己选择 Retry 或 Reload。

## 决策

`render-process-gone` 由纯分类器处理，因此无需 Electron 运行时就能确定 clean-exit 路径、遥测形状和恢复负载。每次非正常退出时，`window.ts` 会在加载已有恢复页之前启动已有的主进程 PostHog 异常捕获。报告只包含来源、Chromium 原因和数字退出码；它避免包含可能带有用户数据的渲染内容和诊断信息。

恢复页不是产品刷新。它是一个最小、独立的界面，展示原因和退出码、持久化完整的本地诊断记录，并让 Reload 按钮始终由用户发起。共享的 React `ErrorBoundary` 遵循相同规则：其 API 仍接受 `resetKeys`，但它们不能清除已捕获的错误；只有可见的 Retry 或 Reload 操作才能清除。这与等待渲染进程侧的 PostHog 不同：原生崩溃的进程已经不在了，而 React 边界可以在异常客户端 flush 时保持错误可见。

没有按钮的边界需要由其拥有者提供用户操作。引导阶段的工作区 slug 探针查询出错后会刻意渲染 `null`，因为表单拥有内联诊断与 Retry 按钮；该按钮现在会在重新挂载探针前调用边界的公开 reset 方法。在此契约下交给 `resetKeys` 会使 Retry 无效，并让必经的引导步骤无法继续。
聊天目标选择器则在边界后备界面中直接渲染紧凑的 Retry 控件，因此瞬态选择器故障无需刷新页面也能恢复。

## 考虑过的替代方案

**让已经失败的渲染进程在刷新前上报。** 被终止的进程无法可靠运行 JavaScript 或 flush 网络请求，因此无法让原生崩溃路径可靠。

**固定延时后自动重试。** 不采用，因为它会移除可复制的上下文，并可能在用户有机会处理前重复同一个边缘情况。

## 验证

`renderer-process-gone.test.mjs` 覆盖了 clean-exit 排除和崩溃负载，包括稳定的遥测字段与恢复详情。`error-boundary-manual-recovery.test.tsx` 证明 reset-key 变化会保留崩溃页，且只有用户重试才会渲染健康子树，并覆盖后备界面提供的恢复操作。`workspace-screen.test.tsx` 证明无按钮的 slug 探针会通过表单拥有的 Retry 操作恢复。尚未在打包桌面构建中强制制造真实的渲染进程崩溃。
