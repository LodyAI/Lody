# Codex 用量：按 turn 归因原生快照

Status: proposed
Translation: current

[English](2026-09-15-codex-per-model-attribution.md)

## 摘要

Codex 用量来自原生累计快照，每个 turn 的新增 token 归给该 turn 提交的模型。
这取代了最初的 raw-response/sidecar 账本方案，以及中间的未归属快照方案。
adapter 只在内存保留上一条快照和当前 turn 计数；CLI 使用现有托管 API，
以 turn 区分计量身份。不承诺 crash、fork、reset 和 reroute 的精确计量。

## 决定与职责

最初方案通过 raw completion 和本地 sidecar 跨重启保留历史模型总量。
随后原生快照简化移除了账本，但上报未归属总量。澄清后的要求是归因
**当前 turn 的新增用量**，而不是把历史累计量改归当前 UI 模型。

```text
原生根 thread 累计快照
  -> adapter 快照差值 + 提交时的 turn 模型
  -> turn 内累计更新 + 通知局部 usageTurnId
  -> CLI 稳定 nativeSessionId:turn:encodedTurnId 计量 key
  -> 现有托管端逐 key/model/字段取最大值
```

adapter 在异步提交请求前冻结模型，之后切换 UI 模型不会改写当前 turn 归因。
原生 Goal 后续 turn 保留提交模型。重复快照不产生新增 token。
恢复时已有原生快照只作为比较起点、不计入历史；若快照缺失，首条仅作为起点，
因此可能漏掉一条新增响应。

CLI 仅对 Codex 识别此标记。计量身份与真实 ACP session ID 分开，
不修改会话路由或 metadata。分 turn key 使 A=10000、随后 B=2000 累计为
12000，而不是按整段 session 取最大值。未标记 adapter 保持原有范围。
不增加私有后端、Core schema、session metadata baseline、磁盘 sidecar、
raw-response 账本或历史模型映射。

## 取舍与发布

- adapter 必须与匹配的 CLI 一起发布，旧 CLI 无法正确解释新的 turn 内累计范围。
- 不将子 thread 用量加入根会话。reroute、compaction/reset、fork 和 crash
  恢复尽力而为，不维护持久化回放账本。
- 不迁移或修复已有实验计量行；旧 sidecar 文件忽略、不删除。
  Runtime 产物仍需重新构建/发布。
- 两个有意保留的 gitlink 变化均不提交。

## 证据与限制

行为测试覆盖切换模型、提交模型冻结、Goal 延续、重复快照、恢复历史、
恢复快照缺失和计数重置。parser 到 usage service 测试覆盖 turn A=10000、
turn B=2000、服务重启后 turn C=500，模拟托管端最大值持久化后合计 12500。
最终验证结果随提交报告；此前仅原生快照版本的验证不能作为本版本证据。
未运行付费模型 completion、线上云端数据修复或真实崩溃测试。

- [Adapter PR #45](https://github.com/LodyAI/acp-extension-codex/pull/45)
- [Lody PR #736](https://github.com/LodyAI/Lody/pull/736)
- [用量投递 Spec](../../../../specs/usage-delivery.zh.md)
