# 所有者签名的加密机器共享

Status: proposed
Translation: current
PR: [#2014](https://github.com/LodyAI/Lody/pull/2014)

[English](2026-10-28-e2ee-machine-sharing.md)

## 摘要

已验证账本中的机器归属只能证明谁控制机器，不能授权其他成员执行。拟议 MVP 通过机器所有者有效个人设备签名的独立完整加密策略，保留私有默认值及现有机器／项目开关。服务端 head CAS 为不可变版本定序，客户端验证所有者资格、精确资源与本地版本连续性。A1 提供 codec、密码学校验、纯授权判断和 DTO；存储、新鲜度、原生宿主执行与 UI 尚待接入，foundations Spec 新增小节仍待批准。可用性采用有界最新状态缓存，不要求每次动作都联网。

## 决定与替代方案

共享策略独立于成员账本，避免每次项目开关操作成为永久成员记录。完整策略让开启项目与机器原子生效，关闭机器时保留项目记录。普通 CRDT 布尔值或快照签名无法证明每个设置来自机器所有者；服务端账号授权会让服务器决定共享权限；默认全团队可用则取消所有者控制与私有默认值，均不符合选定边界。

有效机器绑定仍由[机器身份决定](2026-10-27-e2ee-machine-ledger-binding.zh.md)负责；本提案新增共享权限，不替代该决定及既有实时原语／journal 所有权。替代检查未找到共享策略格式的既有 owning note。A1 不改变此前关闭共享 UI 的状态。

## 格式与职责

有界规范 CBOR 元组为：

```text
[format=1, purpose=1, workspaceIdUtf8, genesis32, machineIdUtf8,
 ownerMembership16, revision, previousFrameDigest32OrNull, sharedWithTeam,
 sortedProjectIdUtf8s, signer32, issuedAt, requestId16]
```

身份字符串使用严格 UTF-8，1..256 字节，不规范化、不去 BOM。项目集合按 UTF-8 字节排序且不能重复，最多 4096 项；展开正文不超过 256 KiB。签名公钥使用 core 的严格 Ed25519 检查。时间为非负安全整数，只供描述；版本为正安全整数，仅首版的父摘要为空。摘要和公开 DTO 标识均为规范小写 hex。

content-v0 document-update 加密／签名固定资源 `machine-access:<unpadded-base64url(machineIdUtf8)>:<ownerMembershipIdHex>`、docEpoch 零及额外签名／AAD 绑定 `lody-e2ee/machine-sharing/v1\0`，复用既有算法，不改账本格式。CAS 与 previousDigest 都使用完整原始密文帧的 SHA-256，不哈希解码状态、不重新加密重试。原始帧上限为 262287 字节，即 256 KiB 正文加 143。

platform 传输接口与 cloud-api 复用唯一 DTO。后端从设备凭据确定身份，通过 `admitMachineSharingFrame` 验证机器当前所有者个人设备签名，只保存密文及路由／CAS 元数据；插入不可变原文和比较更新 head 必须在同一事务中完成。完全相同的 request 重试即便 head 已前进仍返回原收据，清理后返回 removed 屏障；同 requestId 改变意图要失败；确认冲突后须明确新意图。读取依当前工作区资格，只有机器所有者可以提交。客户端解密后核对 scope、版本、父摘要与 requestId 元数据是否和签名正文一致。

客户端从首版或自己可信、绑定资源的持久 pin 开始，逐版验证，拒绝跳号、分叉和回退。服务端 head 本身不构成密码学授权或新鲜度。新机器或包含已撤销签名者的缺口可用 `verifyMachineSharingHistoryStep` 验证历史成员身份与摘要链，仅返回临时 head；最后的最新策略通过当前所有者个人设备检查后才推进持久接受 pin，不能仅凭历史步骤执行或接受新 pin。`readMachineSharingHistoryStep` 另返回已认证的完整历史正文，供新的明确所有者意图保留原项目集合；历史签名者必须曾以 personal 设备入账并属于绑定成员，同成员 machine/recovery 也拒绝。它不授予当前权限，也不证明发布时刻或当时权限。新意图通过 `sealMachineSharingPolicy` 使用 n+1、原帧摘要、新 requestId 和当前有效所有者 personal 设备签发，历史读取结果不授权自动重签。`openMachineSharingPolicy` 产生只有模块可创建的验证证据，`authorizeMachineExecution` 拒绝复制／伪造证据，并用当前真实账本复查。只有机器所属成员的个人设备可改策略，工作区 Owner/Admin 无跨成员修改权。Guest/recovery 不能通过“全团队”获得执行权；同成员替换机器密钥可保留策略，新成员实例不继承。签发个人设备撤销后旧策略失效，须由所有者另一有效个人设备签发下一版。

真正移除机器保留带 scope 的 removed head，保存最后已提交版本／摘要，从未写过则为 0/null。重新启用须有新的明确所有者意图，CAS 比较完整 status／scope／版本／摘要，提交 n+1，不能重放旧 pending 请求。同成员原子替换维持 active。版本清理后读取可返回 null，readHead 仍保留 removed 高水位。后台清理保存 cutoff，不能删除更新的提交；保留最小请求意图收据，避免清理后精确重试恢复密文或复用 requestId。独立账号 query `latestForMember` 只向当前工作区账号成员返回密文与未验证的路由／head，不替代设备认证的最新读取或任何写操作。

清空原文后，新客户端或落后客户端无法使用当前 core 证明完整策略链。存储 tombstone 可供写者做 CAS 基点，不是已验证执行 pin。缺口恢复须由 A3 明确约定；没有恢复时保持 pending，不能静默接受 tombstone 或跳过历史。这是物理清理尚未解决的可用性限制，不改变签名格式。

## 接入边界与限制

A2 负责私有存储、设备凭据准入、原子 CAS、精确重试查询与删除清理。A3 负责原文／pin 持久化、实际执行目标解析、账本／策略的经认证最新读取与失效处理，以及 RPC／持久派发共用的 actual-start 门禁。A4 负责既有开关 UI 与已验证可见性。代理派发还须保留双方权限交集，缺少签名主体证据的入口继续关闭。

已知撤回立即阻止新开始与后续需授权动作，不强杀已运行命令。未知变化采用严格小于 15 分钟的缓存，网络请求发起前计时，与账本新鲜度、请求期限取交集；重启或时钟不确定后联网重查。持久时间戳和 issuedAt 不能续期。签名／pin 无法揭示服务端从未投递过的新版本。可用性故障只影响依赖该授权的动作，不阻止读内容和无关工作。A1 不接缓存、网络、UI、任务终止或执行路径。

## 验证

[行为测试](../../../../packages/e2ee-core/test/machine-sharing.test.ts) 使用合成确定性身份、受控 nonce 与显式签名屏障，覆盖规范编码、完整状态开关、所有者／成员／项目绑定、用途域隔离、当前签发设备撤销、版本连续性、未来成员、Guest/recovery 排除及后端不解密验签。既有密码学向量保持不变；这些证据不代表已部署 CAS、真实机器新鲜度或双成员产品验收。
