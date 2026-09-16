# Codex 用量：原生快照取代分模型账本

Status: proposed
Translation: current

[English](2026-09-15-codex-per-model-attribution.md)

## 摘要

最初方案从 raw completion 重建历史分模型用量，并持久化本地 sidecar。
2026-09-16 用户选择改用 Codex 原生快照：展示总用量不需要历史模型账本及其恢复复杂度。
adapter 现在仅转换根 thread 原生快照、不自行累计，CLI 也不再补偿 native reset。
不承诺准确的历史模型费用或 fork/reset 生命周期计量。

## 决定

历史分模型账本的用途是跨重启保留模型统计，并为历史用量匹配各模型价格；
它不是展示原生总用量的必要条件。用户先拒绝 session metadata 基线，
随后明确选择原生快照，放弃整套额外账本。

```text
Codex 根 thread/tokenUsage/updated
  -> 无状态互斥桶转换（codex:unattributed）
  -> CLI 最新快照 / 失败 payload 重试
  -> 托管端逐字段高水位持久化
```

删除 raw-response 计量、model/reroute/compaction 状态、sidecar 存储、去重、
历史排除、native 缓存基线传递，以及 adapter/CLI reset 偏移。
保留普通 token/cache/reasoning 归一化、上下文窗口展示、原生生命周期、
payload 字段投影及失败重试。不再仅为计量启用实验 raw 事件。
当前 UI 模型及其价格都不是历史归因证据。

## 取舍与发布

- native resume/fork 总量可以包含继承历史，计数可以重置。不把子 thread 总量
  加到根会话，不额外制造 delta。
- Codex 负责原生历史恢复；旧开发版 sidecar 文件忽略、不删除。
  Session metadata 不存 usage baseline。
- 托管持久化仍按模型逐字段取最大值，native 快照下降时可能保留旧高水位；
  本次两个 PR 不修改该 API。
- 若实验分模型版本已经持久化模型桶，同一计量身份切回原生未归属历史，
  可能跨 key 重复计入旧历史。这两个未合并 PR 不迁移这些开发记录。
  如需修复，应另行限定范围操作，不能声称已完成迁移。
- Runtime 产物仍需重新构建/发布。两个有意保留的 gitlink 变化不提交；
  不删除历史数据或 sidecar 文件。

## 审查历史与证据

早期审查 adapter `94f51b7` 发现缺少 raw opt-in、fork 历史排除及重启/reset
问题，以及 compaction/reroute 模型不明确。修复持续到 `9457493`；
`c176b2b` 移除了 session metadata 基线和 fork 等待。
这些修复针对的是现已放弃的账本设计，并不构成继续保留它的要求；
本次明确删除整套设计。

原生快照验证：adapter 620 个测试通过、27 个 E2E 跳过；
adapter/examples 类型检查及构建通过。CLI 用量投递的 16 个测试全部通过，
覆盖 native reset payload `[1000, 0, 50]`、待发快照合并、重试和并发 flush。
三路独立代码复审未发现快照实现新增 P0/P1；上述开发数据迁移限制仍保留。
根全量 `pnpm check:affected` 及文档检查也已通过。
未运行付费模型 completion、线上云端数据修复或真实崩溃测试。

- [Adapter PR #45](https://github.com/LodyAI/acp-extension-codex/pull/45)：
  `src/CodexUsage.ts`、`src/CodexEventHandler.ts`、token-usage 事件测试。
- [Lody PR #736](https://github.com/LodyAI/Lody/pull/736)：
  CLI 用量投递实现/测试及 [Spec](../../../../specs/usage-delivery.zh.md)。
