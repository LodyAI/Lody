# 恢复 vault

Status: draft
Translation: current

[English](recovery-vault.md)

## 已批准的格式边界

2026-10-28，owner Zixuan Chen（zxch3n）仅批准以下边界，见[批准记录](../../.agents/notes/implemented/architecture/2026-10-28-e2ee-spec-approval.zh.md)（[批准记录更新 #2032](https://github.com/LodyAI/Lody/pull/2032)）：恢复设备登记保留现有账本 tag 4 和 `lody-e2ee/possess/v2\0` 字节，genesis 不变。加密恢复包使用 `formatVersion: 1`，保存恢复 generation 和可信账本材料；可信锚须由外部独立确认。加密包、其来源定位符或服务端响应本身不能建立可信锚，也不能证明账本最新。

恢复验收前须导入 R 的密钥、独立确认可信锚、实际解密发给 R 的当前代信封，并根据账本承诺核对恢复出的代钥。R 的签名绑定加密公钥，但单凭签名不能证明加密私钥持有。包版本和上述边界已批准；保险库的其余设计及本 Spec 整体仍为 **draft**，恢复保险库不在 MVP 内。core 恢复包已携带 `formatVersion: 1`，拒绝缺失或其他版本；私钥必须是 Ed25519 与 X25519 的 48 字节 RFC 8410 PKCS#8 精确编码（此实现细节仍待 owner 审阅）。批准不代表已部署或真机行为已通过验收。

## 恢复材料与密文

一个规范 CBOR `vault-v1` 恢复文件打开加密 vault。固定元组为
`["vault-v1", 1, vaultId, serviceLocator, U]`，vaultId 和 U 各为独立随机的
32 字节。另生成独立随机的 32 字节主密钥 V。用 HKDF-SHA256 派生 32 字节
包装密钥，salt 为 vaultId，域为 `lody-e2ee/vault-v1/<purpose>\0`，再用
XChaCha20-Poly1305 包装 V。文件提供解锁能力，不是生成未来工作区身份的种子；
文件无法重建已经丢失的云端密文。

第二包装入口只在已认证的 WebAuthn ceremony 实际返回 PRF `enabled: true` 和
32 字节 `results.first` 后创建，包装同一个 V。core 校验并拥有结果副本；平台
适配器负责认证 ceremony 和 credential。普通 passkey 登录、伪造的能力对象都不能
解锁。禁止 PRF 降级。产品 E2EE 关闭时不自动调用硬件 ceremony。

工作区条目和索引用 V 按用途分开派生密钥。每次加密必须取得新的安全随机
24 字节 nonce，随机源失败即停止。AAD 绑定 vault-v1、vaultId、不透明 entryId、
revision、前一版本密文摘要和用途。服务外层只有不透明 entryId 和 revision。独立认证的加密头隐藏前摘要及用途，
内部 AEAD 绑定完整 AAD；两层各用新的随机 nonce 和独立 HKDF 用途密钥。
服务不取得工作区身份、角色或私钥。同一 entryId 的密文不可变。
私有包绑定 genesis、当前 membership 实例、独立的 R 签名/加密密钥对、generation
和可信 genesis/账本材料来源。加密索引绑定同一身份和精确包摘要。导入时校验真实
公私钥配对。解密成功的声明不能成为账本权限。

## 并发与持久设置

先上传不可变候选，精确读回并解密，再 CAS 加密索引。CAS 还携带新索引引用的 opaque entryId；
存储必须在同一事务内确认这些不可变条目全部存在，缺失时返回 Conflict，避免读回与 CAS
之间被并发删除后发布悬空引用。CAS 携带预期 revision 和
密文摘要，后继绑定前驱。客户端持久保留见过的最高 revision/摘要，拒绝回滚和
同版本不同密文。AEAD 不证明新鲜度：新设备仍依赖已认证服务的新鲜读取和独立
资格核验过的账本材料。

同一工作区、同一 membership 并发首次设置时，只用胜出的索引条目中的 R。
败者重新读取并解密赢家，不登记自己的候选。不同工作区的冲突显式合并/重试，
不后写覆盖。同一身份的新 generation 必须显式替换，不能静默覆盖。

设置是四步可续做流程，不是跨存储事务：

1. 生成独立工作区 R，通过恢复文件或已验证 PRF 解锁 V。
2. 加密、上传、读回并解密私钥包，再通过索引 CAS 选定。
3. 当前活跃个人设备签名登记 R。P09 dispatch 前持久保存原始签名记录和目标位置，
   未知结果按原字节对账，再核验真实提交的 membership。
4. 打开 R 当前 mailbox 或已提交的暂存信封，核对 commitment、验证完整历史钥包，
   保护保存并真实读回密钥。

日志保留候选 entryId、加密索引 CAS 意图、已选条目、账本原字节、位置和阶段。
崩溃后沿用原身份；存在待定意图或当前索引引用时不能清理候选。一个工作区失败
不推进另一个的状态。

分别暴露已配对、当前信封可用、已可恢复。已可恢复同时要求账本里 R 活跃、R 包
实际可解密、genesis 可信、当前钥的 commitment 通过。上次测试时间和测试 epoch
单独保存；旧 epoch 测试不覆盖新 epoch。用户明确确认可能失去恢复途径后可跳过。

## 新设备恢复与保留

新设备解密选定的 R 包，独立验证当前账本及活跃 R，打开当前信封并逐包验证历史。
新生成独立个人设备 C，由 R 用真实 PoP 签名登记到同一 membership，持久保存并通过
P09 重试同一记录，核验已提交 C。之后改用 C，释放临时 R 句柄并清零己方秘密字节。
WebCrypto 没有原生句柄清零 API，适配器不得保留这些句柄或把 R 导出到持久的普通
设备存储。C 继承用户当前角色，已撤销 R 不能再登记设备；普通 mailbox 不静默放宽
历史发送者撤销检查。

活跃包不自动过期。常规替换先验证新包和新 R，再退役/撤销旧 R。已知泄露优先
撤销，即使暂时无法恢复。退役密文保留到用户明确清理，并提示恢复途径可能丢失。
删除云端密文不能撤销已复制秘密。本轮永久保留失败的候选条目，不提供候选垃圾
回收 API。本地日志无法证明其他会话没有待定引用。已退役索引条目的清理仍是
独立操作，要求最新索引 CAS 和用户明确确认恢复途径丢失的风险。

## 边界与验证

core 定义平台中立的加密存储及本地日志端口，拥有密码学、索引选择、设置和恢复。
DTO 属于 packages/cloud-api；私有适配器负责云端认证访问，不授予账本权限。
Lab SQLite 实现不可变条目、索引 CAS 和事务内精确读回。桌面保管能力显式注入，
Lab 合成保护不代表生产钥匙串。登录控制读取，恢复文件控制解密，不是密码学双因素。

外围约束见[白皮书](whitepaper.zh.md)、[权限账本](permission-ledger.zh.md)及
[保护边界](../../packages/e2ee-core/docs/workflows.md#installedepochkeys-and-installedepochhistory)。本修订保持 draft
供用户审批，测试通过及翻译完成都不批准 Spec，也不启用产品 E2EE。
