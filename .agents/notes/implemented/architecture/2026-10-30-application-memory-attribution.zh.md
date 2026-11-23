# Session GC 的本地目标查询

Status: implemented
Type: architecture
Translation: current
PR: [#2118](https://github.com/LodyAI/Lody/pull/2118)

[English](2026-10-30-application-memory-attribution.md)

## 摘要

GC 根据最新的持久化目标，判断空闲 Session 是否需要保留 Agent。本地后端现在直接检查该目标。Roost 复用已有目标投影，投影未知时逐页扫描历史。

## 查询语义

按消息从新到旧、单条消息的 items 从后到前检查，沿用原解析器，选择第一个 `type === 'goal'` 且 `threadId`、`objective`、`status` 为字符串的目标。较新的暂停、完成或清除目标覆盖旧活动目标；活动条件仍为 `status === 'active'`。确认历史没有目标后使用旧 metadata fallback，读取失败沿用 GC 的保留路径。

Loro 同步检查容器字段，返回独立的目标对象。Native Roost 在新观察到的 cursor 上复用已有投影，或每页 40 条逻辑消息回查，沿用 state overlay 和分段投影。页面须连续，整个读取期间的 cursor、host 和 generation 须保持一致。扫描正文随页释放，验证后的目标进入已有内存投影，供后续检查复用。

投影未知且目标很旧或没有目标时，首次查询可能访问全部页面。首次工作量随历史规模增长，临时内存随页面和单条记录大小增长。固定只读最早或最新 N 条会漏掉有效旧目标。

## 测量

配对实验使用新进程，在 macOS 27.2 arm64、Electron 44.9.3 / Node 24.22.0 下运行产品本地 backend 和 MessageHandler 目标检查。源码为 main `d197e459b9377f7911ec1cf6b21006d8f22fd7c3` 加本实现；旧路径在同一构建中隐藏本地查询能力。每组使用 128 条各 1MiB 的合成正文。下表记录后端准备完成、主动 GC 后的查询增量。

| 指标                       |            旧全读 |  本地目标查询 |
| -------------------------- | ----------------: | ------------: |
| Roost 额外 JS 堆，投影有效 | 128.12–128.13 MiB |      约 0 MiB |
| Roost 额外 JS 堆，投影未知 | 128.12–128.13 MiB | 0.11–0.13 MiB |
| Loro 额外进程 footprint    | 119.03–119.06 MiB |      约 0 MiB |

Roost 投影未知且无目标时，首次扫描四页耗时 5.45–5.47 秒，后续复用目标结果耗时 0.28–0.33 毫秒。Loro 在查询前已经加载 CRDT。这些查询测量分别记录常驻 JS 堆和进程 footprint。

## 验证

- [Loro 边界](../../../../packages/shared/tests/session-data-review-boundaries.test.ts)：将支持的存储形态与完整历史解析结果比较，并检查正文转换和返回值隔离。
- [Backend 与 GC 接入](../../../../apps/cli/tests/session-history-targeted-write.test.ts)：经过 SessionDocument 和 MessageHandler 检查旧目标及原地清除。
- [Native 契约](../../../../apps/cli/tests/roost-session-backend-contract.test.ts)：覆盖投影、回查、编辑、复制、重开，以及内容和 generation 并发变化。

桌面验证使用真实 Electron、bundled CLI 和外部合成 ACP Agent。完成 23 个回合后，位于最新 40 条消息之前的目标仍保护 Agent，较新的无目标对照会话被回收；通过 UI 清除目标后，原 Agent 随之回收。隔离测试进程使用 1000ms 空闲超时和 250ms 扫描间隔。[目标控制场景](../../../../e2e/src/features/session-goal.feature)覆盖目标的界面操作。
