# 可诊断的预备 Session 清理失败

Status: implemented
Translation: current

[English](2026-10-16-preparation-cleanup-diagnostics.md)

## 摘要

有时 turn 会在发送 prompt 前失败，错误是 "Session preparation cleanup failed: "，
后面什么都没有，daemon 日志也给不出更多原因。原因被两个缺口掩盖了：worktree 删除时可能
抛出的文件锁错误 message 为空；turn 无法接管的预备 Session 被丢弃时没有任何日志。
现在两者都能说明自己：锁错误会写出锁路径和底层原因，未接管的预备 Session 会记录原因以及
不匹配的设置名称。清理行为没有变化。短暂的锁释放超时是否仍应让 turn 失败，留作后续决定。

## 问题

一台负载较高的 Linux daemon 上的一次失败展示了完整过程。turn 到达时的设置与预备 Session
不一致，接管失败，冷启动按照
[预备交接](../../implemented/simplification/2026-10-16-remove-draft-session-preparation.zh.md)
的要求等待预备 Session 回收。回收结束了 agent，并在按仓库加的文件锁下删除了预备的
worktree 和分支。分支删除后约十秒，回收以空原因失败，turn 在等待 75 秒后失败。

十秒正好是连续两次 `FILE_LOCK_CLEANUP_MS`（各五秒）的释放等待：一次删锁文件，一次删锁的
临时目录。`LockReleaseFailed`、`LockIoError` 和 `FileLockCleanupFailed` 都是没有
`message` 的 `Data.TaggedError`，而 Effect 4.0.2 中没有 message 字段的 tagged error
其 `message === ""`。`SessionPreparationCleanupError` 按 message 格式化原因，于是得到
空后缀。事后锁目录是干净的，说明 unlink 最终完成了，只是晚于有界等待。同一时段日志中有
事件循环阻塞和很慢的 Git 命令。删除一个小文件为什么超过五秒，日志无法证明。

接管失败本身没有日志。`SessionManager` 直接等待 `claim.cleanup`，没有记录是请求者、
claim key、就绪状态还是兼容性不同，调查只能猜测是哪个设置变了。

## 决定

- `LockIoError`、`LockReleaseFailed` 和 `FileLockCleanupFailed` 定义 `message`
  getter，与已有的 `LockTimeout`、`LockReentrant` 一致。它写出路径和一行原因，
  会展开 Effect `Cause`（例如 "Operation timed out after '5s'"）。
  `FileLockCleanupFailed` 先列主失败，再列每个不同的释放失败。结构化字段和清理租约不变。
- `SessionPreparationService.claim` 的每次未命中都返回 `reason`：`absent`、
  `requester`、`claim-key`、`not-ready`、`incompatible` 或 `compatibility-error`。
- `SessionManager` 以 debug 级别记录除 `absent` 以外的未命中。`incompatible` 会列出
  不同的设置名称，例如 `configOptionValues.permission_mode` 或 `launch.env`，但从不
  记录值，因为 launch 部分包含 agent 环境变量。

## 备选方案

- **用 `Cause.pretty` 输出完整 `Cause`。** 不用于错误 message：它包含堆栈，并会在每层
  包装中重复。需要完整 `Cause` 的调用方仍可从错误对象上拿到。
- **回收时重试或忽略释放超时。** 推迟。这会改变“释放失败会阻止同一 Session 被替换”的保证
  （[回收重试](2026-10-15-unreleased-session-resources-retry.zh.md)），需要单独决定。

## 取舍与限制

message 中包含 Lody 数据目录下的锁文件绝对路径。它们只是本地诊断信息，同样的路径已经
出现在 debug 日志中。每次受影响的 turn 多一行 debug 日志。unlink 变慢的根因仍未验证；
新的 message 用于下次发生时证实或推翻这个判断。

## 验证

- `packages/shared/tests/file-lock.test.ts` 断言有界释放超时的 message，以及主体失败
  加两个释放失败时的组合 message。
- `session-preparation-service.test.ts` 断言 `absent`、`requester`、`claim-key`、
  `incompatible` 和 `compatibility-error` 原因。
- `session-manager.test.ts` 断言 `permission_mode` 变化时只记录名称、不记录值。
- 完整的 `session-manager.test.ts` 在本机上无论有无本改动都会超时，预备相关测试单独运行。
