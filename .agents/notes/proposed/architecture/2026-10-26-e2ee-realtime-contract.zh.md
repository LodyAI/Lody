# M5 实时契约评审

Status: proposed
Translation: current

[English](2026-10-26-e2ee-realtime-contract.md)

## 摘要

加密 RPC 不只需要加密：调用方还须认准目标机器，机器须避免重试引发第二次执行。
foundations 草案现已给出可评审的候选 wire、响应绑定、新鲜度来源和执行证据保留规则。
现有配对凭证签名不含 machineId，账本 pin 也不证明权限新鲜度。这些决定明确保持提议；
本改动不开放产品通道，也不批准协议。

## 决定与替代方案

保留 content v0 算法和用途 7/8/9，两通道传同一原帧。精确建议编码和上限集中在
[所属草案](../../../../specs/e2ee-foundations.zh.md#实时-rpc-与-presencem5-评审草案)，
不在这里重复。现有方法 payload 原字节外包固定字段，避免让外层路由 JSON 产生权限，
也不另建通用 RPC 方法系统。

机器身份可直接从账本公钥派生，或另做签名配对绑定。推荐后者，以保留产品 machineId，
不改账本或 credential-binding/v1；仍须明确签发资格、分发、共享与替换规则。新鲜度推荐
本机主动经认证拉取最新账本，重启后失效，避免信任发送者时间戳或另造持久可信时钟。
跨重启复用需要另定时钟／证明。两个推荐均不是批准。

请求过期不回收执行证据，首版保留；后续有限留存设计须有持久退役 ID 与待确认处理。
代价是磁盘增长，容量耗尽时明确拒绝新接纳。

## 源码审计与接线边界

核对公开 main `274d74a724de7bfb42c6ff0685c52c0abce7d487`：

- `packages/e2ee-core/src/internal/foundation/content-format.ts` 与
  `crypto/content.ts` 已隔离非文档派生叶，content v0 固定开销为 143 字节。
  `internal/content/index.ts` 刻意限制 sealDocument 只接文档用途，继续保留。
- `foundation/device-credential-binding.ts` 签 genesis／session／key／credential
  hash，不含 machineId。`apps/electron/src/main/services/e2ee-local-pairing.mts`
  保留机器响应，但凭证证明不向其他设备认证其中 machineId。账本 AdmitDevice 也无此字段。
- `internal/ledger/verified-ledger.ts` 证明已见历史连续。CLI `lib/e2ee/runtime.ts`
  保存 history／cache／pin，没有新鲜度时钟。
- `apps/cli/src/session/session-dispatch-watcher.ts` 按 userTurnId 暂存 RPC；
  `session-dispatch-logic.ts` 刻意在重启后恢复 processing 回合。只围住 RPC 接收层的
  journal 不能限制这个持久派发入口。
- `packages/loro-streams-rpc/src/machine-rpc-server.ts` 只在内存里合并并发 history
  task，完成即删除；CLI `session-history-rpc-rejections.ts` 只保留部分拒绝到过期。
  两者都不是完整执行 journal。
- `session-execution-service.ts` 已保存 steer 提交不确定证据，应复用而非重跑已提交
  动作。其有界内存终态表不足以支持持久去重。

## 验证边界

源码审计证明上述缺口，不把它们当作普通 RPC 已上线漏洞。本改动不选择原生 iroh 身份、
SDK、中继／发现配置或平台支持。文档检查只验证元数据和链接。固定向量、崩溃／I/O 测试、
真实授权产品执行、canary 与普通／加密延迟对照仍分别留证。Spec 保持 draft，等待 owner
明确审阅对应版本。
