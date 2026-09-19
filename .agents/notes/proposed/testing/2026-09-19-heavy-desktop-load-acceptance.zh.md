# 重型桌面负载验收套件

Status: proposed
Translation: current
Language: [English](2026-09-19-heavy-desktop-load-acceptance.md)
PR: https://github.com/LodyAI/Lody/pull/827

## 摘要

PR #811 主要只用空 workspace 验收，无法暴露真实持久化会话和长消息列表的成本。本提案增加一条确定性的合成重载线：通过真实本地 Electron/CLI/ACP 路径灌入会话，在隔离 profile 中重新打开，并同时记录用户可见的 ready 状态、帧时间线和资源证据。第一阶段的有界 `pnpm e2e:load` 已实现；并发矩阵、soak 运行和契约化阈值仍未验证。

## 决策

将负载生成与用户表面取证分开：

- `e2e/src/support/fixtures/load-scripted-acp.mjs` 按测试 prompt 的大小提供确定性的本地 ACP 响应。
- `e2e/src/support/fixtures/load-session-fixture.ts` 负责合成持久化会话，不包含用户或 agent transcript。
- `e2e/src/load/load-runner.ts` 创建唯一 profile，关闭后重新启动同一 profile，再通过真实路由逐个打开所有会话。
- `apps/electron/src/preload/boot-profiler.ts` 在 route bundle 之前启动；只有设置 `LODY_E2E_BOOT_PROFILE=1` 时才记录启动节点、可见文字、背景色和空白帧。
- `e2e/src/support/electron-harness.ts` 将启动、运行时、日志、截图和 Playwright trace 写入被忽略的产物目录。

默认负载有界（24 个 session，正文大小为 1/8/64 KiB）；更大规模必须显式 opt-in。每轮运行都使用临时 Electron user-data、Lody data、本地 CLI endpoint 和独立产物目录。`LODY_E2E=1` 会保持 PR #811 的 warm pool 关闭，因此这条验收线独立测量重型 workspace baseline；warm-window 实现细节见[实现 Note](../../implemented/feature/2026-09-18-desktop-window-prewarming.zh.md)。

## Baseline 证据

第一轮 macOS baseline 成功重新打开 24/24 个持久化会话。workspace shell 在 465 ms 出现，composer 在 491 ms 可编辑，代表性正文在 1,139 ms 出现。seed 阶段 renderer RSS 约 697 MB、JavaScript heap 约 166 MB；reopen 阶段约 618 MB RSS、181 MB heap。preload 帧 trace 观察到 reopen 期间约 360 ms 的连续无文字帧。这些是用于对比的观测值，不是验收阈值。

## 边界与后续

第一阶段覆盖持久化会话负载、帧/空白表面采样、资源快照、截图和可重放 JSON 输出；尚未覆盖并发窗口、30/60 分钟 soak、进程替换故障注入或跨平台阈值契约。后续应复用同一隔离 fixture，并先建立独立的用户可见 oracle，再把阈值设为阻断条件。

## 参考

- [LobeHub acceptance process](https://github.com/lobehub/lobehub/blob/canary/.agents/acceptance/PROCESS.md)
- [LobeHub desktop boot profiler](https://github.com/lobehub/lobehub/blob/canary/apps/desktop/src/preload/bootProfiler.ts)
- [LobeHub chaos contracts](https://github.com/lobehub/lobehub/tree/canary/packages/achaos)
