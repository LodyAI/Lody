# 升级 Streams CRDT，串行化显式同步与实时上传

Status: implemented
Translation: current

[English](2026-09-29-streams-sync-serialization.md)

PR: [LodyAI/Lody#1099](https://github.com/LodyAI/Lody/pull/1099)

后续：[移除会话发送日志](../simplification/2026-09-29-remove-session-send-journal.zh.md)删除了下文提到的调用方 `workspace-session-send-journal.ts`，发送不再等待目标同步。Streams CRDT 的版本锁定及其理由不受影响。

## 摘要

发送消息会更新工作区元数据并立即请求完整同步，此时实时同步可能仍在上传这些元数据。Streams CRDT 0.16.0 会因两者重叠而返回内部错误，即使实时上传和独立的消息派发最终成功。Lody 现固定使用已发布的 0.16.1 修复，将显式同步与实时上传串行化，并让待上传批次的确认与出队处于同一队列事务中。发布包回归测试通过；现场原始内部异常仍不可得，因此不能据此认定所有同步失败都属于这一根因。

## 决策与证据

上游 [loro-streams#400](https://github.com/loro-dev/loro-streams/pull/400) 修复了该竞态，合并提交为 `060e5966fb3b9e973989a85e64198ed7e592963a`。0.16.0 的实时上传持有 `enqueueExclusive`，但公共 `sync()` 绕过该队列。待上传批次冻结时，显式 direct append 可能抛出 `pending local append must be finalized before direct append`，随后被归类为 `internal_error`。Loro Repo 的 `syncMeta` 包装隐藏了原始消息。Lody 的 `workspace-session-send-journal.ts` 先写入 `latestUserMsgId`，再调用 `waitForTargetSync`；后者在 `create-workspace-runtime.ts` 请求 `scope: 'full'`，形成元数据操作重叠的条件。RPC 派发可以独立成功。

将共享 catalog、精确版本的发布时间例外，以及仅针对 `loro-repo@0.21.0` 的 peer 允许版本更新到 0.16.1。使用 pnpm 10.20.0 重新生成锁文件，CLI、components、shared 和 Loro Repo 的 peer 快照使用同一版本。Streams Client 保持 0.8.0。不需要修改传输包装、屏蔽错误、改变产品契约或移动子模块版本。这是在 [0.16.0 升级](2026-09-27-streams-crdt-0.16-upgrade.zh.md)基础上接入的一次上游缺陷修复。

## 验证与限制

- 在隔离的临时测试环境安装 npm 发布的 0.16.1，搭配 Loro 1.16.3 和 Flock WASM 0.4.3。
- 将修复分支的上游 `self-healing-loops.test.ts` 改为引用发布包导出而非源码，18 项测试通过，其中包括九个确定性的重叠与恢复场景。二进制 items 测试辅助函数保持原样；测试不依赖真实网络或真实休眠。
- 使用发布包的 Flock 导出运行上游 `flock-adapter.test.ts`，12 项测试通过。
- 比较 0.16.0 与 0.16.1 发布包的类型声明：归一化生成的 chunk 名称后，index、Flock、Loro、zstd 入口声明不变；共享声明块仅增加私有串行化辅助方法和注释。
- 锁文件重新生成只改变目标 Streams 版本、完整性摘要及相应 peer 引用。嵌套工作区未安装根依赖，因此未验证完整 Lody 类型检查、构建和桌面端到端行为。
- 离线 frozen 锁文件验证、`pnpm run docs check` 和 `git diff --check` 通过。已尝试规定的提交前命令：`pnpm check` 在 ACP 适配器准备阶段因缺少 `tsc` 停止；`pnpm format` 因缺少 `oxfmt` 停止。
