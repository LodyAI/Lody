# 使用已发布 Promise Repo 的 Daemon 目录 reader

Status: implemented
Translation: current
PR: [#1729](https://github.com/LodyAI/Lody/pull/1729)

[English](2026-10-19-promise-repo-catalog-readers.md)

## 摘要

#1692 调用了已安装 `loro-repo@0.23.2` Promise Repo 不存在的 native wrapper 方法，导致 CLI 编译失败。reader 现在通过公开的副本和 room lease 借用同一个 Repo。Daemon 读取保留冷 baseline 的不确定状态，不强制每个请求追平；Role proposal 在发布前单独要求同步确认。修复不升级依赖，也不恢复已撤回的 workspace Repo 迁移。无法取消的 SDK 加载仍可能在关闭后结束；修复释放迟到 lease，但不声称解决 SDK 内部缓存的限制。

## 兼容性与所有权

复现的六处 `doc.ts` 错误涉及不存在的 `runLegacy`、`acquireScopeLegacy`、`.native`，以及未导入的 `Scope`。#1692 的 native Repo 测试没有验证产品使用的 Promise 边界。本文更正[此前 Daemon 决策](../architecture/2026-10-16-daemon-hosted-mcp-workspace-commands.zh.md)中目录实现与证据，保留其授权、active Turn 和借用 Daemon 副本的约定。本实现替代 main 上 `de8debe03` 的临时 Promise helper；原有 facade 超时、detach 和 acquisition 行为覆盖保留并适配到 scoped owner。

workspace 启动时在后台建立元数据和 workspace reader。请求只为已授权 Machine Flock 接纳 reader。同 key 请求共享 acquisition、有限退避和 baseline。SDK 适配器调用 `acquireFlockDoc` 与 `joinFlockDocRoom`；元数据调用 `joinMetaRoom`。显式副本 lease 阻止 unload 在读取期间替换对象，room 提供后续更新。不创建第二个 Repo、存储 owner 或 native wrapper。

`WorkspaceCatalogSyncLegacy` 是唯一 Promise 执行入口，消费者为 `LoroDocumentManager`；manager 迁移到原生所有权后删除该入口。Effect 管理 reader 重试、Clock 等待和 Scope 关闭。这是适配外部 SDK I/O 的小生命周期单元，不迁移尚未完成的 workspace/Session 消费链。

cloud baseline 要求稳定的 `streams` binding 完成 `caught-up` 阶段的 `waitFor`，包括元数据 hydration。此前缓存仍可读，但返回 syncing/unknown，缺失 get 可重试。本地组合在本地 acquisition 完成后有权威数据。确认过的 baseline 在 detach 时仍允许读缓存；reattach 更新同一个 Repo。请求超时只结束 Deferred 等待者，不取消 acquisition 或释放 reader。传输恢复继续由已有 manager/Repo 管理；这里不对 detached binding 启动 rejoin 循环。

临时元数据落盘失败时，room 可能仍健康且 joined，但 `waitFor` 返回 tagged error。此前过滤该错误会让首次 baseline 一直等到传输状态变化。reader 现在将原始 SDK 错误交给有限退避，只重试同一稳定 binding 的屏障，保留 room 与副本 lease。detached 结果仍等待状态事件，不轮询。同 key 请求共享恢复，成功前保持未确认，请求不能取消恢复。owner 关闭时中断退避并释放 reader；已恢复的后台错误不变成 cleanup 失败。

## 失败与关闭

已安装 SDK 在 join 拒绝时释放 room 引用，entry 以最大 30 秒的指数退避重试。cleanup defect 不启动替代 reader。owner 保留 fiber Exit，诊断只输出安全摘要；Scope 关闭先中断并等待所有 reader，再交付 cleanup 失败。room 释放失败时仍尝试释放副本。manager 记录 reader 关闭失败后继续独立清理和 Repo 销毁。

Promise acquisition 不接受 abort。关闭会阻止其后续接入 room 并释放迟到结果，不会永远等其结束，也不宣称原始工作已取消。Repo 销毁仍是终止所有者，SDK 的失效检查阻止迟到 connect 接入 room。

独立审查复现了 SDK 0.23.2 限制：存储加载在 `destroy()` 后结束，仍可能在已销毁对象的内存里登记 Flock、journal 和 existence。测试验证此时不创建 room、不写已关闭存储，不声称 SDK 会再次清空缓存。已销毁 Repo 不得复用。修改 SDK 或协调其他 workspace 替换不属于本修复。

## Proposal 确认

创建与更新都先严格同步元数据和 workspace Role 目录。创建再通过 discovery 确认已授权目标 Machine 目录。严格同步检查 report；有 cloud 能力的 manager 还须证明 Streams 成功参与，attached 传输 generation 未变化。no-route 的成功不足以确认。失败保留 cause，返回可重试 `SYNC_UNAVAILABLE`，不追加 proposal；同 requestId 重试可以成功。更新保持原目标绑定，本地组合保持本地权威。权限、当前 Turn 身份、字段过滤和产品边界不变。

## 证据与限制

测试使用真实 Promise Repo/Flock 副本、内存传输边界、显式完成信号与 Effect TestClock，覆盖元数据、workspace 和 Machine 冷读取、后续编辑、detach/reattach、同 key 所有权、失败与慢 acquisition、等待者超时、关闭与迟到结果、cleanup defect 后的独立释放、严格 no-route 拒绝，以及创建/更新失败不写历史后用相同 id 重试。元数据 save 故障注入还覆盖 joined room 无需重新接入即可恢复、保留数据、并发等待者超时、独立 Flock 读取、持续失败达到 30 秒退避上限，以及退避期间关闭。恢复测试在此前过滤错误的实现上失败。MCP 集成使用真实 manager 和本地 socket。未声称验证真实 cloud、设备恢复、打包应用或生产验收。

验证已通过 `env -u GIT_EXEC_PATH pnpm check`、`pnpm format`、变更测试的类型检查和 `pnpm run docs check`，文档检查保留既有告警。全套测试需要允许本地 HTTP/MCP 监听。未改动的递归 native SSH fixture 需要仅移除会话注入的 Git exec-path；相同环境调整下的独立重跑通过，没有增加源码绕过。

补丁直接基于保留 #1692 的 OSS main，不撤回或恢复该 PR。#1679 idle GC、依赖版本、发布 changelog 和私有仓发布指针均不变。最终 PR 记录基线和最终验证版本。
