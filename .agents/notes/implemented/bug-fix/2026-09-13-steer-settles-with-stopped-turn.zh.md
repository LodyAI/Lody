# 确认型 steer 随其目标 turn 停止而结算

Status: implemented
Translation: current

[English](2026-09-13-steer-settles-with-stopped-turn.md)

## 摘要

瞄准运行中 turn 的 steer 此前可能永远停留在 `pending_apply`：服务端等待 agent 的应用裁决时没有
与该 turn 绑定的边界，而扣住 steer 请求不应答的运行时，其裁决只有连接关闭时才会结算。现在停止
目标 turn 会结束该等待——steer 响应以 `stale-turn` 返回，指南条目落终态（停止为 `canceled`，
turn 结束但无应答为 `failed`），而不是无限等待并堵死每会话的 steer 变更队列。未知投递结果刻意
落终态而非重新排队：provider 仍可能接受被扣住的请求，重放会造成重复投递。响应从不停下等待
被扣请求的裁决，但裁决一旦到达仍会细化结果：agent 亲口拒绝可证实未投递，指南回到常规分发；
迟到的接受会释放其应用租约，避免 agent client 的会话更新屏障卡死。

## 问题与职责

`steerSessionLocked` 无条件 `await steerRun.applied`。对 request 传输的运行时，裁决仅在 agent
应答扩展请求或连接关闭时结算——steer 提示本身不会随 turn 中止——因此 Stop 之后该等待永久悬挂，
响应永不返回，指南停在 `pending_apply`，而常规分发刻意跳过该状态（issue #666 的搁浅场景）。对
prompt 传输的运行时，被停止的 prompt 会直接拒绝 `applied`，落入通用的 `error` 处置，同样不写
历史条目。

- `steerSessionLocked` 将 `steerRun.applied` 与目标 turn 的 prompt run 结算做 `Promise.race`。
  prompt run 是取消的所有者，其结算是结构性边界，不引入任意超时。
- 结算赢得竞速时，用 `setTerminalUserTurnStatus` 落终态，响应为 `stale-turn`；提交后被停止而
  裁决直接拒绝的 catch 路径也做同样结算，两种传输收敛一致。
- 已确认的拒绝（`AgentSteerNotDeliveredError`）与提交前的拒绝保持既有的重排队为常规分发行为；
  终态路径只覆盖提交后的未知窗口。
- 应用等待器仍在 agent client 注册至 agent 应答或连接关闭，竞速结果无法复活已停止的 turn。
  结算之后服务端仍会非阻塞地消费待定裁决：迟到的接受立即释放（agent client 会把
  `waiter.released` 装为会话的应用屏障，在租约释放前阻塞该会话所有后续 `sessionUpdate`）；
  迟到的 `AgentSteerNotDeliveredError`——仅由 agent 亲口的 invalid-request 应答产生——经
  `requeueSteerAfterLateRefusal` 重排队，该方法只回翻同一 race 分支写下的终态并复走常规
  重排队守卫；既有的应用后取消守卫不变。

## 权衡与兼容性

- "终态而非重排队"是承重选择：未知裁决后自动重放有重复投递风险，报告明确排除该方案。终态
  只覆盖真正未知的窗口；agent 事后证明未应用时指南自动重排队，仅当裁决始终未知（例如连接
  关闭且无应答）才需要用户手动重发。
- 非取消结算标记为 `failed` 是唯一启发式：完成 turn 却不应答被扣 steer 请求的 agent 已偏离
  确认型 steer 契约，失败状态如实反映"无裁决"，而非断言已投递或未投递。
- 响应结算后每会话 steer 变更队列立即解锁；后续 steer 的排队顺序不变。

## 验证

两条回归测试复现报告场景：被扣裁决 + 停止 turn 时响应返回 `stale-turn` 并写入 `canceled`
状态（修复前测试在 30s 超时）；停止 turn 上被拒绝的裁决收敛到同样的终态结算（修复前为
`error` 且不写历史）。两条在父提交上失败、修复后通过。另有两条覆盖迟到裁决：结算后被拒绝的指南回到 `pending`
并重写分发指针，迟到的接受释放其租约。四条在细化前失败、细化后通过；`apps/cli` 全量套件
除为 race 读取的 `promptOutcome` 字段补全两个运行时 mock 外全部通过。
