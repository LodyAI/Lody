# 在实时目录更新期间保持移动端引用展开就绪

Status: implemented
Translation: current

[English](2026-11-26-mobile-mention-catchup-readiness.md)

## 摘要

在移动端新建对话并引用其他会话（`@session:<id>`）时，首条消息偶发报 `mention_expansion_failed`：原因是 `createSession` 写入 `${workspace}:meta` 会唤醒 `meta` 长轮询，在强制让出的 `setTimeout(0)` 时间片期间将 `'meta'` 标为 `unhealthy`，刚好撞上 `sendTurn` 读取 `mentionCatalog`。共享移动端 `cloud-runtime` 现已在网络空闲等待后重置 12 ms 导入时间片、先写入目录投影再清除 `unhealthy`、在 `mentionCatalog` 中仅对无错误的活跃流追赶最多等待 3 秒、在目录刷新前兜底读取实时 `meta` Flock 会话行，并在展开 skill 时跳过代码块／行内代码与无字母的 `$` 文本。离线或真实流故障仍立即清除追赶等待并快速失败；多设备真实云端并发突发仍仅通过确定性合成传输验证。

## 决策

- **网络空闲后重置导入时间片（`catalog-sync.ts`、`index.ts`）**：`catalogImportCheckpoint` 原先从首次 bootstrap 起保留单一时间戳，导致每次长轮询返回后的首帧都因耗时 `>= 12 ms` 先让出宏任务，而 `watch(mode)` 已提前将 `mode` 标为 `unhealthy`。在每次网络读取返回后的导入批次前重置时间片计时，且对 `upToDate: true` 的帧仅在真正超过 12 ms 让出时才标记 `unhealthy`，使常规单轮实时更新在同一事件循环内同步完成且保持健康。
- **先更新投影再清除 `unhealthy`（`index.ts`、`handlers/mentions.ts`）**：`watch(mode)` 先完成 `flock.scan()` 与 `catalogs.set(mode, ...)`，再删除 `unhealthy` 并唤醒 `resumeAcceptedInputs`。当新建会话尚未进入 `catalogs.get('meta')` 时，`getMentions` 兜底扫描 `state.metaReplica.flock`，并允许新对话引用面板传入 `group:` 项目组 ID。
- **对无错误追赶做有界局部等待（`index.ts`、`handlers/mentions.ts`）**：
  - *触发条件*：`meta` 或被引用电脑流处于多页增量突发（`!next.upToDate`）或 `>= 12 ms` 导入分片让出期间，恰逢 `sendTurn` 或 `@` 面板调用 `getMentions`。
  - *影响范围*：仅限 `getMentions` 在 `state.unhealthy.has(mode)` 且 `state.catchingUp.get(mode)` 存在无错误活跃追赶时等待；`publishNow` 及其他调用方保持原有 `unhealthy` 门禁语义。
  - *恢复与依赖边界*：`watch(mode)` 在 `state.catchingUp` 中按流维护共享 `Promise<void>`，在 `upToDate` 完成时兑现，并在任何 `retrySessionRead` 报错、`catch`、`finally` 或 `abort` 时立即清理；等待端受 3 秒定时器上限约束并在完成后清理定时器。
  - *基线行为与风险控制*：旧逻辑直接抛出 `metadata_not_ready`／`machine_unavailable` 并被 `expandMentions` 转为确定性失败 `mention_expansion_failed`，迫使用户手动重试。仅等待无错误追赶保留了离线快速失败，且唤醒后重新校验工作区、副本与 `unhealthy` 状态，未确认数据不会成为权威状态。
- **排除正文中的 `$skill` 误匹配（`mention-expansion.ts`）**：`referencePattern` 与 `protocol/message-references.ts` 对齐跳过代码块与行内代码，并要求 `$` token 至少包含一个 Unicode 字母，避免金额（`$100`、`$5.99`）或位置参数（`$1`）触发机器 RPC 扫描。
- **Outbox `metadata_not_ready` 对齐（`OutboxDispatcher.swift`、`SessionOutbox.kt`）**：后台 Outbox 发送遇到 `metadata_not_ready` 时与 `session_not_ready` 一致保持 `waiting`，iOS 前台发送失败时映射为本地化的 `native.runtime.sessionNotSyncedRetry`。

### 被否决的替代方案

- **在 `getMentions` 中对 `@session` 跳过 `state.unhealthy` 检查**：被否决，`mentions.md` 要求发送时基于健康工作区元数据重检引用目录，且 `agent-roles.test.mjs` 明确约束 `meta` 不健康时必须拒绝。
- **在 Outbox 中将所有 `mention_expansion_failed` 静默转为后台等待重试**：被否决，已删除的 `@role:<id>` 或离线电脑属于需要明确提示用户的确定性失败，应保留草稿供显式重试而非静默空转。

## 验证

- iOS runtime 与 Outbox：`apps/mobile/ios/apps/ios/tests/native/mentions.test.mjs`、`apps/mobile/ios/apps/ios/tests/native/agent-roles.test.mjs`、`apps/mobile/ios/apps/ios/verification/kit/outbox/main.swift`。
- Android 镜像 runtime 与单测：`apps/mobile/android/runtime/test/catalog-budget.test.mjs` 及 `:app:testDebugUnitTest`。
- 局限：通过确定性合成 Streams 传输与宿主单测验证，未在真实登录云端与真机多端并发负载下复测。
- 关联 PR：[LodyAI/lody-ios#189](https://github.com/LodyAI/lody-ios/pull/189)、[LodyAI/lody-android#63](https://github.com/LodyAI/lody-android/pull/63)。
