# Automation 待处理观测与 Stop 准入

Date: 2026-10-30
Status: implemented
Translation: current

[English](2026-10-30-automation-pending-observations-and-stop.md)

## 摘要

Automation 恢复扫描把 Hash 身份当作游标，还会越过尚未确认的结果。
现在直接按重试期限查询持久化的待处理记录，完全删除扫描游标。
Stop 不再拒绝已授权的条件求值或读取：匹配后的 continuation 在准入处保持 blocked，
等待用户明确恢复，Cancel 则撤销它。修复沿用现有 Wait 与 receipt 状态，落实
[协调器契约](../../proposed/architecture/2026-10-25-session-automation-coordinator.zh.md)。

## 决策与所有权

待处理表已经表示未完成的观测，不需要第二份恢复进度。Hash 仍负责去重。
Workspace 的现有恢复循环每次选择最多 100 条到期记录，在读取资源所有者前持久化
15 秒后的重试期限，只有成功处理才删除。未确认的 release 与读取失败保留记录，
不会阻塞后续观测；新的 release 证据会把期限重置为立即检查。
SQLite schema v2 在同一事务中添加期限列并更新版本，保留 v1 的全部 payload。
行顺序仅用于相同期限的调度，不记录消费进度。

旧游标在空扫描后会重置，因此较小 Hash 并非必然永久丢失，而是可能延迟到回绕。
持续出现的后续批次仍可能让较小的新身份和未完成记录无限延期。
单调游标能修复插入顺序，但仍需要独立的待处理扫描；直接使用现有待处理表，
可以消除这两份职责。

Stop 是执行准入屏障，不是读取权限。Session 所有权、机器、删除与归档检查保持有效。
已停止时条件可返回 false，也可匹配并进入现有 blocked receipt。
准入分别报告 `target_stopped` 与 `target_archived`；即便目标配置了
`onUnavailable: fail`，Stop 仍只阻塞。恢复后重新检查接纳条件，再准备和提交同一 invocation，
不新建 Wait。本地 UI 将停止原因映射到已有提示，仅在用户点击时调用现有协作树恢复操作，
失败通过已有错误消息显示。

Fleet 持有 Workspace ledger 与恢复循环。原始 Session/Repo 读取仍由已登记的 Legacy
桥接等待完成，没有新增运行时、定时器或游离任务。Cancel 保留现有准入撤销与清理所有权。
上游 Session/Repo API 仍基于 Promise；本次引入原生迁移会拉入未完成依赖，不能帮助解决缺陷。

## 验证与边界

行为用例覆盖 Hash 递减插入、超过一批的未释放记录、读取失败、重启、v1 升级、
release 更新、停止期间超过五次正常检查、持续 blocked、取消、恢复后接纳复查，
以及仅入队一次。UI 用例覆盖停止原因、归档区分与送达状态刷新。
测试使用合成观测、SQLite、可控元数据和假时钟，不调用 Provider，也不使用真实 sleep。
39 项 Automation 测试、19 项接续 UI 测试与两项 Session release 恢复回归通过；
CLI、组件包类型检查和文档检查通过。验证复用相邻工作树的已安装依赖，
为本任务隔离使用 Node 22.23.4 与 CodeMode 2.2.0，Effect 保持 4.0.2。
桌面视觉验收与完整打包仍未验证。

当前行为与模块导航由 [Automations 指南](../../../../apps/cli/src/automations/README.md)维护。
本次还接通了[接续 UI 提案](../../proposed/feature/2026-10-27-session-continuation-note-ui.zh.md)
描述的显式恢复操作，但不代表批准该完整提案。
