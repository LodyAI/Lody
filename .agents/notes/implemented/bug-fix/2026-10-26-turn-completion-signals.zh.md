# 回合释放并确认历史后再发布完成信号

Status: implemented
Translation: current

[English](2026-10-26-turn-completion-signals.md)

## 摘要

Issue #1785 暴露了历史尚未收尾就更新未读元数据，以及同步未确认仍产生成功通知的问题。完成发布现在位于回合释放之后：Effect 策略先持久化实际历史后端，再确认已连接远端的历史及控制数据同步，最后发布未读和成功通知。同步确认具有 30 秒重试预算，并可在关闭时取消；通知仍为尽力投递，不重试发送。本地模式只要求本地持久化，CLI 历史摘要优先使用已结束 assistant 的完成时间。本次建立原生策略边界，不代表完成 Session/历史迁移，也不证明客户端已经渲染。

## 证据与决定

在 `34d403b8b4b71a2f0b490d1bedd7bac650b57c71` 的合成方法实验中，确认了提前写入未读、忽略同步 false 和摘要取创建时间。当前通知提交已经位于可见回合作用域之后，与 [#1785](https://github.com/LodyAI/Lody/issues/1785) 的旧 nightly 不同。现已使用集成测试验证实际执行、历史存储和发布路径。

`finalizeACPState` 不再写未读或等待远端同步。活跃回合的历史收尾失败会向上传递，避免被当作成功；teardown 保持尽力清理，历史完成后的 usage 失败仍被隔离。finalizing presence 期间的 ACP 更新不能绕过完成边界。`finalizeTurn` 不再重复同步和未读操作。

```text
必要历史收尾 → presence/Inbox 释放 → 冻结完成时间
  → 本地后端 flush → 所捕获远端代际的历史/控制同步确认
  → 未读元数据 + 一次性结果通知
```

时间在唤醒后继工作前冻结。每个 Repo 的活动写入队列防止迟到的旧回合降低 Session 或父级活动时间；父级写入在释放子级队列后才获取自己的队列。`session show` 对已结束 assistant 使用有效 `endedAt`，否则回退 `timestamp`。存储的创建时间和历史排序不变。

## 所有权与故障隔离

- 触发：回合完成收尾并释放资源。通知受众仍取被冻结的已完成输入；Agent 输入可以标记未读而不通知人类。
- 拥有者：现有执行 Host drain 持有 `publishTurnCompletionLegacy`。原生策略接受 Effect 能力，以 Schedule 重试、Clock 限时；不创建脱离所有权的 Fiber、通知日志或恢复映射。
- 交接：presence、执行槽、Inbox 的释放先于发布。同步或通知缓慢不占用执行槽。失败及 unknown 的注意通知不依赖成功同步确认。
- 取消：MessageHandler 关闭时在 Host drain 前取消确认等待，避免 30 秒门控占用协调器 15 秒 drain 预算。底层只读同步仍由 Repo/backend 拥有，不附加迟到发布回调。已经开始的本地写入和发送继续由宿主持有直至结束。
- 失败：同步返回 false 或拒绝时，在 30 秒内重试；到期记录诊断并抑制未读/成功发布。不把已成功的 Agent 执行改为失败，也不重放执行。发布通道独立运行，组合保留失败原因。远端代际替换不能被重新解释为本地成功。

既有尽力投递契约排除了持久化 outbox、重连重放和发送重试。有限的发布前确认是较小的修复；失败诊断不等于持久化重放。预算耗尽后，迟到同步不再补发这些信号。明确的本地模式不要求云端确认。远端回执证明后端同步，不证明每个客户端收到或渲染。

## Effect 边界与验证

新有限策略和 TestClock 回归使用锁定的 Effect 4.0.2。`publishTurnCompletionLegacy` 是唯一 Promise 执行入口，由 `SessionExecutionService.releaseVisibleTurn` 消费；待 Session 调用者、历史/backend 和通知拥有者能够原生组合 Effect 后删除。现有 Promise 依赖仍未迁移，已明确记入[台账](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#单元台账)。不宣称已完成 backend、ACP 或整个回合的迁移。

测试覆盖先释放后确认、重试与到期、取消及迟到回执、本地发布、元数据竞争、存储失败和通知来源。集成测试保留真实历史写入和执行作用域；未验证真实 dsh、打包 UI 或设备通知。检查结果与环境限制随变更汇报。

相关决定：[收尾展示](2026-10-06-finalizing-status-label.zh.md)、[Code Collab 所有权](2026-10-21-code-collab-turn-finalization-wait.zh.md)、[通知展示](../feature/2026-10-23-notification-reply-preview.zh.md)。
