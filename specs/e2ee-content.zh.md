# E2EE 内容包紧凑格式 v2

Status: draft
Translation: current

[English](./e2ee-content.md)

一份文档仍以整个 batch 加密，即使其中包含多个 CRDT update。调用方已经持有组织和文档上下文，无须在每包重复 ID 和自报作者。重复作者也使仅从账本快照起步的读者难以核对完整身份。

## 格式与可信上下文

新写统一用 v2。多字节整数均为大端无符号整数，公钥、nonce、密文和签名为原始字节。外层 SDK 或 blob 存储提供完整包边界，内层不另存总长度。

```text
packet = version(1，值为2) || epoch(u32be) || signerPublicKey(32)
       || nonce(24) || sealed(明文长度+16) || signature(64)
prefix = version || epoch || signerPublicKey
unsigned = prefix || nonce || sealed
```

`sealed` 已包含 XChaCha20-Poly1305 密文和唯一的 16B tag。Ed25519 严格检查规范编码与素数子群。明文允许 0..16 MiB，整包为 141..16 MiB+141B。未知版本、非法公钥、截断和超限都失败，无明文后备。代次为 0..2³²−1，与账本代次约束一致。

调用方独立提供预期 genesis、逻辑文档/资源 ID 和用途。genesis 就是组织身份，不再加另一份组织 ID。URL 仅用于路由，不能作为资源身份。`inspectContent` 只返回未验证的 `{version, epoch, device}`；本地 API 的 device 是签名公钥的 hex 表示。代次只用于查询本地已验证 keyring。即使不解密，`authenticate(scope, frame)` 也必须提供可信 scope。

规范化二进制上下文 `C` 为：

```text
C = genesis(原始32B) || epoch(u32be) || resourceLength(u16be)
  || resource(1..1024B可打印非空白ASCII) || purposeCode(u8)
```

用途码 1..9 依次为 `doc-update`、`doc-snapshot`、`flock-update`、`flock-snapshot`、`blob`、`epoch-history`、`presence`、`rpc-request`、`rpc-response`。不做 Unicode 归一化，不接受别名，不转换 JSON 数字/字符串。以下域均是字面 ASCII，包含末尾零字节：

```text
key = HKDF-SHA-256(epochKey,
  salt="lody-content-hkdf/v2\0", info="lody-content-key/v2\0" || C, length=32)
AAD = "lody-content-aad/v2\0" || C || prefix
signatureInput = "lody-content-signature/v2\0" || C || unsigned
```

非空外部 `additionalData`（1..1024B）使用独立绑定域与显式长度。省略或空数据保留上面的通用 v2 公式。外部字节及其长度只参与认证，不成为传输字段：

```text
B = u16be(additionalData.length) || additionalData
AAD = "lody-content-aad-bound/v2\0" || C || B || prefix
signatureInput = "lody-content-signature-bound/v2\0" || C || B || unsigned
```

seal、open/authenticate 在异步执行前复制独立输入。缺少或改变绑定时签名失败；给原密文换绑定并重新签名，仍会在 AEAD 处失败。外部 AAD 不改变 HKDF，也不增加包字节。

接收端从自身预期上下文构造 C，不从收到的头部采信上下文。组织、文档、用途不符时签名失败；真实签名者给原密文换上下文并重新签名，也仍会在 AEAD 处失败。

## 作者与权限

包内公钥只是查询候选。`ContentPolicy` 只能通过指定组织的已验证账本接受公钥。`contentAuthorKey` 检查组织和当前/历史登记证据；异步密码操作后再次检查 authority 一致性。持钥不等于发表或命令执行权。Guest 与 R 不能密封新文档内容；当前个人/机器设备的写权限、换代暂停门槛，与历史验签分开。合法旧代仍可读取。

`Ledger.contentIdentity`、`LedgerView.contentIdentity` 从已验证回放建立的索引恢复原用户和成员实例。撤设备/移除成员不删此索引；从已保存、重新验证的历史恢复时重建。签名钥不能换成员实例后再次登记。索引不加入账本或账本快照 wire。认证快照只能恢复其中当前设备的映射；已撤历史设备若仅有防重放登记事实，返回 `device-only` 与 `missing-history-context`，保留既有历史验签语义，不虚构完整身份。补齐作者归属需要完整已验证历史。

本地 `SealContent.author.actor/memberInstance` 暂留为现有适配器的调用方元数据，不编码、不用作身份依据。batch/快照签名标识其生成者，不证明每条原始 CRDT operation 的作者。删除 messageId，不引入命令持久防重放方案。

## SDK 与宿主职责

