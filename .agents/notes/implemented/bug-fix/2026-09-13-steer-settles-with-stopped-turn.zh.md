# 确认型 steer 随其目标 turn 停止而结算

Status: implemented
Translation: current

[English](2026-09-13-steer-settles-with-stopped-turn.md)

## 摘要

瞄准运行中 turn 的 steer 此前可能永远停留在 `pending_apply`：服务端等待 agent 的应用裁决时没有
与该 turn 绑定的边界，而扣住 steer 请求不应答的运行时，其裁决只有连接关闭时才会结算。现在停止
目标 turn 会结束该等待——steer 响应以 `stale-turn` 返回，指南条目落终态（停止为 `canceled`，
turn 结束但无应答为 `failed`），而不是无限等待并堵死每会话的 steer 变更队列。未知投递结果刻意
落终态而非重新排队：provider 仍可能接受被扣住的请求，重放会造成重复投递。

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
- 应用等待器仍在 agent client 注册至 agent 应答或连接关闭，迟到的裁决只会解析进无人消费的
  Promise，无法复活已停止的 turn；既有的应用后取消守卫不变。

## 权衡与兼容性

- "终态而非重排队"是承重选择：未知裁决后自动重放有重复投递风险，报告明确排除该方案。代价是
  provider 事后证明未应用时，需要用户手动重发；终态状态让这一点可见。
- 非取消结算标记为 `failed` 是唯一启发式：完成 turn 却不应答被扣 steer 请求的 agent 已偏离
  确认型 steer 契约，失败状态如实反映"无裁决"，而非断言已投递或未投递。
- 响应结算后每会话 steer 变更队列立即解锁；后续 steer 的排队顺序不变。

## 验证

两条回归测试复现报告场景：被扣裁决 + 停止 turn 时响应返回 `stale-turn` 并写入 `canceled`
状态（修复前测试在 30s 超时）；停止 turn 上被拒绝的裁决收敛到同样的终态结算（修复前为
`error` 且不写历史）。两条在父提交上失败、修复后通过；`apps/cli` 全量套件除为 race 读取的
`promptOutcome` 字段补全两个运行时 mock 外全部通过。
