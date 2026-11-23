# 模型摘要的浅读、自愈与 fork 补偿边界

Status: implemented
Translation: current

[English](2026-09-21-session-model-summary-boundaries.md)

## 摘要

模型摘要观察者曾在每次历史提交时序列化不断增长的助手正文，在其他 metadata 写入者
覆盖摘要后仍记住旧发布结果，并可能使已持久化的 fork 失败。现在 reader 只暴露模型
标量和输出数量，发布器比较当前 metadata，fork 投影在补偿范围结束后执行。
这样消除了投影中的正文序列化，并允许下一次历史事件或 flush 修复摘要；
本次没有增加即时 metadata 变化订阅或新的重试调度器。

## 决策与职责

本次修正[原摘要决策](../feature/2026-09-12-session-model-summary.md)的实现边界，
保留既有[展示语义](../../../../specs/session-model-summary.zh.md)。
共享的 `SessionModelSummaryReader` 是独立的窄能力，不改变正文 reader 和目录消费者。
它直接读取容器长度及模型 id/name，兼容旧内联 JSON 和 LoroText 模型字符串，
不遍历提供方扩展。尾部没有可见助手输出时仍需向前扫描，本次不宣称对历史长度为常数时间。

```text
历史事件 / flush → 标量与数量 reader → 当前 metadata 比较 → patch
fork 历史与 metadata → 持久化提交 → 离开补偿范围 → 摘要 flush
```

发布器能读取当前 metadata cache，因此由它独占去重职责。额外记忆上次发布值不能证明
当前值仍匹配。订阅 metadata 会增加生命周期和反馈循环问题；历史变化或 flush 时修复
符合既有重试边界。并发发布仍串行执行，隐藏和已删除的行仍受保护。

fork 投影拥有独立于 saga 补偿块的错误边界。同步抛错与 Promise 拒绝仅记录警告，
不影响目标会话、worktree 或已提交的回执状态。现有 fork harness 已提供
`syncModelSummary`，测试向该方法注入故障。

## 验证与限制

回归测试使用真实 Loro 容器，在拒绝递归 map/list 序列化的条件下验证投影值。
SessionDocument 测试在发布后覆写 metadata，分别验证历史提交和销毁 flush 的修复，
同时确认相同 metadata 不重复写入。fork 测试注入两种失败形式，检查操作仍已提交，
且没有终止会话或清理 worktree。摘要/fork、共享历史及导入 writer 的定向测试共通过
113 项；shared 类型检查、修改文件 lint 和根目录 `pnpm format` 通过。根目录
`pnpm check` 在 components 类型检查阶段因 Electron 依赖缺失及相关类型错误停止。
CLI 类型检查、导入服务测试
加载、public-boundary 和文档链接检查受当前 checkout 未初始化 ACP 子模块阻塞。
不宣称吞吐基准结果或真实提供方验证。