SDK `provider.open` 返回原始 batch/快照内容字节。SDK AAD 作为外部 `additionalData` 同时参与 AEAD 和签名，不再复制到明文。SDK AAD 是固定 40B 域 `loro-streams-crdt-payload-protection/v2\0` 加上已认证的 10B LSCE 前缀和 1B provider header，共 51B。宿主从结构验证后的信封重建这些字节，独立验签。provider header 改为 update `3`、snapshot `4`；拒绝此前在明文复制 AAD 的 `1`/`2`。SDK 外层与内容包版本均仍为 2。

update 明文就是原始 SDK batch。snapshot 明文保留 `u16be(offsetUtf8.length) || offsetUtf8 || originalSnapshot`，UTF-8 offset 为 1..1024B，并与接收端 continuationOffset 比较。SDK 再包装 1B header 和完整内容包，其开销与内层 141B 分开。update POST body 为 `4B item 长度 + 10B SDK 前缀 + 1B provider header + 141B 内容开销 + batch`，即 `batch + 156B`；batch 对每个原始 update 增加 4B 长度。删除 `2B aad 长度 + 51B aad` 后，每个加密 batch 节省 53B。这是编码请求体长度，不含 HTTP/TLS。宿主独立提供组织、文档和快照用途，绑定已认证提交设备与签名设备。原始租期、当前写权、精确重试幂等和原子发表存储保持。读端认证快照续读位置。文档持久化先于持久游标；保存失败保留原游标供重放。

每次 Effect 执行持有独立、可清空的工作副本。派生钥通过 Effect 资源释放机制清空，覆盖失败和中断；仅靠 JS 生成器 `finally` 不足以处理 typed Effect 失败。不可变捕获输入支持重复、并发和失败重试。不承诺清空 JS/WebCrypto 的所有隐式副本。

## 兼容与接入边界

这是 private 实验包，产品内容流尚未启用。源 checkout 未发现持久内容数据库/repro fixture；Lab 默认使用独立临时目录，`--data-dir` 和另存的 repro pack 可能保留 checkout 之外的 v1 字节。未穷举这些外部目录，不能宣称旧数据全部不存在。

优化后的 SDK reader 也拒绝此前实验 v2 的 provider header `1`/`2`。不使用外部 AAD 的通用 v2 内容保持兼容。保留旧 v2 SDK 实验时须使用其精确的优化前 reader/源码；新绑定代次使用新流/数据目录，不提供静默后备或自动迁移，也不声称外部旧数据全部不存在。

v2 reader 拒绝 v1。旧实验保留使用固定在 `35bfca7e` 的 v1 reader；v2 Lab 使用新目录。确需迁移保留数据时，先用固定 v1 实现与独立 scope 验签、解密，再由真实新生成者向独立暂存流发表 v2 快照。保留原始签名字节供审计，不能静默替他人更新重签或改作者归属。本次不提供自动迁移。

ledger record、epoch-envelope、独立 72B 历史包和密钥投递回执不变。旧控制日志可选的、基于内容 frame 的历史辅助路径改用 v2，受同一兼容限制。

现有内容消费者为 SDK/provider、快照发表、Lab 宿主、Lab 内容会话及攻击专用 insider reader，均提供独立 scope。通用 blob/presence/RPC 用途覆盖编解码往返与跨用途拒绝，但完整产品附件/presence/RPC 和生产网关接线仍未实现。已发布 streams-crdt 0.15.1 缺快照 continuationOffset，core 的 HTTP 快照验收使用既有 `LORO_STREAMS_CRDT` 源码覆盖；Lab 使用现有 vendor SDK。本次没有部署，也没有形式化安全证明。

本规范替换[旧控制日志规范的内容头说明](./e2ee-control-log.zh.md#内容信封实验版)和[账本规范](./e2ee-ledger.zh.md)的内容作者条目；其中独立账本/恢复格式不属于本决定。

## 证据

- [决定与长度结果](../.agents/notes/implemented/architecture/2026-10-09-e2ee-content-v2.zh.md)。
- [编解码和密码输入](../packages/e2ee-core/src/pure/content-frame.ts)、[工作流](../packages/e2ee-core/src/workflows/content.ts)。
- [内容测试](../packages/e2ee-core/test/content.test.ts)、[SDK/持久化](../packages/e2ee-core/test/streams-content.test.ts)、[历史归属](../packages/e2ee-core/test/ledger-content.test.ts)、[Lab authority](../packages/e2ee-lab/test/content-authority.test.ts)。
- [XChaCha 的合并 tag](https://doc.libsodium.org/secret-key_cryptography/aead/chacha20-poly1305/xchacha20-poly1305_construction)、[HKDF 上下文](https://www.rfc-editor.org/rfc/rfc5869)。
