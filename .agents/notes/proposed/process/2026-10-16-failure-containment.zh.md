# 故障隔离指引与审查技能

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1607

[English](2026-10-16-failure-containment.md)

## 摘要

对一份生命周期迁移草稿的审查发现，清理失败会扩散到其他 owner，确认等待也会影响无关探测。最初的隔离指引却又写成了无条件拒绝、跑完清理、先重试和回退，可能阻止安全复用或销毁恢复所需状态。本次修订依据已验证的底层保证与有界所有权：终止时报告未确认持久化并释放资源；可选的跨 dispose 恢复必须由明确 owner 接管，再次 acquire 接续同一 Repo。安全保证无法核实时默认保持 base 行为并记录条件。审查技能支持 PR 和本地快照，指引仍需后续实际行为验证。

## 问题

[Effect 指南](../../../docs/cli-effect-ts.md#behavior-contract)会问"谁保留未释放的资源、谁可以重试清理"，它的验收矩阵也要求释放失败时保留 owner 和完整 Cause。根 `AGENTS.md` 倾向显式契约、反对隐藏的兜底。但两者都没有问：严格路径失败时，还有什么会跟着停止工作。如果只读这些规则，把尽力而为的清理改成向上抛错、再加上隔离，看起来都是局部更正确的做法，因此会被鼓励。

审查标准加剧了这一点。`.github/codex-review.md` 把"假设性的边界情况"排除在外，而清理过程中的存储或网络失败很容易被当成这类情况，可能让审查者在追踪影响之前就忽略普通的失败链。

## 证据

### 历史 PR 快照

对草稿 PR #1607 的 `9b5122ca` 与合并基点 `d73db66f4` 对比审查，发现：

- `createManagedStoreCache.disposeAll` 从吞掉 store 释放错误改为抛出 `AggregateError`。`create-workspace-runtime.ts` 中 workspace 的 `dispose` 在 `teardownTransport()` 和 `repo.destroy()` 之前无保护地 await 这三个缓存，并且记忆化了 `disposePromise`。因此一次 lease 释放失败就会让 transport 和 Repo 保持打开，且没有重试。
- 释放失败后，`retainedDisposals` 会让该 key 之后的每次 `get` 都 reject。tracker 的释放回调需要先 acquire 成功才会触发，所以没有任何自动重试。`PromptShortcutSync` 用 `retiring` 和 `failure` 加了同样的隔离。该 PR 的 README 声称 native replica 在借用者之间共享，但这不能证明每种部分释放失败后都可安全复用。
- 每一次本地 `acp-capabilities-refresh` 都开始等待 Machine Flock 的 peer 回执，时限 20 秒。只有保存配置后紧接着的那次探测才可能与写入竞争；离线时，其他探测现在也会失败。
- `WorkspaceRepoLegacy.failures` 在 workspace 整个生命周期内收集所有非中断的后台失败，没有上限，`destroy()` 最后会带着全部这些失败报错。
- 同一个 PR 中，`WorkspaceRepo`、`workspaceRepoLayer` 以及 `openWorkspaceDoc`/`acquireWorkspaceRoom` 这几个辅助函数没有任何使用方。`LocalLoroTransportAdapter` 被保留下来，尽管它所在的模块只剩一个类型还被导入。

以上结论来自阅读代码，没有运行任何东西。native lease 在配额不足或离线时是否真的会释放失败，取决于 `loro-repo` 和 `streams-crdt` 的内部实现，这一点没有核实。这些观察只描述该草稿版本，不代表 main 或后续 PR head。

### 本地调用方契约

在本地 `3ac76bad1` 核对调用方时，`store-ref-tracker.ts` 在重建 store 前容忍 pending disposal 拒绝，注释说明了保留 dirty doc 的复用约定，延迟 release 又经由 `void` 回调发起。因此，无条件让 acquire 失败，或新增没人观察的后台拒绝，都不保留现有调用契约。并发 acquire 已共享缓存中的创建 Promise；保留清理应接入底层已有的单次在途操作，而非每个 borrower 独立重试。

`startup-acp-capabilities-refresh.ts` 会在 refresh 正常完成后把配置加入 `refreshedConfigKeys`。把降级答案当成功返回，就会阻止后续 probe；gate 超时必须保持未确认和可重试。cache 注释中的安全预期仍需针对 SDK 部分释放失败进行验证；应保持 base 行为并记录不确定性，不能新增 fence 或假定后续 destroy 会保住 dirty state。

renderer provider 规则要求只有一个 Repo view。保留失败 workspace 的 Repo，同时再次为同一数据库创建 Repo，会违反这一边界。dispose 之后无限重试既没有 owner，也可能让持续配额失败阻止 quit 或 sign-out。仅保护依赖，并不能证明关闭策略安全或可用。

## 决定

- 新增[故障隔离](../../../docs/failure-containment.md)作为跨模块说明文档，根据已验证的所有权保证决定拒绝、排除或重试；区分独立清理与有界恢复期间受保护的依赖，区分被 await 的结果与有人观察的后台失败。gate 保持显式，降级答案不进入权威缓存或 once 集合。历史实例留在本笔记中，不在维护中的指南重复。
- quit、sign-out 和删除 workspace 时，最后一次 flush 设 deadline；仍未确认持久化就向用户报告可能未保存的数据，再释放资源。持续配额失败和报告本身都不能无限阻止终止；等待超时并不证明 writer 已停止。可选的跨 dispose 恢复必须由明确的长生命周期 owner 接管，限制资源、重试与保留时间，并按同一 key 协调：再次 acquire 接续原 Repo，或等待其确认关闭后替换，不能新开第二个 writer。接管的是 Repo，不是已经 dispose 的 runtime 或退役 UI 资源。SDK 保证无法验证时默认保持 base 行为，在 Note 标记条件与缺失证据，不能仅因未知新增 fence 或破坏性清理。
- 在根 `AGENTS.md` 中加入有约束力的摘要和必读触发条件，并在 Code Review Rules 中把故障隔离回归列为 P1。`.github/codex-review.md` 给出这个术语的定义，并说明普通的存储、网络和 peer 失败不属于假设性的边界情况。
- 在 Effect 行为契约和验收矩阵中加入隔离约束：持续失败时保留已验证的安全复用，并发重试共享，依赖生命周期有界，验证终止收尾并观察后台拒绝。
- 新增 `failure-containment-review` 技能，并链接到 `.claude/skills`。技能放审查流程和委派提示，规则留在文档中；支持没有 PR 的分支、暂存、未暂存及相关未跟踪文件审查。自动重试或 deadline 本身不构成审查豁免。
- 把精简 PR 文档的共同规则保留在根 `AGENTS.md`，覆盖指南、README 和 Note。[笔记规则](../../AGENTS.md#when-to-write)只保留笔记自身的合并要求；创建或编辑任何 Spec 前都必须读取 `specs/AGENTS.md` 的选用、状态与审批规则，包括普通 fix 顺带修改 Spec 的情况，不把审批约束移进有日期的笔记。

## 考虑过的方案

- **只写一个审查提示词。** 它能在事后发现一部分回归，但导致这些回归的编写指引仍然不变。
- **总是拒绝、总是先重试、总要跑完清理或总是回退。** 这些确定性规则忽略了保留资源的安全复用、后台调用方、依赖生命周期和权威缓存；经调用链审查后拒绝。
- **无限保留恢复依赖。** 拒绝：持续配额失败会阻止终止，或留下与新 Repo 竞争的孤儿 Repo。采用有界收尾并报告未确认写入，或由明确 owner 做可选的有界接管；普通 quit 无须新增人工审批。两条路径都不能把等待超时视为 writer 已终止。
- **把完整规则写进根 `AGENTS.md`。** 详细区分留在指南中；摘要与必读触发条件沿用仓库已有的"改 X 之前先读 Y"模式。

## 局限

引用的子模块按锁定版本初始化后，文档检查与技能元数据校验均通过。Markdown 使用仓库版本 Oxfmt 与本 checkout 配置校验；此次仅整合指引，不修改产品代码。本 checkout 没有已注册的 SHA 主题。审查覆盖调用方代码、持续失败时的终止、同库再次 acquire 和底层未知时的默认行为，没有对 SDK 的 release/destroy 注入故障验证。未知保证仍是有条件结论，默认保持 base 行为，不能据此断言数据丢失或授权排除。指引尚未在后续生命周期实现中检验；技能的搜索模式只是起点，可能漏掉其他写法。根 `AGENTS.md` 仍高于 7000 字节警告阈值，此前已经如此。
