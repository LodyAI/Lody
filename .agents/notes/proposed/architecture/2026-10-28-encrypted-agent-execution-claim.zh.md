# 加密 agent 执行共用 claim

Status: proposed
Translation: current

[English](2026-10-28-encrypted-agent-execution-claim.md)

## 摘要

Meta/history 持久派发和实时请求可能表达同一个用户 turn，却拥有不同传输请求。
内存去重不能阻止 daemon 重启后再次启动。两个入口现通过已有 SQLite journal，
在创建、恢复 agent 或提交 prompt 前，以稳定的 `userTurnId` 获取执行 claim。
结果未知不会允许重试；授权仍由注入能力负责，缺少实现时拒绝启动。
本提案覆盖主机执行准入，不表示加密实时传输已经交付或产品端到端验收完成。

## 边界与授权

本变更扩展[主机 journal 边界](2026-10-26-e2ee-realtime-journal.zh.md)及其
[工作区恢复](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md)。
不改变 schema、原始帧凭据、clock floor、reset 后旧身份围栏或保留策略。
不增加迁移、超时接管、证据清理或明文回退。

```text
Meta/history -> dispatchPreparedSessionTurn --+
RPC offer -> watcher -> prepared dispatch ----+-> start/continue plan
                                                  验证原 turn 的 signer/user
                                                  authorize(workspace, device)
                                                  journal claim(userTurnId)
                                                  创建/恢复 agent、提交 prompt
                                                  保存结束标记
```

