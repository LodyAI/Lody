# 原生移动端输入框 Agent Role 列表的缓存与就绪恢复

Status: implemented
Translation: current

[English](2026-11-28-mobile-role-selector-recovery.md)

## 摘要

在原生移动端新建对话与会话输入框中打开运行配置面板时，曾偶发出现 Agent 与模型选项正常展示但“角色（Role）”行完全缺失的问题：原因是 `options` 会从本地缓存立即恢复并在运行时就绪后自动重试，而 `roles` 仅在进入页面时单次读取且无本地展示缓存，一旦首次 `agentRoles` 调用撞上 WebView 启动期或 `meta` 流分片导入让出事件循环，便会将错误静默吞掉并使 `roles` 在整个页面生命周期内保持 `nil`/`null`。现在 iOS 与 Android 均会在在线校验前先恢复明文工作区隔离的角色展示缓存，在运行时就绪、目录/配置更新及 `agentRolesChanged` 事件到来时自动补拉或刷新（瞬时失败保留已有列表），并在 `cloud-runtime` 的 `agentRoles` 列表读取中对活跃且无错的 `meta` 追平分片做有界等待。缓存的角色列表仅用于界面展示，绝不绕过发送准入或发送时的角色版本与机器绑定校验；多设备真实云端突发负载仍通过确定性单测夹具而非真机弱网压测覆盖。

## 决策

- **对齐 iOS 与 Android 的角色列表恢复生命周期（`CreateSessionController.swift`、`CreateSessionHostController.swift`、`SessionComposerModel.swift`、`CreateSessionRepository.kt`、`CreateSessionScreen.kt`、`ChatScreen.kt`）**：
  - *触发条件*：在 WebView 运行时仍处于 `starting`、从后台切回重连或正在同步工作区流时打开新建对话、已有会话或草稿子标签页。
  - *影响范围*：此前单次 `agentRoles` 失败会让 `roles` 在当前页面永久停留在 `nil`/`null`，而 `options` 随后通过 `live` / `READY` 事件自动恢复，导致运行配置面板只缺少角色行。
  - *恢复与依赖边界*：未完成在线加载的角色列表会在运行时进入 `live` / `RuntimePhase.READY`、`creationOptionsChanged` / `Synced`、`agentRolesChanged` 以及用户手动点击重试时自动重拉（150 ms 防抖，无后台轮询定时器），任务归属页面或输入框并在视图/作用域销毁时取消。
  - *结果与风险边界*：刷新偶发失败时保留缓存或已加载的角色列表而不重置为空；角色加载状态绝不阻塞 `canSend`，确保工作区设置流异常时仍可正常发起普通对话，且发送时仍由 `cloud-runtime` 重新校验最新 Role 记录与 `revision`。
- **补齐明文工作区隔离的角色本地展示缓存（`CreateSessionService.swift`、`AtomicCatalogStore.kt`）**：
  - 按账号与工作区维度恢复最近一次可读角色列表（iOS `LocalStore` 的 `creation-roles:v1:` 受登出代数围栏保护；Android `AtomicCatalogStore` 的 `roles-` 限制最多 16 份快照并在账号切换或登出时清理），写入与读取均以明文工作区准入为前提，禁止加密工作区落盘明文角色数据。
  - 在 `NativeShareCoordinator.swift` 中将全局 `chat` 配置与 `roles` 预取排在最多 10 个项目的串行 `options` 读取之前，避免后台预取中途中断导致 iOS 分享扩展只有模型缓存而缺少 `roles.json`。
- **`agentRoles` 列表读取对活跃无错的 `meta` 追平做最多 3 秒有界等待（`handlers/settings.ts`）**：
  - 将[移动端提及追平就绪决策](2026-11-26-mobile-mention-catchup-readiness.zh.md)中的 `catchingUp.get('meta')` 有界等待扩展到只读的 `agentRoles`（`action === 'list'`），避免常规 `>= 12 ms` `meta` 导入分片让出事件循环时误报 `workspace_changed`。
  - *基线行为与风险*：离线或报错的 `meta` 流会立即清理 `catchingUp` 并快速拒绝，不产生额外等待；角色写操作（`save` / `delete`）保持原有的即时作用域检查。

### 排除的备选方案

- **在 `agentRoles` 成功前阻塞 `canSend` 或隐藏运行配置面板**：已排除，因为 `${workspace}:wf:workspace` 的局部读取异常不应在 `meta` 与机器流健康时演变为阻塞普通对话发送的全局门禁。
- **在 `DataRuntime` 未就绪时直接返回空数组 `[]`**：已排除，因为空数组与“工作区确实没有角色”无法区分，会导致本地缓存与 `ShareStore` 把真实角色目录覆盖为空。

## 验证

- 共享运行时：`apps/mobile/ios/apps/ios/tests/native/agent-roles.test.mjs` 及同步后的 `apps/mobile/android/runtime` 快照与构建测试。
- iOS 单测与原生校验：`apps/mobile/ios/packages/LodyKit/Tests/LodyKitTests/SessionComposerModelTests.swift` 与 `apps/mobile/ios/apps/ios/verification/kit/{create-session,session-roles,share}/main.swift`。
- Android 单测：`apps/mobile/android/app/src/test/kotlin/app/lody/android/create/CreationRefreshTest.kt` 与 `apps/mobile/android/app/src/test/kotlin/app/lody/android/runtime/CreationJsonTest.kt`。
- 局限：通过确定性宿主/JVM 测试夹具与合成运行时状态验证，未在真机实时云端弱网切换场景下重复压测。
- Pull requests：[LodyAI/lody-ios#214](https://github.com/LodyAI/lody-ios/pull/214)、[LodyAI/lody-android#98](https://github.com/LodyAI/lody-android/pull/98)。
