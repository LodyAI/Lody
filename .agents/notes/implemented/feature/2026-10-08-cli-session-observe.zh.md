# 通过 CLI 公开 Session 观察

Status: implemented
Translation: current

[English](2026-10-08-cli-session-observe.md)

## 摘要

独立终端程序原本可以控制 Session，却无法附着已有 Session 持续接收结构化变化。
`session observe` 现在将现有元数据、控制状态与独立于后端的历史订阅包装为版本化
JSONL 流，使用持久化任务证据判断结果。Workspace 观察在一个进程中复用目录与
受限并发的文档打开，历史 idle 房间保持关闭。真实持久化文档测试验证了只读打开与
清理，真实认证 provider 执行及外部 Connector 联通尚未验证。
本次使用 Cloud CLI 路径，仅本地附着仍需单独的 daemon 适配。

## 决策与证据

实施用户同意的通用 CLI 增量，不增加 External Control API、Operation 模型或专门 UX，
也不需要 Connector 专属代码。[草案 Spec](../../../../specs/cli-session-observe.zh.md)
拥有当前行为说明；本文不构成 Spec 审批。现有不等待的 create/chat 回执已包含
Session 和 User Turn ID，消费者可先提交再观察；超时不能作为盲目重复创建的依据。

现有 wait 循环的终态判定可以复用，但单轮生命周期和正文更新不适合直接作为观察流。
抽取纯结果分类函数：User handled 与关联 Assistant finished/endedAt 同时存在才完成；
User failed/canceled 分别证明对应结果。保留 wait 原有 update/done 格式与错误行为。
Presence 消失或元数据 idle 都不能证明任务完成。

后端无缺口历史目录含任务身份与执行标量。分别订阅目录和控制状态，不在每次正文变化时
物化完整 transcript，也不绑定原始 Loro 历史。增量读取与投影比较只输出有意义的转换，
没有 token 流量。初始快照带最新结果，不重放旧任务；sequence 仅排序当前进程，
持久化观察缓冲由消费者负责。

## 职责与成本

- [session.ts](../../../../apps/cli/src/commands/session.ts)负责参数、选择、Cloud 初始化、
  元数据 watch 与进程清理。
- [session-observe.ts](../../../../apps/cli/src/commands/session-observe.ts)负责目录索引、
  串行刷新与版本栅栏、状态投影，以及有界有序 JSONL 输出。
  结构化输出期间临时将诊断日志转到 stderr。
- [session-observe-runtime.ts](../../../../apps/cli/src/commands/session-observe-runtime.ts)
  负责作用域内获取后端与文档、确认追赶同步和释放。
  独立命令 manager 仅在创建文档实例时传入 `skipAutoRead`，正常执行默认行为不变，
  清理保留状态。
- [session-observe-workspace.ts](../../../../apps/cli/src/commands/session-observe-workspace.ts)
  负责一份元数据目录、枚举期间的变化核对、并发上限为四的候选文档打开。
  活跃房间保留至新鲜持久化终态，再释放命令拥有的作用域。
  元数据快照表示执行状态 unknown，不是 idle；目录 ready 不代表历史房间就绪。

Manager 缓存没有引用计数，共用 daemon 实例后销毁会使其他订阅失效，所以观察使用
独立 manager。普通后端初始化会标记 pending 消息已读并写模型摘要，显式只读选项
避开这些写入。真实文件存储 fixture 检查只读打开、释放前后的操作版本、元数据和历史
均不变，并通过普通打开确实标记消息已读的正向对照验证测试有效性。

观察所有历史房间会为每个 Session 付出订阅和首次下载成本，因此使用元数据作为激活索引。
未打开 idle 文档的正文变化及没有元数据激活的重新打开不属于 Workspace 范围。
四限制同时获取，不限制活跃房间总量；需要持续完整观察某个 idle Session 时可单独附着。

## 验证与限制

确定性测试覆盖快速完成后的基线、完成双证据、快速连续任务、无 Assistant 失败/取消、
Assistant 重新打开、初始读取竞态、异步旧读取、新鲜度丢失与追赶、正文更新只读窄目录、
归档/删除、背压、断管和释放。对抗审查发现并修复历史尾部删除、重复 User 身份选择、
断线期间删除后的同步追赶；真实历史 writer 回归测试覆盖这三项。Workspace 测试覆盖 1,000 个 idle 房间、元数据 idle 时
继续持有任务房间、目录竞态、有界打开与获取期间退出。
原有 Session 命令与 wait 测试保持通过，针对性套件共 124 个测试通过。
CLI 与 Workspace 全量检查通过。
Cloud bundle 与发布导入检查在 4 GB 堆下通过；2 GB 构建耗尽内存，该预算尚未通过验证。
已执行构建后 CLI 的帮助与非法参数 JSON 输出。
合成 Git 测试需要在测试进程中移除继承的 Agent Git shim/上下文，未更改持久化环境或凭据设置。

尚未运行真实认证 CLI/provider 或外部 Connector E2E。
仅本地 follow 需要适配已有 daemon/本地传输；共享 SQLite 存储不是独立副本间的实时订阅。
权限回答、原生历史导出、外部请求 ID 和持久化事件日志不在本次范围。
已尝试跨工具记忆检索，但 Nowledge Mem 无法连接。
