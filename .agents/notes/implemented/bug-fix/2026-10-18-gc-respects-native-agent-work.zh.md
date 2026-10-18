# Session GC 尊重原生 Agent 的工作

Status: implemented
Translation: current

[English](2026-10-18-gc-respects-native-agent-work.md)

## 摘要

空闲 GC 会停掉仍在工作的 Claude 会话。turn 以 `end_turn` 结束时，
`run_in_background` 的 shell 或 Monitor 仍可能在运行；任务结束后，
Claude Code 会自行唤醒模型继续工作。Lody 看不到这些：只有用户操作和
turn 结束才算活动，于是 turn 结束 20 分钟后，GC 会连同后台任务一起杀掉
agent 进程。现在 agent 会通过新的 Core 通知 `_lody/session/activity_update`
上报自己是否在运行、以及有多少存活的后台任务。GC 不清理 agent 正在运行的会话；
只在等后台任务的会话最多保留 24 小时；turn 结束后的输出算作活动。不上报该状态的
agent 完全沿用原有规则。没有存活任务的待触发 `ScheduleWakeup` 和 cron 仍未受保护。

## 问题

`SessionGCManager` 在会话空闲超过 20 分钟、且没有进行中的 turn、active
goal、待刷写更新、待处理用户消息、正在归档时清理它。空闲时间从
`touchSession` 算起。该函数只在用户操作、history RPC 和 turn 收尾时调用，
刻意不在 ACP 更新时调用。

Claude 适配器只会为本 turn 启动的后台 subagent 保持 prompt 打开。它从不
为 shell 保持（注释原话："a hold must NEVER wait on a shell"），并忽略
Monitor 任务。因此 GC 会把三种情况当成空闲：

- turn 结束后运行超过 20 分钟的后台 shell 或 Monitor：在它能唤醒模型之前就被杀掉；
- 这类任务结束后 Claude 自行开启的模型 turn：它的输出作为迟到更新写进已结束的
  turn，不更新活动时间，所以可能干到一半被杀；
- 设定在 20 分钟以后触发的 `ScheduleWakeup` 或 cron。

## 决定

1. **Core 活动状态。** `acp-extension-core` 新增 `sessionActivity` 能力和
   `_lody/session/activity_update` 通知（`state`：`idle` / `running` /
   `requires_action`，以及 `backgroundTaskCount`）。它是替换语义的状态，
   客户端未收到时按 `idle` 且无任务处理。Claude 适配器根据 SDK 的
   `session_state_changed` 和 `background_tasks_changed` 消息生成它，并排除
   SDK 标为 `ambient` 的任务（SDK 说明这些不算活动）。
2. **GC 读取该状态。** `AgentClient.getNativeWork()` 把状态映射为 `running`
   （运行中或在等权限）、`background` 或 null。只有 agent 声明了该能力、且状态
   属于当前 ACP 会话时才读取。`MessageHandler.getNativeWork()` 从存活的会话读取，
   进程退出后状态随之消失。GC 永不清理或驱逐 `running` 的会话。空闲清扫会保留
   `background` 会话，直到空闲时间达到 `nativeBackgroundMaxIdleMs`（24 小时，
   `LODY_SESSION_GC_NATIVE_BACKGROUND_MAX_IDLE_MS`）。内存压力回收仍可驱逐它。
3. **turn 结束后的输出算活动，仅限这类 agent。** 当更新被路由到已结束的 turn、
   且 agent 声明了 `sessionActivity` 时，`MessageHandler.enqueueACPUpdate` 调用
   `touchSession`。这类输出来自被后台任务、wakeup 或 cron 唤醒的模型 turn，所以
   空闲计时从这段工作结束时重新开始，而不是从最后一次用户 turn 算起。turn 内的
   输出仍不更新：turn 本身已经保护了会话。不上报该状态的 agent 沿用"只有用户操作
   和 turn 结束才算活动"的旧规则，其 GC 行为不变。

## 备选方案

- **调大 `LODY_SESSION_GC_IDLE_TIMEOUT_MS`。** 不用改代码，但所有空闲会话都会
  更久地占内存，而且超过新阈值的等待仍会失败。
- **也为 shell 保持 prompt 打开。** 适配器有意拒绝：后台 dev server 可能比所有
  turn 都长，prompt 将永远无法结束。
- **从 history 推断后台工作。** 后台 Bash 的工具调用在 history 里，但 history 无法
  可靠地说明任务何时结束。只有 SDK 的存活任务状态能做到。
- **根据 history 保护待触发的 wakeup 和 cron。** history 已足以算出下次触发时间
  （`collectPendingScheduledTasksFromHistory`）。这部分留给单独的改动。

## 取舍与限制

- 24 小时上限约束了被遗忘的后台 dev server：这类会话空闲满 24 小时后会被清理。
  内存压力可能更早驱逐它，从而杀掉其任务。
- 没有存活任务的待触发 `ScheduleWakeup` 或 cron 不在覆盖范围内：若 20 分钟内没有
  输出，仍会丢失。SDK 是否在 `background_tasks_changed` 中列出待触发的 wakeup
  未经验证。
- 该状态需要声明 `sessionActivity` 的 Claude 适配器版本，以及定义它的 Core 版本。
  旧适配器和其他 provider 不上报，GC 行为与之前完全相同，包括迟到输出不算活动。
- 适配器发送状态时不 await，SDK 消息循环不会在这些位置让出。顺序依然成立，
  因为每次发送都在第一个 `await` 之前交给了连接。

## 验证

- 适配器：一个流测试让后台 shell 运行到 turn 结束之后，检查发出的状态序列
  （`running`/`idle` 且有 1 个任务，然后 0 个任务，再到模型自行开启的 turn）。
  去掉 `background_tasks_changed` 的接线后该测试失败。golden initialize 快照
  现在包含该能力。`incomplete-tools.test.ts` 的 5 个失败在未修改的适配器上同样
  出现，原因是本环境没有用于 `auth status` 的 `claude` 可执行文件。
- CLI：GC 测试覆盖 `running`、低于和高于上限的 `background`、任务消失后的清理，
  以及内存压力驱逐。AgentClient 测试覆盖能力协商和 ACP 会话匹配。一个
  MessageHandler 测试检查：对上报该状态的 agent，turn 结束后的输出会重置空闲时间；
  对不上报的 agent 则不变。去掉 touch 后它失败。
