# 使用原子 Native 增量限制 Roost 流式写入

Status: implemented
Translation: current
PR: [#1626](https://github.com/LodyAI/Lody/pull/1626)

[English](2026-10-16-roost-storage-write-amplification.md)

## 摘要

原流式路径每次替换整条正文，并在 SDK 批次收据 Turn 中保留完整命令及基线快照。
合成对照中，最终 42,939 字节的一条消息经过 128 步后数据库达到 56.2 MB，
而 Native 文本 splice 仅约 0.37 MB。现在已有可变消息使用已安装 Native API
原子的字段/文本编辑和紧凑本地操作收据，在保持幂等恢复的同时，不再为每个 chunk
保存另一份整条快照。真实 SQLite 测试验证了 128 次输出、回复丢失和重启后的更新字节及
投影行数预算。既有大数据库没有压缩，这些结果也不证明生产时延的原因。

## 证据与版本更正

旧 `planTurnWrite` 发出 `setContent(encodeRoostContent(after))`。
已安装 TypeScript SDK 的 `writeIndexed` 替换整个 content 字段；
`commitBatch` 创建含 `commands` 和 `bases` 的 `batch_receipt` Turn，
`encodeProjected` 在每个 base 内保留完整正文。最终提交封存收据，但不删除这些快照。

更正：所检查的 TypeScript 包为 `@loro-dev/roost@0.1.3`，不是最初标注的 0.1.2。
Native 为 `@loro-dev/roost-node@0.1.2`，源码版本
`9845bea5170f7a3e4935ce4ff12d5245febc80f9`。安装版本和锁文件均未改变。
另一份本地仓库没有这个 Native 发布版本，不能作为发布版本匹配的证据。

Native Worker 仍然在 Lody 共享数据库上一次执行一个请求。
上层读写池不能抵消不断进入该 FIFO 的大快照事务。

## 合成 SQLite 对照

六次本地运行使用已安装 Native 客户端及 `NodeLodyHistory`。
每条消息包含不变的 8 KiB 工具结果、96 个小字段，每步追加 256 字节文本。
同一组步数的最终内容一致。先关闭 owner，再只读聚合；
没有网络、真实消息、sleep 或时序断言。

| 步数 | 写入路径 | 最终 JSON 字节 | 数据库文件字节 | 投影行数 |
| --- | --- | --- | --- | --- |
| 64 | Native splice | 26,555 | 237,568 | 224 |
| 64 | Native 整条替换 | 26,555 | 2,781,184 | 224 |
| 64 | SDK 批次替换 | 26,555 | 20,144,128 | 31,773 |
| 128 | Native splice | 42,939 | 372,736 | 240 |
| 128 | Native 整条替换 | 42,939 | 7,557,120 | 240 |
| 128 | SDK 批次替换 | 42,939 | 56,217,600 | 65,373 |

128 步批次包含一条可见消息及 128 条隐藏收据。
投影键值为 10,211,755 字节，updates 为 10,408,926，outbox 为 10,396,622。
文件大小包含 SQLite 页和索引开销，不是累计 I/O。
Native 整条替换仍只有 240 条投影行，因此 JSON 每节点一行不能独自解释 65,373 行。

探针脚本及聚合日志在仓库外，临时合成数据库已删除。
用户报告的 19.5 GB 是已经发生的故障，不能用本机因使用少而只有 2.8 MB 来否定。
这里没有独立测量其生产统计及延迟。

## 已实现的写入边界

已安装的公开 Native API 已支持带编辑守卫及 index puts 的原子 `writeBatch`，
因此不必升级 SDK 或复制其批次 saga 实现。

现有校验及批次准备之后，符合条件的已存在、未封存 primary/state 记录使用
精确 sequence 守卫的字段操作。文本追加使用 `appendText`，
其他文本修改使用 Unicode scalar 偏移的 `spliceText`。
对象、列表、增加和删除保留未变化正文；完成可变 primary 时在同一事务内 seal，
其 seal 守卫按 content 操作数量推进序号，而不是按一条批次推进。
所有受影响编辑与逐项收据一起在 generation 的 Native 游标守卫下提交。

本地 `lody_agent_operation_receipts_v1` 索引以规范 publication 身份为键，
仅保存版本及 digest，不包含命令、正文或基线快照。
查询同时检查保留的 generation 祖先及旧 SDK 收据，保持重启和分支交接后的重试/冲突行为。
这是 owner 本地操作日志，不是远端复制的接受证明。

新记录、拼接 primary、没有可变 state 的已封存目标、过大批次及非 publication
合同仍走 SDK 路径。不可变真人输入、权限、generation/分支激活及其签名恢复证据
不转换到此本地日志。Native 错误向上传递，不把失败或结果不确定的原子写入
再次交给 SDK 路径重试。

## 更正：ACP 编码与命令检查点

首个本地发行包暴露了 Native 增量规划器的回归。上游运行时已保存非空的 assistant
回复，但 Lody 的 ACP 缓冲反复因 `non-JSON application value` 无法写入。
合法、稀疏的工具通知经过共享 ACP 历史转换后，会带有显式 `undefined` 可选字段。
SDK 正文编码器原本遵循 JSON 的空缺规则，Native 规划器却把新增 item 和嵌套对象
直接传给 Roost 的严格 application JSON 转换，因此一个工具更新也会堵住后续正文。

新增子树现在复用正文编码器的规范化：对象空缺省略，数组空缺转为 `null`，
已有数组的逐项差异也遵循相同规则。只编码变化的子树，不重复序列化未变的大正文。
连续链路测试同时发现独立的检查点错误：`applyAgentBatch` 在有限批次之间推进 CAS
游标，若从这个可变游标发布，就丢掉整条命令的变化区间。语义收据现在单独保留
命令起始游标，与 Native 当前写入守卫区分。

验证范围更正：之前的存储、纯文本及重试检查没有连通合法稀疏 ACP 工具通知、
Native 写入与其他客户端的增量正文读取，不足以作为发行验收。
所属套件现在覆盖真实 MessageHandler 缓冲、用户/assistant 条目、工具开始/完成、
跨多个 Native 批次的 31 个正文片段、JSON 序列化后的历史 RPC 正文与重启读取。
独立 Native 用例覆盖稀疏工具的重试幂等及嵌套可选值；两个编码回归在修复前
都能触发发行环境中同一个异常。它们是使用已安装 Native SQLite 的合成本地合同，
不调用模型或网络，也不代表真实云端 Agent 或浏览器验收。

[查看端严格审查](2026-10-16-roost-peer-reader-readiness.zh.md#严格审查更正reset-判断的是覆盖证据)
把生产 RPC 加解密端点和两个渲染器副本加入同一消费者链路，并覆盖原生提交成功但回复丢失。
其中发现的 reset 快捷路径是渲染器恢复缺陷；这项更正不需要继续修改原生写入。

## SQLite namespace 统计

流式预算测试直接检查临时 Native SQLite 数据库。三处统计查询同时支持当前安装的
container v3（`roost_kv.space`）和 namespace 整数引用的 v4（通过 `space_id`
关联 `roost_spaces.name`）。测试内的查询关系为两种格式提供相同的
`space/key/value` 列，并显式断言支持的版本；更新字节、回执行数和投影行数预算不变。
统计查询本身不改变生产读写行为。
配套存储改动：[Roost #15](https://github.com/loro-dev/roost/pull/15)。
统计兼容 PR：[#1735](https://github.com/LodyAI/Lody/pull/1735)。

Roost 0.2.0 已统一发布。PR #1735 在共享 catalog 固定 TypeScript 和 Native
两个包，并让锁文件及发布冷却期豁免保留全部六个精确匹配的平台包。Native 运行时
因此升级到 SQLite container v4，拒绝更早容器，不迁移、不自动重置、不清理数据。
依赖它的[消息状态修复 #1737](https://github.com/LodyAI/Lody/pull/1737) 复用同一次
catalog 更新，在 #1735 后合并。验收改用 npm 正式包，不再使用本地 SDK 产物。

使用 npm 正式 0.2.0 包、没有 Native 覆盖时，冻结安装、完整 `pnpm check`、
全仓格式和文档检查通过。CLI 全量 4,429 项通过、4 项原有跳过，包含流式存储预算
及重开。Electron 四项 Native staging 测试通过：其他平台使用合成绑定验证选择，
本机安装的真实绑定执行签名 SQLite 写入及重开。Native 发布 manifest 对应已合并的
Roost 源码 `e85c970`；这不代表在本机完成其他平台的运行时验收。

## Outbox 与既有数据

Outbox 行数不等于待发送数量。已安装 TypeScript Store 的 ACK 推进消费者游标而不删除行，
所以 updates/outbox 数量相同不能证明消费者从未前进。
待发送字节需要实际消费者、持久交付游标以及远端配置。

Lody 渲染器使用 owner RPC，不是独立 Native 副本同步。
本修复不启动 Native 上传、不伪造 ACK、不裁剪签名事件，也不删除旧收据 Turn。
热路径不再放大快照，使新 outgoing payload 变小；outgoing 副本保留仍属于 SDK 决策。

既有数据压缩需要单独验证的 SDK/存储合同，保留签名历史校验、恢复、分支状态和所需重放覆盖。
交接之前应验证隔离替代数据库，并保留回滚。`VACUUM` 无法删除仍存活的收据/日志副本。
没有修改或清理真实应用数据库。

## 验证、所有权与替代方案

所属 SQLite 合同套件在较大不变工具结果旁追加 128 个不同 Unicode chunk，
验证最终正文、投影少于 1000 行、128 条紧凑收据、编码 update 键值小于 1 MiB。
随后重新打开会话并重试最终稳定 item，不重复输出。
该预算不是数据库文件大小或墙钟性能测量。
最终 72 项所有者测试在已安装的 Native SQLite 实现上通过，包括 scalar 偏移的中部编辑、
数组变化及多操作封存。最终跨模块检查及全套运行限制记录在
[跨成员读取后续说明](2026-10-16-roost-peer-reader-readiness.zh.md#验证及限制)。

同一套件覆盖 Native 已提交但回复丢失、重叠逐项重试、冲突身份、状态修改、权限、目标、
generation 交接及分支回滚。写入排序和真实写入所有权仍由现有 generation/backend 管理。
调用者取消不能证明写入未提交，重试结果必须由持久收据决定。
纯增量规划保留普通 TypeScript，没有新增 Effect runner 或升级版本；
不把未完成的 Promise 包装称为原生迁移。

增大并发不能解决串行 Native FIFO，因此没有采用。
丢弃待恢复收据或日志可能破坏恢复，也没有采用。
SDK 扩展仍可覆盖其他写入情形，但已有原子 API 足以完成本次有界热路径修复。

相关决策：[增量恢复](2026-10-16-roost-incremental-history.zh.md)、
[跨成员观察](2026-10-16-roost-peer-reader-readiness.zh.md)。
已有[历史写入 Spec](../../../../specs/session-history-writes.zh.md)仍为 draft。
不声称已验证生产时延、迁移数据库或部署。
