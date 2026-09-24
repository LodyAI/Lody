# Steer Stop 与恢复所有权

Status: implemented
Translation: current

[English](2026-09-16-steer-stop-recovery-ownership.md)

## 摘要

Stop 可能使尚未完成准备或投递确认的 steer 一直占用会话操作队列。request-transport steer
也未纳入 raw ACP 收尾，迟到结果还能覆盖较新的输入或复活终态历史。现在本地等待与原始执行
分开结束：执行端持有所有权直到请求结束或确认执行已终止，并按精确的用户轮次 ID 投影结果。
投递未知有可见的、显式创建新消息的恢复入口，不盲目重放，也不新增 provider 对账协议。
这不是与 provider 提交原子一致的崩溃恢复凭据系统。

## 范围与依据

本次完成 [#477](https://github.com/LodyAI/Lody/issues/477) 与
[#666](https://github.com/LodyAI/Lody/issues/666) 中的 Stop 阻塞及孤立引导路径，延续
[pending-input 决策](2026-09-14-interrupt-pending-input-exactly-once.zh.md) 的 adapter
`applied` / `not-applied` / `unknown` 证据及取消策略。provider 对账机制保持不变；超时或
没有通知不能证明拒绝。当前行为契约仍是[待审 Spec](../../../../specs/session-history-writes.zh.md)。

## 所有权

| 状态                                | 所有者及释放边界                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| 本地准备或 application 等待         | 目标轮次的 abort signal；Stop 或 prompt 结束释放 steer 队列及 rewrite lease（handoff 见下）。 |
| 已发送的 ACP 或配置调用             | 既有执行 owner；请求结束或确认终止，共用五秒收尾期限。                                     |
| 明确拒绝的输入                      | daemon 独占的 `steerTurnStatuses` 精确 ID pending 激活；普通执行接管或历史缺失失败后清理。 |
| 历史尚未到达的 applied/unknown 结果 | 同一 map 中的精确 ID 投影；终态投影后清理，applied processing 保留到执行收尾。             |
| 前端 RPC 确认                       | 仅影响展示，绝不把终态历史回写成 processing。                                              |

已经进入 applied 交接的操作先完整提交所有权，再允许完成处理通过队列。
handoff adapter（内置 Claude，`upstreamTurn: 'handoff'`）会先返回被让出的 prompt，再报告
`applied`：旧 turn 先结束，adapter 要等 SDK 回放引导消息时才确认。因此引导一旦已提交，prompt
结束不会中止其结论等待，完成决策排在它之后：`applied` 交接给后继轮次，拒绝或未知结果走普通
完成路径。若中止该等待，owner 会把引导 prompt（即下一轮本身）当作残留请求收尾，五秒后终止
agent。Stop 与 same-turn（Codex）steer 不变。
steer 配置在每次后续
mutation 前检查目标 signal，但已经发出的配置调用仍纳入收尾。主 prompt 已返回、原始 steer
尚未结束时，重复 Stop 也不能中断仍在收尾的 owner。结果写入失败通过 `finally` 释放 application lease。

恢复 map 不回写 `latestUserMsgId`，也不清除其他输入的 missing-history tombstone；所有修改在
执行服务中串行化。watcher 先投影结果，再选择待执行输入。已应用的 steer provenance 排除普通
重启调度；失去执行 owner 的 applied-processing 投影变为 canceled。未知结果使用正式声明的
`delivery_unknown` 历史状态，既不调度，也不能编辑重放。恢复对话框提示可能重复执行后，才允许
创建新的用户轮次。

新 daemon 响应声明恢复所有权。promotion 失败只通过该 owner 重试一次，持续失败则向用户报错。
旧响应保留原有前端 fallback；这不是对旧版执行状态写入者的任意兼容保证。

## 备选方案与边界

只写历史无法应对元数据先到、历史晚到时的唤醒丢失。回退最新输入指针可能覆盖生产者刚发的
新输入；仅增加队列时间戳也无法保留究竟是哪条被拒绝输入仍在等待历史。精确 ID 投影同时避免
这两个问题，而不把 provider 投递决策搬进 dispatch。

本次不增加完整持久 receipt/admission ledger。队列行仍在历史接受时交接；生产者在发出 steer
之前崩溃，以及进程在记录 provider 结果前退出，都不具备事务性恢复。已记录结果使用既有元数据
持久化，但不能证明尚未记录的结果。缺少历史的结果投影保留到对应行到达；普通恢复输入沿用有界
历史等待。没有声称 live provider 的发生频率或普遍的 exactly-once 保证。

## 验证

确定性 executor 测试覆盖文档加载、prompt block 和配置等待中的 Stop/自然结束、第二条排队
steer、主 prompt 结束后的原始请求收尾、晚于被让出 prompt 返回的 handoff 结论（applied 或拒绝）、历史晚到前的 applied/refused/unknown 结果、较新激活
不被覆盖，以及后续普通消息执行。共享测试通过真正的 HistoryWriter 和 Loro peer import 验证
终态保护及 unknown 状态。前端测试覆盖终态之后的迟到 ACK 与 unknown 重发确认。原有终止失败
和内部取消测试继续保留。

当前 checkout 的 CLI 类型检查受已有 DeepSeek 子模块/profile 导出不匹配阻塞；文档检查也已存在
DSH usage-test 链接缺失。本次不改动这些已有子模块 checkout，未进行 live provider 验证。
