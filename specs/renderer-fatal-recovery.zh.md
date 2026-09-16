# 桌面端渲染进程致命故障恢复

Status: draft
Translation: current

[English](renderer-fatal-recovery.md)

## 场景

当 Electron 报告产品渲染进程意外退出，或内部 React 错误边界捕获到渲染错误时，用户需要一个稳定的错误页面，以便有足够时间阅读或复制诊断信息。后台自动刷新或错误边界自动重置会抹去这些证据，并可能在错误上报离开设备前终止它。

## 行为

Electron 主进程会在本地记录渲染进程退出，并从仍然存活的进程发送尽力而为、低基数的异常报告。随后它打开包含崩溃原因和退出码的恢复页面。恢复页面不得自动重新加载产品渲染进程。

React 错误边界会捕获并上报渲染错误；即使其 `resetKeys` 改变，也保持可复制的后备界面。只有用户明确选择 Retry 或 Reload，才可以清除该后备界面或导航产品渲染进程。错误上报是尽力而为的：网络不可用或本地专用构建禁用遥测都不会改变恢复行为，也不会阻止用户复制信息并刷新。

## 证据

- [崩溃分类](../apps/electron/src/main/renderer-process-gone.ts)
- [窗口事件接线](../apps/electron/src/main/window.ts)
- [恢复页面](../apps/electron/src/renderer/src/recovery-entry.ts)
- [确定性分类测试](../apps/electron/src/main/renderer-process-gone.test.mjs)
- [React 边界](../packages/components/src/components/error-boundary.tsx)
- [手动边界恢复测试](../packages/components/tests/error-boundary-manual-recovery.test.tsx)
