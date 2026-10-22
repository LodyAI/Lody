# 主任务与子任务共用工具历史预处理

Status: implemented
Translation: current

ACP schema 保留 content/location 列表的省略状态，不再自动填成空列表。
图片生成客户端显式发布没有 content 的初始状态，保持原有回调约定，不再依赖 schema 默认值。

[English](2026-10-22-bound-child-tool-history.md)

## 摘要

规范子任务工具此前绕过主任务预处理，保存完整 read/edit 正文、通用 raw 输出与 provider
metadata。现在两条路径在写入 CRDT 前使用同一个工具投影和合并函数。路径、状态、稀疏
更新、审批计划和绑定原轮次的编辑证据继续保留；子任务工具详情不再保存完整 read/edit
正文。新收到的工具数据遵循已有主任务限制。已有超大文档和导入内存优化仍需单独处理，
本次没有重写生产数据。

## 决策与实现

`packages/shared/src/acp/history-apply.ts` 统一拥有
`buildToolCallMessageForHistory` 和 `mergeToolCallMessage`。先从旧工具补齐 kind，
丢弃 diff 前提取路径，保留显式列表清空、状态不倒退，并复用命令与输出限长。
通用 raw 字段和 provider metadata 不能绕过投影。两条路径均只保留模式切换的
`rawInput.plan`，以及原有定时工具 raw 字段、时区和首次记录时间。子任务原生身份独立保留。

`acp/schema.ts` 保留初始调用省略 content/locations 的语义，不自动补空数组，避免稀疏更新
或重放初始调用清掉旧值。CLI 编辑回调继续消费补全后的执行通知，绑定已提交 run 的原始
所属轮次，不依赖保存的 diff 正文。权限补全仍保留已有内容；这是 ACP 新写入规则，
不是清理旧文档或普通图片附件的通用过滤器。

这次明确替代[图片与资源清理](2026-10-11-drop-tool-images-from-history.zh.md)中完整保留
子任务 diff 的决策。[现有 Spec](../../../../specs/subagent-events.zh.md)同步记录新的保留语义。
如需离线精确回放工具 diff，应另设有界详情读取；当前文件预览不能替代历史编辑证据。

## 懒加载分析

Loro `loro-crdt@1.16.3`（`ad5b2a6d4`）在
`state/container_store/inner_store.rs::decode` 懒初始化快照状态。
容器值和 SSTable 块已有有界缓存，分别为 2048 个值和每表 4 MiB。
但这不代表按视口拉取字节：完整编码快照仍驻留内存，WASM 绑定复制 JS 输入，
`encoding.rs::decode_snapshot` 又把正文复制为拥有所有权的字节。
`LoroMap.toJSON()` 递归读取子容器。Lody 的 `session-data/loro.ts::asStoredTurn` 用它读取
完整轮次，`use-conversation-stream-items.ts` 初始保留 40 轮。
所以所属轮次被读取时，即使子任务弹窗关闭，其 transcript 仍会一起加载。

增量导入还会对旧历史计算状态差异，change block 可能解码进入共享 arena。
小增量引起的大幅增长必须与首次快照导入分开定位。上游可研究输入所有权转移、
大型解码值按字节控制缓存，以及减少增量导入解析的旧历史；应用侧应研究按子任务和
item 范围读取；[按需子任务读取](2026-10-22-lazy-subagent-transcript-read.zh.md)已另行实现。这些是分析与提案，尚未实现，也不能据此声称打开时解析了所有旧操作。

## 已有文档与验证

删除可见字段不会从普通完整快照中消除其操作历史。压缩副本或 shallow snapshot 是独立
恢复机制。同一会话切换需要 generation 与旧写入者策略；shallow snapshot 需证明
frontiers、待提交修改、持久化和重连兼容。不能隐式替换线上快照或在读历史时重写。

真实 HistoryWriter 测试比较主任务和子任务的 read/edit/execute/计划写入、raw 输出形态、
省略 kind/status 的稀疏更新、列表清空、初始调用重放和快照重载。
CLI 集成测试验证过滤后的子工具跨批次仍向原轮次发出完整编辑证据。
Shared 测试与类型检查、CLI 历史和权限测试、格式及文档检查在固定公共源码的独立副本运行。
生产文档与操作测量不进入公共仓库；尚未证明真实 iPhone 的内存验收结果。
