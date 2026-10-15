# Lody 自动通知与独立渠道投递

Status: proposed
Translation: current

[English](2026-10-13-agent-native-attention.md)

## 摘要

Lody 根据可信执行终态与输入作者确定通知资格，不提供 Agent 通知工具、Inbox UI 或新的 Web 投递。桌面和手机独立提交，允许两端都提醒。实现保留最小共享策略与兼容适配，不引入设备心跳、补发队列或跨端仲裁。当前实时活动 producer 静默更新。代码和本地测试已具备；真实设备展示、声音和点击仍待验收。

## 来源策略与最小契约

[共享模块](../../../../packages/shared/src/notifications/index.ts) 包含来源事实、AttentionItem、共享终态载荷校验和稳定 provider 身份。MessageHandler 使用策略结果中的真实收件人、来源与终态，不依赖通用意图/路由/回执框架，也不新建 Inbox 存储。

执行者从真实出口发出 succeeded、failed、cancelled 或 unknown，每轮冻结 requester 与精确输入作者。人类成功/失败/未知终态可以提醒；取消、普通委派结果及未知受众静默。RPC 来源保持 unknown，直到现有 history writer 读到该精确输入；不增加 prompt 前的历史扫描。

会话包含关系不决定当前 Turn 的受众。仅由 Inbox 批量结果驱动的自动续轮可能包含多个 Operation，没有单一人类作者，显式保持 unknown 并静默；人类输入附带 Inbox 结果时，保留自身冻结的受众。沿用已有 Inbox 和取消生命周期，不因通知失败重跑 Agent。参见[会话关系](../../../../specs/session-relations.md)与[编排规则](../../../../apps/cli/src/orchestration/AGENTS.md)。

定时任务当前产生普通用户 Turn，成功/失败/未知沿用同一策略，取消静默；高频任务可能每轮提醒。条件、摘要、健康事件及交接前告警暂缓。

## 独立渠道与尽力投递

每个获准目标进行一次有界尝试。失败、超时、重连或随后锁屏均不补发、不换端。桌面活跃、DND、通知关闭或正在查看来源，不抑制手机。两端各提醒一份是允许的正常行为，不仅发生于罕见竞态。

控制文档仅保存最新终态通知。Meta 通过低频的 36 字节 UUID 索引发现变更来源；桌面只读取变更来源，最多四并发、每次五秒。启动/重连建立基线，不重放历史。展示前检查收件人、身份、时效、当前设置和来源可见性。

手机沿用可选且经过认证的云能力，新终态/权限文案不包含私密标题或原始错误。当前协议定向获准原生订阅，旧协议保留旧目标行为。受理不证明设备展示或用户阅读；Local-only 不获取产品云通知能力。

移除的桌面采样、通知心跳、仲裁与通知 journal 不保留空接口。无 outbox、route epoch、claim、跨端已读协议或独立通知 Runtime。

## 兼容与静默活动

`terminalNotifications` capability 为新 CLI 关闭 idle 完成推断。`LegacyElectronSessionNotifier` 单独保留旧 idle 完成与现有权限观察，共用宿主快照。只有最低支持 CLI 具备该 capability 后才移除 idle 路径；权限观察等待类型化请求投影接入后单独退出。

云能力协商保留旧成功/权限参数，跳过旧服务端不支持的失败/未知终态；提交后不通过旧路径重试。内部 `notifyTurnOutcome` 不重命名已部署 cloud action、port 或 IPC。新增可选持久字段、稳定 provider 身份字节与可选 IPC 参数继续兼容旧客户端。

手机摘要 hook 不附带权限 alert，并在权限等待期间持续刷新其他工作。权限候选只触发节流快照刷新。保留一秒输入节流、250ms bridge debounce、原生/设置门控、空摘要和作用域清理。旧 bridge alert 可选字段仍可读取；普通 Push 独立负责提醒，不依赖活动更新成功。

## 架构与验证边界

普通类型和纯函数足够；不引入 XState 或新 Effect Runtime。现有 SessionDocument/CloudPort 与 React bridge 并非完整 native Effect 单元，包装未迁移生命周期不能算完成迁移。测试覆盖策略、真实执行和定时任务 preparation、共享 CRDT 兼容、挂载的桌面/活动消费者以及混合版本适配。

新增全局/来源静音、手机前台来源抑制、委派阻塞聚合、精细关注订阅与远程活动排序暂缓。来源页面保留既有错误和请求。真实展示、声音、点击跳转及混合版本设备仍需验收；本地测试和编译不证明投递。[原生通知生命周期修复](../../implemented/bug-fix/2026-09-20-notification-click-lifetime.md)继续有效。
