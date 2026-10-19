# 原生本地 presence 与全进程共享 connection writer

Status: implemented
Translation: current
PR: [#1519](https://github.com/LodyAI/Lody/pull/1519)

[English](2026-10-12-effect-local-presence-writer.md)

## 摘要

本地数据平面的 Promise pump 清空队列时不等待运行中的 Flock 导出，不同 workspace 的
writer 也不共享物理 socket 背压。新的 Effect 4.0.2 原生服务拥有进程 pacer、按序的
workspace lane，以及每个连接唯一的 write/drain owner。真实 doc/socket 消费者通过
单个明确弃用的 Legacy executor 使用同一内核；presence 在 writer 执行时编码快照，
包括最终删除。该下层 writer 责任已经实现；room、LoroRepo 和完整应用生命周期
接线仍保留 Legacy 责任。远端 workspace presence 现由独立 P5 owner 负责。

## 责任与依赖

```text
应用／单个 local-loro-writer Legacy executor
  LocalLoroWriterLive（原生 FIFO task/frame 与释放所有权）
    LocalLoroWriterTurn -> Node 宿主轮次 adapter
    connection.send/onDrain -> 单个 Node socket adapter
    task.build -> 普通 CRDT/frontier/分帧计算 + 原生 Effect 组合
      LocalLoroPresenceSource -> 同步本地来源 encode/subscribe
      machine-monitor -> 同步 encode/apply/subscribe
      exportLocalFlock -> 真正第三方 Flock SDK exportJson 边界
  LocalLoroDataPlaneServerLegacy（临时上游组装）
    resolveDoc / resolveFlockDoc / resolveMetaFlock -> Promise LoroRepo owner
    join/leave/import 与 room 通知 -> 现有 Legacy room 生命周期
```

SDK 的普通 version-vector 导出同步执行，options/hooks 路径可以返回真实 Promise。
唯一 SDK adapter 等待实际结算期间保持不可中断，因为 SDK 没有协作式 abort 契约。
Loro 导出、版本捕获、分块和每 peer frontier 计算仍是普通计算。旧 `pumpWriter` 与
Promise scheduler 已删除，没有用 `tryPromise` 包装；room resolve/join/leave/import
也没有被这样包装。单个超大 Flock entry 的终态分支仍把 room 释放／通知交给 Legacy
room owner；这是登记的上游生命周期边界，不代表 room 已原生化。

检查的 main 缺少先前的 `specs/local-first-two-plane.md` 路径。本地来源、dual-author
和先 unload 后 invalidate 的要求，依据 scoped 指令、现有实现／行为测试及 owning
presence Spec 复核，没有创建替代 Spec。根 roadmap ledger 记录此下层原生边界与仍待迁移的上层 owner。

## 契约与 API

- **触发：** CRDT／来源变化只提交名称／Effect，不内联导出。一个 task 或剩余 chunk
  跨越一个真实宿主轮次。所有种类共用各 workspace 的有序 lane；lane 在连接及
  workspace 间轮转，包括同一个复用 socket。
- **所有者：** 一个应用提供 `LocalLoroWriterLive` 和 `LocalLoroWriterTurn`。
  `offer`、`dropRoom`、`revoke` 是同步入队／隔离操作；`closeOwner`、`disconnect`、
  `close` 是原生 Effect。物理连接为所有 workspace lane 拥有唯一 drain 订阅和背压锁存。
- **取消：** 断开／dispose 立即撤销排队工作。运行中的 SDK 导出保留 owner，直至真实
  结算；signal／timeout 不等于释放。代际、subscriber 和 requestId 防护阻止晚到写入
  与 frontier 推进。
- **交接：** `send(false)` 接受当前帧，但暂停后续导出／发送。drain 按原顺序恢复
  parked lane。presence 去重保留一个 running 加一个 queued，在执行时快照并保留
  最终 clear/delete。每 peer frontier、分块顺序及 machine-monitor observer 语义保持。
- **失败／恢复：** 并发 close 共用 Deferred receipt。每次 raw-work 观察等待有独立
  五秒 Clock 上界，在 Scope finalizer 中也有效。unsubscribe 失败或未结算工作在
  `LocalLoroWriterReleaseFailed.retry` 保留连接和完整 Cause，替代仍被阻止。根关闭
  最多两次观察同一 raw producer，观察等待上界十秒。恢复使用保留 owner，不用第二次
  `Scope.close`。Legacy 失败投影保留完整 Cause。

`makeLocalLoroWriterLegacy` 是唯一 writer runtime executor。CLI doc 创建从全进程
singleton 注入 `LocalLoroWriterNodeTurn`；Node socket 断开／停止和 manager cleanup
等待 release receipt。应用 owner 原生注入后删除 executor。Engine 组装／room hook
及 Fleet 更广泛的 Promise cleanup（含既有失败日志策略）未迁移；socket／应用 writer
注册表在此 Legacy 策略下仍保留失败的下层 owner。本单元不完成完整 P7、Session／
Turn 或整个 Loro stack。

## 源码证据与替代方案

锁定的 Effect 4.0.2 `internal/effect.ts` 把 `sleep(0)` 实现为 `yieldNow`，mixed
scheduler 先使用微任务。精确版本实验在已登记的宿主轮次前排队 40 帧：`yieldNow` 和
`sleep(0)` 都先发送 40 帧，Node adapter 先发送 0 帧，因此这里需要平台 `setImmediate`
callback。Semaphore 串行化本身不提供宿主 quantum、共享 socket 背压或 parked 顺序。
每 workspace runtime 会产生竞争 writer。

非协作 SDK producer 的自动 scoped join 会破坏观察上界；明确拥有的 worker 在有界
finalizer 失败后仍可恢复。Cause 处理使用完整 Exit；finalizer 的 Fail 到 Die 转换
保留每个 reason 和 annotation，不使用 v4 会选择单个失败的 `mapError`／`orDie`
投影。没有向日志添加 payload/error stringify 或新的诊断字段。

## 验证

Base：`3ac76bad10f46720517a2ca6929f03de4ef5bb9b`，与远端 main 核对。Shared 基线
112 文件／1427 测试通过。CLI 基线 5 个失败文件、15 个失败测试、4 个未处理错误；
socket/doc/relay 聚焦基线 30 测试通过。测试子进程只隔离 Git config 污染，没有修改
全局 Git config 或父 checkout。

既有 shared server/framing/transport suites 使用假时钟、明确 host-turn、export、
drain、completion gate 和 TestClock。新增覆盖跨 workspace 背压、写时快照／最终清除、
真实 SDK 结算、并发 close、释放失败保留／恢复、finalizer 上界和混合 Fail/Die/Interrupt。
CLI 使用真实 Node Writable high-water/drain 边界，保留真实 Unix socket overflow
回归并改用 message/close 信号。Dual-author 覆盖使用真正 Flock/Loro adapter。
Mock-call-only 断言改为状态；浅层 unload 源码文本测试由既有真实 unload 覆盖和 AST
边界 guard 替代。

五项顺序临时消融分别让 owning 行为测试失败：宿主 quantum、背压、提前 presence
快照、去掉实际结算 join、去掉 superseded-join 防护。最初公平测试未检测到删除 turn，
增加 admission 对 early-write 的明确信号后成功检测，补齐了测试盲点。脚本不进入产品
代码。整合 review 基于 `dd674eae`，复用已合入的 P5。独立 clone 使用 frozen
install，保留锁定版本。完整 shared 验证 112 文件／1458 测试通过，CLI 的真实
socket、卸载、双作者和零云调用 5 文件／37 测试通过；根类型、lint、格式、文档
及公开／native 边界检查通过。Renderer 重连 harness 注入原生 writer，
用假时钟验证真实 room adapter／健康判定链路，并等待 engine 与 writer 清理。
完整第三组件分片 186 文件／1799 测试通过。本地完整 CLI 阶段 4052 项通过，仍是相同的五个
Git/进程基线套件（15 项失败／4 个未处理错误）；远端 CI 才是提交版本的干净环境验证。

验证限于本地 Linux／Node 源码，不证明 Windows/macOS、打包桌面／CLI 安装、生产负载
或上层 stack 原生所有权。