`LodyOptions.authorizeEncryptedExecution` 与
[#1991](https://github.com/LodyAI/Lody/pull/1991) 的 `host.authorizeExecution`
采用相同调用及结果形态：

```ts
type AuthorizeEncryptedExecution = (
  workspaceId: string,
  requesterDevice: string // 已验证的设备签名公钥，小写 hex
) => Effect.Effect<
  { readonly _tag: 'Authorized' } | { readonly _tag: 'Denied'; readonly reason: string },
  unknown
>;
```

生产 turn 来源解析由加密工作区宿主提供，不相信 History author 字段。Streams binding
新增 `openAuthenticated`，在验签与 AEAD 校验后返回历史设备和成员身份；SDK 使用的
`open` 仍只返回明文字节。对 Loro update，宿主将原密文、AAD 和签名操作范围存入
工作区本地 `execution-origins.sqlite`。执行前重新打开并验证原件，从 update 的依赖
状态派生临时文档，再导入**实际签名字节**，匹配选中 turn 的创建操作、用户、时间戳、
输入配置和内容。同时匹配执行服务冻结的配置，并在异步验证后重新检查当前投影。
仅操作编号不能证明内容：另一份有效签名帧可以重用 peer/counter 编码不同操作，不能
直接从当前文档的相同编号状态推断签名覆盖的内容。

验证所得历史 actor 必须等于 `requesterUserId`（账本的规范十六进制用户身份）；代码
不根据资料目录猜测普通账号到加密用户的映射。已验证设备公钥再交给注入的当前权限
检查。因此同一用户的其他设备仍有效，也不能使被撤销设备的待执行 turn 获得授权。
缺少原件、签名者证据冲突、执行输入被修改或 signer 与用户不一致，都拒绝新启动。
快照签名者不是其中每条历史 turn 的原作者；只有快照的 turn，在原始签名 update
可用前没有执行来源证明。

持久 History 的原执行窗口截止于已认证 turn 时间戳后 15 分钟。重新打开来源证明或
刷新权限缓存不会延长它；宿主从账本读取起算的 15 分钟权限缓存是独立期限。未来实时
入口须通过同一执行边界提供同等验证的原件和意图证据。错误仍是错误，取消归调用方
Effect fiber 管理。本改动已接入宿主来源解析，生产新鲜度能力注入仍单独完成；缺少
`authorizeEncryptedExecution` 时继续拒绝新启动。

执行键为 `(genesis, workspaceId, targetMachineId, agent-start:<userTurnId>)`。
不可变原件只编码意图版本、会话、turn 和请求用户。传输 request ID 及签名密文帧仍有各自
独立 journal 记录，不能代替业务执行身份。首次执行期限在重新授权和时钟回退后保留；
缩短的替换期限拒绝执行。completed 不再启动，已有终态历史保持不变，陈旧 pending 历史
显示拒绝原因。已 start 但没有确认结束的记录显示“结果未知”，不能接管。

## 所有权、取消与故障隔离

- 触发与 owner：每个加密 Lody 工作区在签名密钥隔离的内容目录下，惰性持有一个 journal。
  SessionExecutionService 现有 turn fiber 管理授权、claim、真实 ACP 工作和清理。
  普通工作区没有 gate，也不打开执行数据库。
- 取消与交接：claim 前取消不留下启动证据；claim 后，即使 prompt 尚未提交也保留保守的
  uncertain。现有 ACP drain 和会话释放 owner 不变。加密提交断连后不使用普通路径的
  stale-connection 重提，因为没有输出不代表对方未接收。普通恢复行为仍由现有测试覆盖。
- 故障与恢复：journal 打开或 claim 失败只拒绝当前工作区的 turn，不阻塞内容启动、其他
  工作区或普通派发。来源凭据写入失败不会阻塞内容同步，每次故障期只给有限诊断；
  缺失或不可读的来源凭据拒绝相应启动。两个存储均采用零 SQLite busy timeout。主文件丢失但 control 证据仍在时是错误，
  不悄悄创建替代日志。显式 reset 保留旧执行身份围栏；新用户 turn 使用新键。
- 结束：turn body 结束后保存固定的小型结束标记。它不是加密响应，也不证明业务成功。
  finish 写入失败由 turn 内被观察的 warning 边界记录，start 保持 uncertain；不会重做
  业务操作或阻塞独立资源释放。journal 原有的精确结果重写能力仍然保留。

来源凭据只存密文和公开操作范围，不存解密后的 prompt。它们是认证证据，不是第二个
执行 claim 或权限缓存；realtime journal 仍是唯一持久执行门。每次查询关闭 SQLite
句柄，执行前清理解密缓冲区和临时 Loro 文档。不清理来源证据，也不替换成快照作者。

新 gate 在现有 turn fiber 中组合原生 Effect，只适配同步 SQLite 叶子。不启动嵌套 runtime，
不引入进行中请求表、定时器、全局失败缓存、网络等待或实时连接依赖。完整的
Session/Repo/MessageHandler 迁移仍因现有 Promise 依赖而延后；本改动不声称迁移完成。
本地 journal 写入是必要的正确性工作，本改动不声称已测得端到端延迟改善。

## 证据与限制

执行服务回归测试在消费方接线前 RED：两个独立服务实例对同一 turn 提交两次。
共用 SQLite gate 后 GREEN。合成测试覆盖 RPC 与 prepared 持久派发重叠、重新打开的
completed/uncertain 日志、持久 create 被拒绝或过期、断连后不重试、损坏工作区隔离、
普通及健康工作区执行、精确意图绑定、准入前取消、时钟回退、结束写入失败、已使用日志
主文件丢失以及显式 reset。组合测试验证惰性访问、缺省拒绝及普通路径没有 gate。
原 journal 与 dispatch 测试也参与本地验证。

测试使用真实 SQLite、注入时间和显式同步信号，不断言吞吐量阈值，也不证明真实加密
网络交付。真实签名账本、内容帧和 SQLite 测试还覆盖来源日志重开后的设备归属、同一
用户设备撤销、用户不匹配、内容修改、验签拒绝及相同 peer/counter 的内容替换。
临时移除设备与用户检查使回归 RED，恢复后 GREEN；精确内容替换测试也在改为向依赖
快照导入实际签名字节前失败。新鲜度仍由独立宿主能力注入，测试不代表生产交付。
