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
  重排队守卫；既有的应用后取消守卫不变。重排队同时覆盖条目尚未同步到本机的场景（受支持的
  RPC 先于历史到达顺序）。其指针决策在历史工作之后基于重新读取的 meta 运行，因此这些 await
  期间发布的 activation 绝不会被覆盖——执行侧只写自己的槽位。指针空闲时仅通过指针重排队并
  清除 race 分支遗留的 terminal-without-entry 记录，让迟同步的条目经 `pending_apply` 指针
  匹配进入分发而不是被修复回终态。更新的活跃 activation 持有指针时，回翻后的条目交给该
  activation 持续驱动的分发扫描；仍未同步的条目则保留 terminal-without-entry 记录——指针
  被占用时已无持久激活手段可发布，记录会让迟同步条目被修复回其终态（可见的未投递），而不是
  搁浅成永远不会被分发的 `pending_apply` 意图。

## 权衡与兼容性

- "终态而非重排队"是承重选择：未知裁决后自动重放有重复投递风险，报告明确排除该方案。终态
  只覆盖真正未知的窗口；agent 事后证明未应用时指南自动重排队，仅当裁决始终未知（例如连接
  关闭且无应答）才需要用户手动重发。
- 非取消结算标记为 `failed` 是唯一启发式：完成 turn 却不应答被扣 steer 请求的 agent 已偏离
  确认型 steer 契约，失败状态如实反映"无裁决"，而非断言已投递或未投递。
- 响应结算后每会话 steer 变更队列立即解锁；后续 steer 的排队顺序不变。
- 分发指针是单槽且 producer-owned，重排队的指针决策在历史工作之后基于新鲜读取的 meta 运行：
  依据 await 之前的快照做决策正是会话契约禁止的 read-await-rewrite，对 await 期间发布的
  activation 视而不见。更新的 send 持有指针时重排队不能夺回该槽位：保持指针不动，把回翻的
  条目交给该活跃 activation 持续驱动的按时间序扫描派发。此场景下尚未同步的条目已无持久激活
  手段——发布一个会把活跃 turn 搁浅，而迟到的 `pending_apply` 条目只能经指针匹配进入分发——
  因此重排队保留 race 分支的 terminal-without-entry 记录，迟同步条目被修复回其终态：可见的
  未投递，与 race 分支已经报告的终态结算一致。该角落的自动激活需要在会话 meta 中新增排队激活
  槽位，本改动刻意不引入。销毁更新的 activation 会在 watcher 卸载后让那个 turn 永久搁浅。
- `lastMissingHistoryUserMsgId` 是对其所指 turn 的永久一次性否定确认：恢复流程已上报过该
  投递失败，迟到的载荷不得复活已失败的 turn。重排队的指针写入只在它指向本 steer 时才清除
  该确认——绝不清除指向更早 turn 的确认，那些 turn 的载荷同步后必须继续被分发排除。

## 验证

两条回归测试复现报告场景：被扣裁决 + 停止 turn 时响应返回 `stale-turn` 并写入 `canceled`
状态（修复前测试在 30s 超时）；停止 turn 上被拒绝的裁决收敛到同样的终态结算（修复前为
`error` 且不写历史）。两条在父提交上失败、修复后通过。另有两条覆盖迟到裁决：结算后被拒绝的指南回到 `pending`
并重写分发指针，迟到的接受释放其租约。四条在细化前失败、细化后通过；`apps/cli` 全量套件
除为 race 读取的 `promptOutcome` 字段补全两个运行时 mock 外全部通过。

另有五条测试覆盖 review 指出的重排队边界：拒绝到达时条目缺失 → 经指针重排队并清除过期的
terminal-without-entry 记录（修复前永久搁浅）；更新的活跃 activation 持有指针时，条目缺失
→ 不写指针（保留其已记录的终态）、条目在场 → 仅回翻 `pending` 不改写指针（修复前会覆盖
新 turn 的 activation）；指针指向已处理完成的 turn、以及指针已被 `settledActivationUserMsgId`
退役两种情况都视为空闲槽位，重排队照常发布指针。前三条在父提交上失败。

另有三条测试钉住第三轮 review：活跃 activation 之下条目缺失 → 保留 terminal-without-entry
记录（修复前被清除，迟同步条目搁浅成不可分发的 steer 意图）；重排队的历史写入 await 期间
发布的 activation 会被指针决策观察到（修复前守卫基于 await 前快照，覆盖了新 turn 的
activation）；指向更早 turn 的 missing-history 确认在重排队的指针写入后保留（修复前被无条件
清除，会让投递失败已上报的 turn 重新进入分发），而指向本 steer 的确认仍被清除。前三条在
父提交上失败。
