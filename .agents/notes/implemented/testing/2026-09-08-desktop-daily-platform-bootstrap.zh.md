# Desktop Daily 平台启动修复

Status: implemented
Translation: current

[English](2026-09-08-desktop-daily-platform-bootstrap.md) | 中文

## 摘要

首次定时运行的三平台 Desktop Daily 把互不相关的 Windows 与 Linux 基础设施故障汇总到同一张 Issue。Windows 仅因 checkout 换行符不同而拒绝生成的 coverage，Linux 则在启动 Electron 前丢弃了 Xvfb 授权路径。现在 coverage 检查将 CRLF 与 LF 视为相同的生成内容，隔离后的 Electron 环境会保留 `XAUTHORITY`。这恢复了平台启动，同时没有放宽 registry 校验，也没有扩大应用继承的进程环境范围。

## 证据

commit `a07eeba2bf97faa40ba501000ab9c3296dc4a031` 上的
[Daily run 34197006995](https://github.com/LodyAI/Lody/actions/runs/34197006995)
是 [PR 459](https://github.com/LodyAI/Lody/pull/459) 将 Linux 和 Windows 加入矩阵后的首次定时运行。macOS 通过。Windows 停在 suite contract，因为 CRLF checkout 与 `renderCoverage()` 返回的纯 LF 字符串不相等；registry 与生成的 Markdown 除此之外完全一致。

四个 Linux scenario 都在窗口打开前失败。Electron 先记录
`Authorization required, but no authorization protocol specified`，随后记录 X11 平台初始化失败。`xvfb-run` 提供了 `DISPLAY` 和临时 `XAUTHORITY`，但
[`createIsolatedEnvironment()`](../../../../e2e/src/support/electron-harness.ts)
只保留了前者。Linux artifact 包含四行 `failure-index.json`，因此这些失败共享同一个启动边界，并非四个产品断言分别回归。

## 决策

[`coverageMatchesRegistry()`](../../../../e2e/scripts/journey-registry.mjs)
在比较生成 coverage 前将 CRLF 规范化为 LF。其他内容差异仍会失败，包括新增文本、缺失行，以及并非 Windows 换行符导致的空白差异。suite checker 和独立 coverage checker 都使用这一契约。

Electron harness 只把 `XAUTHORITY` 加入继承环境 allowlist。把 runner 的整个环境传给应用进程及其子进程会暴露无关 CI 变量。保留 allowlist 既维持隔离边界，也允许 Electron 向 `DISPLAY` 指定的 X server 完成认证。

## 报告限制

[Issue 507](https://github.com/LodyAI/Lody/issues/507) 声称索引到零个 scenario，是因为 Daily reconciler 按既定策略选择了成功的 macOS artifact 作为 canonical evidence；失败的 Linux artifact 实际包含全部四个 scenario ID。本次变更修复平台故障，不改变 PR 459 引入的 macOS 优先报告策略。按平台聚合 failure 仍是独立工作。

## 验证

单元测试证明 CRLF 生成内容能够匹配，而内容变化仍会失败；也证明 `DISPLAY` 和 `XAUTHORITY` 会通过 Electron allowlist，无关变量不会。macOS 本地验证无法复现 GitHub-hosted Xvfb session，因此 Linux Actions run 仍是端到端证明。
