# 使用跟踪引用比较完整的会话基准分支

Status: implemented
Translation: current
PR: [#1177](https://github.com/LodyAI/Lody/pull/1177)

[English](2026-09-30-qualified-all-changes-base.md)

## 摘要

本地 worktree 将基准保存为 `refs/heads/main` 时，All Changes 可能包含无关的上游改动。
比较逻辑先尝试不存在的 `origin/refs/heads/main`，随后接受陈旧本地 main，未优先检查有效的跟踪引用。
修复在跟踪引用查找时规范化完整本地引用，让摘要与文件索引共用候选策略，并固定批量 diff 的提交基准。
这修复比较选择，不改变 PR 历史，也不保证离线远端引用的新鲜度。

## 证据与职责

头像 [PR #1164](https://github.com/LodyAI/Lody/pull/1164) 实际有五个文件、+165/-0。
只读检查发现归属会话元数据保存了完整本地基准，而已刷新的持久化文件索引有 525 条路径、
+21317/-10255，含无关 SDK 升级。所报 UTC 时段的日志显示索引确实重新计算，不能仅归因于浏览器缓存。
干净 checkout 的当前上游 merge-base 得到 PR 的五个文件；陈旧本地 main 会包含 SDK 改动。
当前 checkout 的陈旧 main diff 不等于历史 525 路径快照。

底栏读取持久化 `SessionMeta.diffStats`；固定面板的摘要和列表经 provider 读取归属会话的文件索引文档。
当前单文件与批量 diff RPC 则比较磁盘与重新解析的 Git 基准。这些是不同快照；
尚未还原所观察 +165 元数据的准确写入方与时间。Web 报告版本为 0.103.0 / `eb96909d`，
不是修复基线 `e10e5226`，尚未映射其前端构建源码。另行检查已安装机器 CLI 的比较实现，
确认其存在完整引用选择缺陷。

## 决定

`gitDiffBaseRefCandidates` 统一候选策略：完整本地引用先尝试 `origin/<branch>`，
保留原本地引用作为回退；完整远端引用保留身份。不添加 fetch、checkout、元数据迁移或数字覆盖。
扫描核心统一提供 worker 索引与当前 diff 的 merge-base 解析。
一次批量读取只解析一个提交，用于文件列表、响应基准和所有内联旧快照。

仅把底栏数字替换成面板总数会隐藏错误 SDK diff，因此未采用。
也不永久锁定 PR head/base：All Changes 是实时归属工作区比较，不是不可变 PR 查看器。
远端引用仍需正常 fetch；脏文件或未跟踪文件可与已提交元数据不同。
延后发起的 RPC 是新的读取，不是对原批次磁盘状态的事务。

## 验证

合成真实 Git 回归覆盖陈旧本地 main、前移的跟踪引用、内联与当前快照、squash 合并历史、普通合并后仅引用变化、
零摘要发布、服务重新激活和 worker 扫描边界。恢复旧候选构造后，回归因额外上游改动失败。
规范化后四个 CLI 测试集共 73 项通过，CLI 类型检查通过。生产数据仅只读检查，未重新发布；
不宣称已部署或已完成登录态 Web 验收。
