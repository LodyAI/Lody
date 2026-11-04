# 原生会话 presence 租约与心跳

Status: implemented
Translation: current
PR: [#1527](https://github.com/LodyAI/Lody/pull/1527)

[English](2026-10-13-effect-session-presence-leases.md)

## 摘要

会话活跃 presence 原先由进程定时器与回调等待器维持，退出、归档和 GC 路径可能在可见 Turn 收尾前清除它。现在由 Effect 4.0.2 原生租约统一拥有本地发布、心跳和初始化卡住检测，实际执行服务将租约组合进 Turn Scope。只有成功释放租约才会清除 presence 并允许替换，保留 #1518 修复的原始 ACP 工作排空顺序。现有 analytics 刷新仍是明确的 Legacy 边界；有界关闭超时保留原所有者，不宣称清理完成。这完成的是会话 presence 责任，上层 Session、Turn 和 daemon 迁移仍未完成。

## 责任与行为契约

```text
MessageHandler / SessionActivePresenceControllerLegacy
  原生 SessionActivePresence 服务（SessionPresenceHost + Clock）
    可见 Turn 的 presence 子 Scope
      acquireRelease 租约 -> 同步本地来源发布
      心跳 fiber -> Schedule.spaced / Clock
      每代 Deferred -> 实际 Turn 的初始化失败竞速
    同步 phase/status 读取 -> 现有权限、图片与重连消费者
  可选诊断 -> 现有 Legacy analytics 刷新（保留真实 Promise）
  关闭 -> 停止生产者 -> 等待租约与监测释放 -> 刷完 ACP/history -> 关闭存储与文档
```

Host 只接纳同步本地发布和诊断，CRDT/status 映射仍是普通计算。`captureMessage` 会进入尚未迁移的 Lody 刷新编排，因此不将它包成 Effect 后宣称原生依赖。Legacy 入口保留实际刷新 Promise 及现有遥测门控，没有新增 HTTP、token 查询、负载字段或已认证云请求。

- 触发：可见 Turn 获得独占会话代。phase/detail 改变立即发布并重置静默时钟；重复状态不发布、不重置。调用者仍遵守既有进度频率上限。
- 所有者：`acquireRelease` 原子登记子资源释放。Scope 内心跳拥有所有唤醒。单个 MessageHandler 门面拥有兼容租约和可选监测，不创建另一个 ManagedRuntime。
- 取消：Turn presence Scope 先中断并等待心跳，再清除本地条目。现有原始 prompt/steer 排空仍在 Scope 关闭前完成；生命周期回调不能释放 Turn 租约。启动进度回调捕获精确 runtime，被放弃的启动不能更新继任者。
- 交接：旧代存在时拒绝第二次 hold。初始化截止时间锁存到每租约 Deferred，停止心跳并只报告一次，即使检测早于 Turn 等待器。卡住仍归类为失败，而非取消。
- 失败恢复：本地 clear 失败保留条目、代和完整 Cause；`retryRelease` 重试同步清除，不重复关闭 Scope。这只恢复本地租约，不恢复失败的上层 Turn finalizer。关闭先退休新准入，再等待实际租约与监测释放，之后才关闭 evidence 存储和文档；真实关闭回归用明确的生产者停止、close 准入信号和假定时器验证。每次观察上限五秒，失败保留原所有者供重试并阻止文档拆除。并发 Legacy close 共用一个 receipt。

## 决策与边界

`RcMap` 的共享语义会让第二个可见 Turn 借用旧代，这里需要独占准入。本地 Map 只保存同步身份与状态，不保存 Promise 生产者。Scope 拥有心跳取消，`Effect.cached` 拥有单次租约关闭 receipt。锁定版本 4.0.2 的 `forkIn` 在 Scope 中登记并等待 fiber 中断；单独调用 `Scope.close` 不提供并发 receipt。`Deferred.doneUnsafe` 同步接纳信号，避免先检测后订阅时丢失事件，不需要内部执行器或回调等待器 Map。

本决策延续[取消释放顺序](../bug-fix/2026-10-12-session-presence-cancellation-release.zh.md)和 [P5 workspace 所有权](2026-10-12-effect-workspace-presence.zh.md)。[presence 实现指南](../../../docs/cli-lib-loro-presence.md)维护当前实现，[初始化意图](../../../../specs/session-initialization-deadline.zh.md)不变。完整 Session/进程启动、Turn 收尾、MessageHandler/daemon 编排、analytics 与 P7 room/LoroRepo 集成仍待迁移。机器活跃状态继续由已合入的 workspace presence 单元负责，不在这里重写。

## 验证

基线为包含 #1518、#1519、#1520 的 main `d76690b6`。独立 clone 保留原工作区和作者副本；冻结安装保留锁定版本，已检查消费包 Effect 4.0.2 的说明与源码。

行为验收使用 TestClock、假定时器和明确的原始完成信号，覆盖发布/status、阶段静默和 detail 进度截止时间、提前锁存卡住信号、所有者中断、替换、clear 失败恢复、心跳发布失败、关闭超时以及真实归档回调。既有执行套件将原生租约接到真实控制器发布，保留四种原始 ACP 排空结果；初始化 harness 通过原生 Clock 假定时器推进，不再用真实时间睡眠。替换后的控制器测试断言条目和状态，不仅检查 mock 调用。

六项临时消融分别让对应行为回归失败：心跳 Scope 所有权、提前卡住锁存、进度截止时间重置、clear 失败保留、精确启动代以及归档意外清除。源码恢复后七个实际消费者套件共 308 项测试通过。原生/Legacy 租约套件还验证了关闭超时后的真实监测结算。根类型检查、lint、格式、文档检查和全部静态边界检查通过。`pnpm check` 进入完整测试阶段，但未修改的 code-review renderer 套件在继承的 production React 环境下出现 `act is not a function`，这是先前记录的验证限制，不能称全量检查 green。同一未修改 review-helper 包在 `NODE_ENV=test` 下 33 项全通过，确认是 production 环境限制。七个 P6 消费者套件共 308 项通过，最终 PR 必须由干净环境 CI 验证。Linux 源码验证不证明打包桌面、生产负载行为或剩余上层工作流的原生所有权。
