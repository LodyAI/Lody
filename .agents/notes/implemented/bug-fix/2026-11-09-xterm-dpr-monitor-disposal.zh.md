# 随终端所属服务销毁 DPR 监视器

Status: implemented
Translation: current

[English](2026-11-09-xterm-dpr-monitor-disposal.md) | 中文

## 摘要

关闭 xterm 5.5.0 终端后，设备像素比监视器仍然存活，保留窗口与媒体查询监听器。11 月 8 日 Desktop Scout 堆快照独立证实，三次预热和三十次正式终端生命周期后仍有 33 个未销毁的监视器。版本限定的 pnpm 补丁参照上游修复，把监视器注册到所属浏览器服务。真实 Chromium 对照验证中，三十次终端生命周期的监听器增长从 60 降为零；Scout 的其他堆和 RSS 增长尚未归因。

## 证据与决定

[Issue #441](https://github.com/LodyAI/Lody/issues/441) 是非阻塞趋势报告，本身不能证明泄漏。[11 月 8 日 Scout 产物](https://github.com/LodyAI/Lody/actions/runs/42473762994/artifacts/13615014122) 的工作场景清理后渲染进程堆中，有 33 个同时包含 `_resolutionMediaMatchList`、`_windowResizeListener`、`_outerListener`、`_isDisposed: false` 的对象。这独立验证了 issue 历史评论中的调查。

`CoreBrowserService` 创建 `ScreenDprMonitor` 时未注册其销毁。监视器拥有窗口 resize 和 DPR 媒体查询两个监听器。将它注册为子级 disposable，即可通过现有终端销毁路径释放两者。补丁同时修改发布包运行时代码与附带 TypeScript 源码，参照 [xterm 上游修复](https://github.com/xtermjs/xterm.js/commit/b0667aacca4cc1d0c14d57bb6f51333bd03fecea)，并注明 [Dante-dan 原始回移补丁](https://github.com/Dante-dan/Lody/commit/db482104d0fe4e731f40242c97818e07cb752478) 的贡献。应用层访问 xterm 私有字段会把清理职责放到错误的组件。升级到含上游修复的版本时应移除补丁。

## 验证与边界

在各自全新的真实 Chromium 页面中，三次预热后再执行三十次 `Terminal.open`/`dispose` 并显式 GC，原始发布包增加 60 个 JS 事件监听器，补丁版增加 0 个。提交的浏览器回归检查 GC 后监听器数量回到预热基线。这是确定性的窄生命周期断言，不是内存上限，也没有调整 Scout 阈值。

其余渲染进程堆与 RSS 斜率需要另行归因；该结果不能证明所有资源趋势都已解决。补丁后完整构建桌面的 Scout 仍是集成验证项。
