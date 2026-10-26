# M5 实时契约评审

Status: proposed
Translation: current

[English](2026-10-26-e2ee-realtime-contract.md)

## 摘要

加密 RPC 需要认证目标，并通过持久边界避免重试引发第二次执行。owner 已选择账本签名
绑定 machineId、机器主动取得且仅在内存缓存的执行权限新鲜度，以及 iroh 复用工作区
设备 Ed25519 身份、加密 Streams RPC 回退。foundations 修订记录这些行为方向，已有
候选帧编码和上限不变。Spec 仍为 draft，不开放产品通道；记录格式、域隔离审计和平台／
运行时验收仍是独立门槛。

## 已选方向与替代方案

保留 content v0 算法和用途 7/8/9，两通道传同一原帧。已有的候选编码和上限集中在
[所属草案](../../../../specs/e2ee-foundations.zh.md#实时-rpc-与-presencem5-评审草案)，
不在这里重复。本次更新不改候选实时帧字段，也不规定新账本字节编码。

机器 `AdmitDevice` 记录在批准个人设备的签名下绑定 machineId 与公钥。只有本地已验证
账本提供 machineId 到公钥的对应关系，目录元数据和 credential-binding/v1 不能代替。
同工作区的同一 machineId 最多对应一台有效设备；更换时在同一记录撤销旧公钥。这取代
此前推荐的独立机器绑定证明，也不采用“仅按账本公钥路由”的替代方案。编码和向量更新
归独立机器接纳工作。无 machineId 的旧开发机器记录可继续经授权的文档同步，但不能
授予实时权限；不迁移、不重签。

执行机器自己经认证拉最新账本。最多 15 分钟从读取前开始计，只在内存缓存剩余窗口。
重启后联网重新核查才接受新的远程执行，不阻断离线文档使用，也不复活不确定操作。
转发页和已保存的 journal 时间戳不续期。具体时钟／停止余量／休眠处理仍须逐宿主测试；
这不改变 journal 已单独接受的持久过期时钟下限。

Iroh 以工作区设备签名公钥作为 EndpointId。私钥只在可信宿主内交给 iroh，不导出给
renderer，也不开放任意签名 IPC。启用复用前，须核查具体 TLS／discovery 签名域与
账本／内容域的隔离。身份决定不选择 SDK、发现／中继配置，也不代表平台验收通过。
iroh 很慢或不可用时不能阻断加密 Streams，两者保留同一原请求 ID／帧和共用执行 journal。

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

以上源码审计是基线观察，不代表已实现所选账本扩展、新鲜度门或 iroh 装配，也不把缺口
当成普通 RPC 已上线漏洞。文档检查只验证元数据和链接。固定向量、崩溃／I/O 测试、真实
授权产品执行、canary 与普通／加密延迟对照仍须分别留证。Spec 保持 draft：方向已选不
批准完整修订、独立机器记录编码或尚未审计的跨协议密钥复用。本次文档 PR 不改变普通
工作区路径或产品开关。
