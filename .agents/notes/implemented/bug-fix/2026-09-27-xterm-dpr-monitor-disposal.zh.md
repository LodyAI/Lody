# 随 xterm 浏览器服务销毁设备像素比监视器

Status: implemented
Translation: current

[English](2026-09-27-xterm-dpr-monitor-disposal.md)

## 摘要

反复打开、关闭工作终端时，xterm.js 的设备像素比监视器仍挂在窗口上。窗口 resize 与媒体查询监听器在终端销毁后继续存活，使桌面 Scout 的监听器数量逐轮增加。针对 `@xterm/xterm@5.5.0` 的版本限定补丁参照 [xterm 上游修复](https://github.com/xtermjs/xterm.js/commit/b0667aacca4cc1d0c14d57bb6f51333bd03fecea)，把监视器注册到所属的 `CoreBrowserService`。补丁同时修改发布的运行时代码和随包源码；将来升级到包含该修复的依赖版本时，应移除补丁。

## 证据与决定

[Issue #441](https://github.com/LodyAI/Lody/issues/441) 是自动生成的非阻塞候选，因此不能仅凭堆增长认定泄漏。三次独立定时 [Scout 运行 35501078002](https://github.com/LodyAI/Lody/actions/runs/35501078002)、[35583886345](https://github.com/LodyAI/Lody/actions/runs/35583886345) 和 [35707757731](https://github.com/LodyAI/Lody/actions/runs/35707757731) 都显示工作终端每经历一次生命周期就多出两个渲染进程监听器。当时的工作场景堆分析在三次预热和三十次正式迭代后发现 33 个未销毁的监视器对象，每个都保留一个 resize 监听器和一个媒体查询监听器。[后续运行 36231521406](https://github.com/LodyAI/Lody/actions/runs/36231521406) 仍报告工作场景监听器上升；合计增加的 67 个包含其他活动，不能单独归因到每次终端创建。

xterm 5.5.0 的 `CoreBrowserService` 创建 `ScreenDprMonitor` 时未将它注册为子级 disposable。监视器自身注册了监听器，但服务销毁时不会调用它的 `dispose`。把这一子对象注册到服务，保持终端行为并补齐生命周期归属。若在 Lody 应用层绕过，只能触及 xterm 内部对象，无法可靠持有这些监听器。版本限定的 pnpm 补丁只修改发布包，并注明上游来源。

## 验证与边界

补丁可干净应用到已安装的 `@xterm/xterm@5.5.0` 包。仓库检查和补丁后的 Scout 结果须另行记录；原 issue 中的堆趋势不能证明所有渲染进程增长已消除。本说明也不将 Scout 候选信号提升为阻塞门槛。
