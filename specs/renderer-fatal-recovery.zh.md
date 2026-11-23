# 桌面端渲染进程致命故障恢复

Status: draft
Translation: current

[English](renderer-fatal-recovery.md)

## 场景

当 Electron 报告产品渲染进程意外退出，或内部 React 错误边界捕获到渲染错误时，用户需要一个稳定的错误页面，以便有足够时间阅读或复制诊断信息。后台自动刷新或错误边界自动重置会抹去这些证据，并可能在错误上报离开设备前终止它。

## 行为

Electron 主进程会在本地记录渲染进程退出，并从仍然存活的进程发送尽力而为、低基数的异常报告。随后它打开包含崩溃原因和退出码的恢复页面。恢复页面不得自动重新加载产品渲染进程。

React 错误边界会捕获并上报渲染错误；即使其 `resetKeys` 改变，也保持可复制的后备界面。只有用户明确选择 Retry 或 Reload，才可以清除该后备界面或导航产品渲染进程。错误上报是尽力而为的：网络不可用或本地专用构建禁用遥测都不会改变恢复行为，也不会阻止用户复制信息并刷新。

## 窗口无响应

卡顿与渲染进程崩溃分开处理。主进程立即记录事件、窗口可见性和后台节流状态、
渲染进程 PID、应用/Electron 版本以及进程 CPU/内存，并请求 JavaScript 调用栈，
不依赖渲染线程正常执行事件循环。只有受信任的产品主文档允许抓栈，外部页面和
嵌入子框架不允许。所有产品窗口共享会话响应头钩子；后续响应头策略必须与其组合，不能覆盖。

持续无响应 10 秒才询问用户。恢复、导航和关闭使该次卡顿失效。弹窗可能比卡顿
持续更久：此时选择 Wait 不得重新为已恢复的卡顿计时。新卡顿具有独立事件编号；
每个窗口同时最多一个弹窗。Reload 和退出仍由用户明确选择。

诊断只保存在 Electron 日志目录：`renderer-hang.jsonl` 及一份轮转文件（各 2 MiB），
以及最近五份 macOS 线程采样（各不超过 2 MiB）。JS 栈最多 64 Ki 字符，五秒超时；
每个 WebContents 最多保留一个未结束请求。原生采样持续两秒，八秒截止，整个应用
每分钟最多尝试一次。失败、超时、平台不支持和限频都会记录。诊断不阻塞恢复，
不上传调用栈。生命周期日志区分首次检测、弹窗、用户选择、恢复与导航。

调用栈能定位正在执行的 bundle 函数和位置；还原原始源码名称可能需要匹配构建的
source map。没有 JS 栈时，原生采样帮助分析 GC、渲染或原生等待。单次采样或
抓取超时本身不构成根因证明，新埋点也无法还原此前没有采集的历史卡顿。

## 证据

- [崩溃分类](../apps/electron/src/main/renderer-process-gone.ts)
- [窗口事件接线](../apps/electron/src/main/window.ts)
- [恢复页面](../apps/electron/src/renderer/src/recovery-entry.ts)
- [确定性分类测试](../apps/electron/src/main/renderer-process-gone.test.mjs)
- [React 边界](../packages/components/src/components/error-boundary.tsx)
- [手动边界恢复测试](../packages/components/tests/error-boundary-manual-recovery.test.tsx)
