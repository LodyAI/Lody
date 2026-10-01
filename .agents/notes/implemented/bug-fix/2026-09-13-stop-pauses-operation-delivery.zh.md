# Stop 后保持 Operation 完成结果暂停

Status: implemented
Translation: current

[English](2026-09-13-stop-pauses-operation-delivery.md)

## 摘要

成功执行 Stop 虽会中断活动 turn，但稍后到达的 Operation 完成结果仍可能立刻在同一 Session
中启动新的 assistant turn。现在 Stop 会把完成结果投递暂停点持久化为被停止的 assistant
turn。待投递结果仍由协调器可靠保留，但只有用户编写的新 turn 显式恢复 Session 后才会调用 agent。

## 归属与范围

`SessionExecutionService` 负责成功 Stop 的终结和用户 turn 归属。它在释放已取消 turn 之前写入
`operationDeliveryPausedAtTurnId`。后续用户 turn 只有在赢得既有 Session mutex 并打开自己的
assistant 条目后才清除该标记。Delivery 和 goal turn 在这一边界没有用户 dispatch id，因此不能
自行恢复投递。

`LodyOperationCoordinator` 继续把待投递 Delivery 保留在 SQLite store 中。它在 claim 执行权前
读取持久 Session 元数据，只要暂停标记存在便返回。标记限定于单个 Session，不影响新 Session；
既有 Session mutex 和 pending-user 检查仍保护更新 turn 的归属。

执行服务还会在写入复制元数据前先启用进程内的 fail-closed 屏障，并且只在建立正式暂停标记的同一
次成功元数据更新中消费已经持久化的 Stop 请求。写入失败时，当前 daemon 由本地屏障拦截；重启后
由保留的 Stop 请求拦截；若取消历史可见则用其核对，历史尚未同步时则以精确匹配的持久 Stop 请求
作为恢复凭据，先修复正式标记再消费请求。真实用户 dispatch 会先清除两个持久字段，再移除本地
屏障，因此清除写入失败也不会意外恢复投递。

该方案复用既有元数据复制和 Operation store，不引入第二张暂停表，也不改变 Delivery attempt
状态。Delivery 自身执行期间被 Stop 仍沿用既有的取消并消费规则；本修复处理的是用户 turn 被
停止后仍处于 pending 或随后才完成的 Operation。

## 证据与验证

- coordinator 回归测试让已完成 Delivery 在 Stop 标记后保持 pending，并验证显式恢复边界清除
  标记后才执行投递。
- Session execution 覆盖验证成功 Stop 写入被停止的精确 assistant turn、该写入失败时保留本地
  屏障和持久请求、重启后修复标记，且用户 dispatch 会在不改写 producer 指针的独立元数据写入中
  清除标记。
- 可执行 orchestration model 验证暂停可跨 Worker 重启保留、阻止自动调度，并允许排队用户 turn
  先取得归属并清除暂停，再进行后续投递。

这些确定性 service 和 coordinator 测试不能证明完整的 Electron 交互验收。

实现见 [PR #687](https://github.com/LodyAI/Lody/pull/687)。
