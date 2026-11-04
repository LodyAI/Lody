# 缓存 Claude 运行时归档所用的 Linux libc 报告

Status: implemented
Translation: current

[English](2026-10-11-musl-report-cache.md)

## 摘要

在 Linux 上，每次解析 Claude 托管运行时归档都会调用 `process.report.getReport()`，同步为整个进程做一次快照。能力刷新在判断已保存的 ACP 能力条目是否仍新鲜时仍会做这次解析，因此缓存命中也避不开这份开销。对变慢的守护进程采样时，大部分 CPU 落在这次调用上。那台机器上把 musl 检查改成按进程记忆的本地热补丁减轻了卡顿，因此分类结果现在在进程的整个生命期内只保存一次。归档选择保持不变：只有 Linux 上的 Claude Code 会追加 `-musl`，而且仅当报告里没有 glibc 运行时版本。抛出的报告不会被记住。这项改动不处理守护进程的其他卡顿。

## 问题

Discord `#feature-or-bug` 的 “Daemon Stall” 讨论（Leynos）报告：Linux 上的 Lody 守护进程变慢，机器交互也随之变慢。定时器延迟最高约 24.5 秒，并出现同步超时。日志里有密集的能力刷新和事件循环滞后。采样中 64%–100% 的 CPU 在 `process.report.getReport()` 内。空的 Node 进程每次调用约 9.5 毫秒；负载更高的守护进程更慢。本地把 musl 检查改成记忆化之后，卡顿明显减轻。

当前 `main` 上的调用链是：

`refreshMachineAcpCapabilitiesForConfig` → `readFreshAcpCapabilityCacheEntry` → `resolveExpectedAcpCapabilitySourceVersion`（以 `resolveAcpCapabilitySourceVersion` 接入）→ `getRuntimeStatus` → `resolveArchive` → `mapManagedRuntimePlatform` → `isMuslLibc` → `process.report.getReport()`。

`isMuslLibc` 只在映射平台为 `linux` 且运行时为 `claude-code` 时执行。这仍然在热路径上：能力缓存命中前必须先解析期望的源版本，而该解析会向托管运行时查询归档。[能力条目缓存](2026-09-16-acp-capability-refresh-cache.zh.md) 停掉的是 ACP 进程探测，不是这次查询。

进程运行期间宿主 libc 不会改变。重复做快照也不会改变归档名称。

## 决定

`isMuslLibc` 记住进程内第一次成功的分类。Darwin 和 Windows 保持非 musl，并且不读取报告。Linux 上若 `header.glibcVersionRuntime` 有值，选择 glibc 的 Claude 归档（`linux-x64`、`linux-arm64`）。Linux 上若没有报告函数、没有 header，或没有 glibc 运行时版本，选择 `linux-x64-musl` 或 `linux-arm64-musl`。其他运行时名称不会带这个后缀。`getReport` 抛错时错误继续向外传递，下次调用再试，因此一次短暂失败不会被记成错误的归档。

不需要换成更便宜的 libc 探测。已经验证有效的修法是把这个稳定答案读一次。在能力路径上跳过归档解析会改变新鲜条目的识别方式，不属于这次改动。

`apps/cli/src/agent/AGENTS.md` 已经顶到文档体积上限（8190 字节，上限 8192），因此规则记在这里：不要在每次 Claude 归档查询时调用 `process.report.getReport()`。

## 验证与限制

单元测试预设 musl 与 glibc，并检查 Claude、Codex、Grok、Kimi、darwin 和 win32 的归档名。在 Linux 宿主上还检查成功的报告只读一次、不会进行第二次读取，以及抛出的报告不会被记住。本环境里一次空闲的 `getReport()` 大约 11 毫秒，与报告中的单次开销相符，并不是对 24.5 秒守护进程卡顿的复现。Loro 文档加载、历史写入、用量扫描和 worker 线程压缩不在这次改动内。

PR: https://github.com/LodyAI/Lody/pull/1436
