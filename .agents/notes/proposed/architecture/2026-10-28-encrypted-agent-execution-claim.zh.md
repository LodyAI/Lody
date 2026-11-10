# 加密 agent 执行共用 claim

Status: proposed
Translation: current

[English](2026-10-28-encrypted-agent-execution-claim.md)

## 摘要

Meta/history 持久派发和实时请求可能表达同一个用户 turn，却拥有不同传输请求。
内存去重不能阻止 daemon 重启后再次启动。两个入口现通过已有 SQLite journal，
在创建、恢复 agent 或提交 prompt 前，以稳定的 `userTurnId` 获取执行 claim。
结果未知不会允许重试；生产授权默认使用同一工作区宿主，允许可选注入覆盖，缺少能力时拒绝启动。
本提案覆盖主机执行准入，不表示加密实时传输已经交付或产品端到端验收完成。

## 边界与授权

本变更扩展[主机 journal 边界](2026-10-26-e2ee-realtime-journal.zh.md)及其
[工作区恢复](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md)。
不改变 schema、原始帧凭据、clock floor、reset 后旧身份围栏或保留策略。
不增加迁移、超时接管、证据清理或明文回退。

```text
Meta/history -> dispatchPreparedSessionTurn --+
RPC offer -> watcher -> prepared dispatch ----+-> start/continue plan
                                                  验证原 turn 的 signer
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

生产 turn 来源解析由加密工作区宿主提供，不相信 History author 字段。自 owner 2026-11-10 决定起，
它验证和 turn 行存在一起的签名执行意图（[签名的执行意图](../../implemented/architecture/2026-11-10-e2ee-signed-execution-intent.zh.md)）：
用将要执行的调用配置重新计算内容摘要，按本工作区、本机、本会话和本消息检查签名。不涉及原始帧、重建或
`forkAt`，所以快照里带有同样的证据。

执行身份是已验证的签名设备及其账本 actor，后者以 `requesterCryptoUserId` 返回。
原生 `host.authorizeExecution` 从当前已验证账本解析设备，检查成员、角色及撤销状态；
加密 MVP 还要求 requester 与目标机器设备属于**同一个已验证账本 membership**。
其他当前有效 Member 返回 `e2ee_machine_not_owned`，显示“加密工作区暂不支持使用其他成员的机器”。
即使机器或项目被分享，本 MVP 仍不支持跨成员执行；机器所属成员的其他有效设备可以执行，
Guest/recovery/撤销设备仍拒绝。原件验签和当前权限仍是两项检查。UI 的 `requesterUserId`/turn 账号 ID 只作显示，
不与 crypto actor 比较、不选择权限，也不写进新执行 claim 的身份凭据。显示字段的修改
不改变执行输入。旧凭据含账号字段时仍按 session/turn 匹配，保留原字节和启动围栏。
机器不增加账号目录查询，也不推断账号到加密身份的映射。加密 watcher 不使用普通账号
可见性/目录准入，也不读取或发布账号权限快照；仍必须通过执行服务的已验证设备及同成员机器归属 gate。
普通工作区的机器可见性与项目共享准入不变。
因此同一用户的其他设备仍有效，也不能使被撤销设备的待执行 turn 获得授权。
缺少或无效的签名、执行输入被修改，都以各自的拒绝原因阻止新启动。快照签名者不是其中每条历史 turn 的原作者。

只有账本读不到时才保持 pending，不留下 journal start、失败、handled 指针或已完成 Inbox 输入。
watcher 复用现有每会话准入重试 owner。新证据会立刻唤醒它：宿主会报告每个收到的帧（按所属文档）
和每次确认的账本读取。定时器只做兜底，从一秒开始翻倍，最长五分钟。停止、取消观察或所有权变化会取消该 owner。
执行输入不适用任何时间窗口。

未来实时
入口须通过同一执行边界提供同等验证的原件和意图证据。错误仍是错误，取消归调用方
Effect fiber 管理。生产 `Lody.create` 默认调用同一宿主的 `authorizeExecution`；
`LodyOptions.authorizeEncryptedExecution` 保留为兼容的可选覆盖。缺少授权能力时拒绝启动；
省略覆盖回调会使用原生宿主授权，不会拒绝所有加密 turn。

执行键为 `(genesis, workspaceId, targetMachineId, agent-start:<userTurnId>)`。
不可变原件编码意图版本、会话、turn 和内容摘要。传输 request ID 及签名密文帧仍有各自
独立 journal 记录，不能代替业务执行身份。已启动 ID 下的不同内容会被拒绝，启动前就被取消的
输入记为已退役。completed 不再启动，已有终态历史保持不变，陈旧 pending 历史
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
- 确定凭据撤权：固定机器凭据端点产生的带类型移除/撤销错误不进入原件暂缺的重试 catch。
  宿主先同步关闭新执行准入、清空原生授权缓存，再复用移除回调，只 drain 当前工作区。
  整成员移除保留身份验证、持久凭据和托管数据擦除流程；单设备撤销只停止/关闭，保留本地原件，
  不冒充整成员移除。网络错误、看起来像移除的任意消息及未知授权失败不触发该终态流程。
  原生 Scope 继续持有刷新 I/O 直到实际 close；同步失效会拒绝缓存授权和进行中的授权结果。
  SQLite claim 内还同步检查入口是否开放，阻止关闭后迟到的授权结果（包括注入实现）启动。
  既有 completed/uncertain 证据仍可读，绝不因此允许再次执行。
- 结束：turn body 结束后保存固定的小型结束标记。它不是加密响应，也不证明业务成功。
  finish 写入失败由 turn 内被观察的 warning 边界记录，start 保持 uncertain；不会重做
  业务操作或阻塞独立资源释放。journal 原有的精确结果重写能力仍然保留。

来源凭据只存密文和公开操作范围，不存解密后的 prompt。它们是认证证据，不是第二个
执行 claim 或权限缓存；realtime journal 仍是唯一持久执行门。每次查询关闭 SQLite
句柄，执行前清理解密缓冲区和临时 Loro 文档。不清理来源证据，也不替换成快照作者。

新 gate 在现有 turn fiber 中组合原生 Effect，只适配同步 SQLite 叶子。不启动嵌套 runtime，
不引入全局失败缓存或实时连接依赖。来源缺失时才做有界网络补取，正常保留来源的派发
不增加补取 I/O；现有 watcher 管理延迟准入重试。完整的
Session/Repo/MessageHandler 迁移仍因现有 Promise 依赖而延后；本改动不声称迁移完成。
本地 journal 写入是必要的正确性工作，本改动不声称已测得端到端延迟改善。

## 证据与限制

执行服务回归测试在消费方接线前 RED：两个独立服务实例对同一 turn 提交两次。
共用 SQLite gate 后 GREEN。合成测试覆盖 RPC 与 prepared 持久派发重叠、重新打开的
completed/uncertain 日志、持久 create 被拒绝或过期、断连后不重试、损坏工作区隔离、
普通及健康工作区执行、精确意图绑定、准入前取消、时钟回退、结束写入失败、已使用日志
主文件丢失以及显式 reset。组合测试验证惰性访问、缺少能力时拒绝及普通路径没有 gate。
原 journal 与 dispatch 测试也参与本地验证。

测试使用真实 SQLite、注入时间和显式同步信号，不断言吞吐量阈值，也不证明真实加密
网络交付。真实签名账本、内容帧和 SQLite 测试还覆盖来源日志重开后的设备归属、同一
用户设备撤销、显示账号独立、内容修改、验签拒绝及相同 peer/counter 的内容替换。
临时移除设备检查使回归 RED，恢复后 GREEN；真实 UI 账号及显示账号不影响 journal 的回归
在旧账号/crypto 比较下 RED，移除后 GREEN；精确内容替换测试也在改为向依赖
快照导入实际签名字节前失败。生产构造回归使用真实 custody、签名账本与内容、SQLite、
原生授权和实际 `Lody.create` 组合，不注入授权回调或 mock host；合成 cloud I/O 提供
签名记录，ACP 测试边界记录 prompt 提交。缺少生产适配器时 RED，默认接通同一宿主后
GREEN。原生生产回归还覆盖有效显示账号不能使设备撤销前、成员降为 Guest 前或成员移除前
签署的 update 获得当前执行权限。新增原生/SQLite RED→GREEN 用例证明：归属限制前有效跨成员
请求会实际提交 prompt；接入终态观察前，真实带类型的补取撤权错误会留下可用缓存；SQLite
最终围栏前，关闭后迟到的注入授权仍能获取 start。同成员另一设备、普通网络重试作为正向对照。
真实凭据响应解析不相信仅消息文本像移除的错误。普通 `not_visible` 和 `project_not_shared`
仍明确拒绝派发。新增 RED→GREEN 回归覆盖另一设备签署的真实验签快照、延后获得原件而不写
终态、原期限过期、真实 Streams HTTP 向后读取解析、有界 I/O 取消，以及 watcher 停止
时取消重试。这些测试不代表生产交付。
