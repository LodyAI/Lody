# 账本用户 ID 就是账户 ID

Status: implemented
Translation: current

[English](2026-11-06-e2ee-ledger-user-id.md)

## 摘要

账本里 32 字节的用户 ID 原本是服务端为每个账户分配的随机公开值，为此多了一张注册表、一份客户端缓存和一次签名前的网络调用，却没有保护任何东西：值由服务端分配，也从未证明账户拥有某把签名密钥。Owner 于 2026-11-06 决定该字段直接存账户 ID。`accountUserId` 对其做可逆编码，客户端本地计算，服务端只校验签名里的值确实是当前认证账户。字段仍是 32 字节，账本格式和 v1 向量不变，但这条编码规则在生产首次开放加密工作区创建后永久冻结。权限来源不变，仍是签名、已验证账本和签名策略。

## 决定

用户层字段保留。“每个用户只有一个当前成员资格”和“重新加入后认出同一人”都需要一个比成员实例存续更久的值，设备公钥和成员实例 ID 都提供不了。变的只是值。

`packages/e2ee-core/src/internal/foundation/account-user-id.ts` 的 `accountUserId` 定义布局。第 0 字节是字符数，范围 1 到 49。之后是小写 Crockford base32 字母表 `0123456789abcdefghjkmnpqrstvwxyz` 的字符，每个 5 位，高位在前。其余位全为 0。其他输入一律拒绝，不做规范化；`accountIdFromUserId` 拒绝编码器产生不出的字节。

托管账户 ID 是 Convex 文档 ID：二进制 19 到 23 字节，写成 31 到 37 个 base32 字符。按文本放不下，解码后放得下。规则按字符打包、按字符计数，所以不解释 Convex 的表号和校验和，只依赖公开的字母表和长度，存下的位就是该 ID 自身的二进制形式。Core 不依赖任何账号系统。

创建和成员申请在本地签入这个值，签名前没有网络调用。服务端在预约写入前根据认证账户重新计算，不一致时用现有的 `e2ee_account_identity_conflict` 拒绝，渲染层已把它当作未预约的拒绝处理。这是归属校验，不是权限。成员目录保留 `cryptoUserId` 字段，内容现在就是这个编码。

## 备选方案

- **保留随机值。** 它需要注册表和不可变的客户端文件，唯一作用是对成员隐藏账户 ID，而成员已能从明文 presence 看到这个 ID。见[已否决的提案](../../rejected/architecture/2026-10-26-e2ee-account-global-identity.zh.md)。
- **对账户 ID 做 SHA-256 派生。** 同样能去掉注册表，还不把原始 ID 写进永久账本。Owner 选了可还原的原始 ID：读账本就能直接得到账户。
- **删除字段。** 这会改动 genesis 和 JoinRequest 记录，并失去重复成员和重新加入规则。

## 后果

凡是提到成员的记录都永久保存账户 ID，工作区成员可以读到。更换账号系统时必须把旧 ID 保留为稳定主体，因为已有账本写的就是它们。将来若出现字母表之外或超过 49 字符的账户 ID，会在签名时被拒绝；扩展规则需要新的账本能力或字段含义，不能改这个布局。

## 验证

`packages/e2ee-core/test/foundation.test.ts` 固定两个由 Python RFC 4648 base32 生成的向量，并覆盖往返、拒绝和非规范字节。`apps/electron/src/main/services/e2ee-bootstrap.test.mjs` 和 `e2ee-runtime.test.mjs` 覆盖同一账户跨工作区以及重新加入保持用户 ID。`packages/e2ee-client/test/account-requester.test.ts` 覆盖本地查找成员资格。没有测试跑在真实 Convex 部署的 ID 上；字母表和长度来自公开的 convex-backend 源码（`crates/value/src/base32.rs`、`id_v6.rs`）。
