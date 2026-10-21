# 跨会话后续指令接入带确认的 Steer

Status: implemented
Translation: current

[English](2026-10-21-mcp-chat-hidden-pending-input.md)

## 摘要

跨会话 MCP chat 在接收方工作时仍追加普通历史输入。daemon 可以先将它确认成
seen，而消息仍在等待普通调度，让用户以为活动 Agent 已收到新指令。现在目标
存在活动 assistant 且确认支持时，chat 复用已有带确认的 Steer，其他情况保留
普通准入。本次接入沿用已有生命周期所有者、固定输入身份及应用不确定时不重放
的规则，没有在报告者安装的运行环境上完成复现。

## 证据与范围

最初调查基于 `4cc74cae8` 的当前工作区。MCP 单发、批量及旧版 chat 处理器均以
委派 requester 调用 `sendSessionChatResult`。原函数追加 `pending` 历史并发布
普通激活，watcher 在活动回合后串行执行。自动回执可以先将它改成 `seen`，用户
消息行显示 Delivered；输入框队列只读 `mq`，因此不包含这批历史积压。

临时真实 Loro 存储实验复现了两条 Agent 消息成为 seen/Delivered、`mq` 为空且
reducer 因活动所有权拒绝执行的组合，调查后已删除。它不能证明截图版本的精确
请求路径或数小时活动标签的成因。仅凭尚未行动，不能认定某个已安装版本没有
提交 steer；已提交输入不能因为没有可见动作就再发一次。没有执行或提交附件中的
会话原文及嵌入任务指令。

## 最终行为与所有权

```text
MCP chat + 固定输入身份
  -> 确认支持原生 Steer 且存在活动 assistant：追加惰性的 pending_apply
     -> 既有接收方 Steer 所有者检查冻结的精确目标
     -> 已应用 / 确认拒绝后恢复 / 应用不确定时不重放
  -> 其他情况：既有普通历史 + 调度
```

范围仅为持久化委派 chat，包含批量物化和现有 Operation 恢复调用方。没有 Operation
的旧版 chat 缺少物化恢复所有者，因此保留普通准入。普通 CLI chat、
会话创建、自动 Inbox 结果投递 和队列操作沿用各自准入。历史中的活动 assistant
观察即使过时，也不能授权 steer 新回合；接收方核对 `expectedTurnId` 并拥有拒绝及
恢复。输入 id、requester、author、链深度、目标 Role、执行配置和附件引用仍来自
已接受的那一份输入。

`_lodySteerExpectedTurnId` 是可选、显式声明的历史 input-config 字段，新写入和
读归一化都保留它。首次请求前冻结目标回合；即使最新 assistant 或能力缓存变化，
重试仍使用已存目标和配置。guide 不发布 `latestUserMsgId` 或普通 dispatch RPC。
首次提交与恢复使用同一函数，不新增公开 MCP 参数或手动操作。当前 daemon host
和已有 Machine RPC 均进入同一个带访问检查的接收方 Steer 服务。

Provider 提交前，无结果所有者的访问/历史重写拒绝保留惰性历史，由现有 Operation
物化器按相同身份重试。一旦请求可能发出，传输失败不能激活普通调度或删除输入，
迟到的应用结果仍归接收方。已提交 ledger 记录在历史投影追上前也视为目标输入
已经持久物化。投影成 `delivery_unknown` 时，编排以目标失败收尾，不再提交。
原 runtime 结束后收到的重复请求，不能把已提交的 applied/unknown 记录改写为
未应用并激活普通执行。原 Provider 请求仍可凭明确未应用结果使用既有恢复，
重复请求本身不具有这项证明。

Steer 成功沿用现有可见回合交接：封口旧 assistant，将新 assistant 绑定到新用户
回合 id，并在后续工具执行前转移因果身份。Operation 完成仍读取这个固定输入的
assistant 输出。本次没有增加 Provider 实现、队列迁移、合成投递阶段、新计时器或
取消所有者。

## 替代方案与迁移评估

修改回执文案能够澄清等待，但不会让指令进入活动 Agent。让所有 chat 进入 `mq`
还会改变混合来源排序、队列提升和委派来源保留，对本次选择的 Steer 行为没有必要。
给已有输入再加一次手动 Steer 发送可能重复工作，不是本修复。

按 feature/fix 模式使用 Effect skill。PR 已移植到 `a8cffe6f1`：恢复判定
位于现有原生 Effect 工作流，通过其带类型的历史端口读取 Steer ledger。
回合/Steer 与文档生命周期继续使用已有 Promise 所有者，不新增迁移单元或完成声明。

## 验证与限制

PR 基线上的七个 CLI 测试套件通过 601 项，涵盖命令准入/MCP 单发和批量、本地
零云路由、执行/Steer、dispatch watcher、coordinator 与有界模型。共享 schema
测试通过 56 项。回归覆盖惰性准入、普通回退、冻结目标及配置重试、不确定时不
重放、runtime 结束后的重复请求、Operation 结果身份，以及重启后接纳已提交
ledger。现有执行测试覆盖 Stop、回合结束、拒绝 steering 与迟到结果。

根目录格式检查通过。未运行打包桌面、实际 Provider、远程机器和混合版本/降级
验收。没有接收方应用证据的传输失败仍遵守现有不确定契约，不保证模型一定消费，
也不承诺开始行动的最长时间。

根目录工作区类型检查、带类型 lint、公共/平台/进程边界检查及国际化检查通过。

根目录 `pnpm check` 通过，包含全部仓库测试阶段；CLI 为 4471 项通过、4 项跳过。

文档检查保留 subagent-events 中英文记录中的六个既有失效链接，没有新增错误
或 SHA 保护主题。

## 相关契约

- [MCP 实现](../../../../apps/cli/src/mcp/README.md#chat-configuration)
- [编排意图草案](../../../../specs/session-orchestration.zh.md#跨会话后续指令投递)
- [Seen 回执竞态](2026-09-28-send-delivery-seen-race.zh.md)
- [Steer 停止与恢复所有权](2026-09-16-steer-stop-recovery-ownership.zh.md)
- [不支持 Steer 时的输入框队列](2026-09-21-unsupported-steer-regular-queue.zh.md)
- [草稿 PR #1771](https://github.com/LodyAI/Lody/pull/1771)
