# Cloud 同机恢复采用可用性优先的本地权威确认

Status: implemented
Translation: current

[English](2026-11-21-cloud-same-machine-recovery-authority.md)

## 摘要

Cloud daemon 在恢复缺失的目标 Turn 前，原先一律要求通过 Loro Streams 完成远端追平（`syncRemoteDocOrThrow`），即使目标 Session 就运行在当前机器 daemon 自己的副本上。在 Streams 断连或抖动时，同机委派工作会陷入 8 秒超时重试循环，尽管当前机器 daemon 正常运行。按产品 owner 的决定，`confirmTargetReadable` 对 Cloud 同机目标优先保证可用性，改为仅执行本地 `repo.flush()` 而不再等待远端 Streams 追平；跨机目标及无法在本地确定机器的目标仍保持远端追平。这一取舍接受一个极少见、目前未验证的重复投递风险（daemon 已推送到 Streams 但在本地持久化落盘前崩溃），若未来观测到同机重复重放或证实 `LoroRepo` 先上传后落盘，则需重新评估。

## 问题

在 Cloud workspace 中，同机 MCP 委派（`lody_session_create`、`lody_session_chat` 及批量模式）直接操作当前机器 daemon 的 `LoroDocumentManager` 副本。当初次物化因瞬态故障或重启交由 `LodyOperationCoordinator` 恢复时，`CoordinatorWorkflow` 会在重放前调用 `confirmReadable`，以确认固定 `userTurnId` 确实不存在。

如果对同机目标也强制等待远端 Streams 确认，任何云端传输中断都会阻塞当前机器 Session 之间的编排恢复，把云端网络故障放大为本地完全不可用。

## 决定

在 Cloud workspace 中，`apps/cli/src/lib/message-handler.ts` 的 `confirmTargetReadable` 对归属当前机器 daemon 的目标（`targetMachineId === this.machineId`，优先读取目标元数据；冷启动的 `session_create` / `session_create_many` 缺失目标元数据时由 `apps/cli/src/orchestration/coordinator-model.ts` 的 `resolveOperationTargetMachineId` 解析）采用与 OSS 本地目标一致的策略：先对权威当前机器 daemon repo 执行 `repo.flush()`，再重新检查固定 `userTurnId` 后决定是否重放。

- 跨机目标（`targetMachineId !== this.machineId`）以及无法在本地确认目标机器的项（例如未在 canonical command 中显式绑定机器的冷启动 Role 创建）继续保留强制远端 Streams 追平（`syncRemoteDocOrThrow`，8 秒超时配合有界退避重试）。
- 同机恢复仍在 `Scope` 托管的 `FiberMap` 并发纤程中执行，并在调用 `materializeTarget` 前复查 `isTargetInputDurable`。
- 本决定部分替代了[通过 daemon 权威状态实现本地 Session 编排](2026-09-29-local-session-orchestration.zh.md)中“所有 Cloud 恢复路径均依赖远端追平”的原有约束。PR：[#3050](https://github.com/LodyAI/Lody/pull/3050)。

## 接受的风险与触发条件

优先保证本地可用性会引入一个窄窗口、当前未验证的重复投递风险：

1. daemon 将固定 `userTurnId` 写入内存中的 Session 文档，并已将该变更上传至 Loro Streams。
2. 在对应的本地持久化尚未落盘前，daemon 进程突然崩溃或机器断电。
3. 重启后本地副本中不存在该 Turn，`repo.flush()` 仅针对本地副本成功返回，`LodyOperationCoordinator` 重放该 Operation 的固定 Turn；若其他对端或后续远端同步已看到崩溃前的上传内容，则可能触发重复执行。

该窗口在现实中是否可达，主要取决于 `LoroRepo` 是先持久化到本地存储再上传 Streams，还是相反；目前尚未对此顺序进行实测验证。

## 放弃的备选方案

- **对所有 Cloud 目标继续强制远端 Streams 追平**：可借远端确认消除崩溃前未落盘导致的重复窗口，但在 Streams 不可用时会阻塞所有同机编排恢复，违背可用性优先决定。
- **同机目标连 `repo.flush()` 也一并跳过**：虽省去本地刷盘等待，但可能在复查 `isTargetInputDurable` 前漏掉进程内尚未落盘的写入。

## 重新评估条件

出现以下任一情况时，应重新评估本决定：

- 在 daemon 崩溃或重启后的 Cloud 同机 Operation 恢复中，观测到实际发生的重复 Turn 执行。
- 经验证确认 `LoroRepo` 会在本地持久化落盘之前先向 Streams 上传变更，且缺少预写顺序保证。
- 后续编排语义要求同机重放前必须具备远端确认的严格 exactly-once 保证，而非云端断连时的本地可用性。

## 验证与限制

- `apps/cli/src/orchestration/operation-coordinator.test.ts` 验证冷启动同机 `session_create` 恢复能从 canonical command / 请求方元数据解析出 `targetMachineId` 并传入 `confirmTargetReadable`，不调用 `syncRemoteDocOrThrow` 即可完成恢复；同时覆盖远端/卡死追平的 Effect Clock 超时与有界退避重试。
- `apps/cli/src/mcp/daemon-session-tools.test.ts` 验证 Streams 同步失败时 Cloud 同机 `lody_session_chat` 与 `lody_session_create` 仍可正常投递，且远端目标、协作者与 `revoked` 访问态保持严格拦截。
- 未验证项：`LoroRepo` 在进程突然终止时的本地落盘与 Streams 上传先后顺序，以及对抗生产 Streams 服务的真实崩溃恢复演练。
