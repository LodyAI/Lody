# 按用途区分的实时内容加密原语

Status: proposed
Translation: current

[English](2026-10-26-e2ee-realtime-content-primitives.md)

## 摘要

实时集成需要分别加密 presence、请求和响应，同时保持文档签名权限的边界。本改动将既有 content-v0 格式组合成六个处理不透明字节的用途专用 API。它管理临时明文和派生密钥，在解密前核对独立可信的签名者，并保持文档工作流不变。这是 M5 PR 25 可独立审阅的密码学子集；应用 wire 编码、目标机器权限、权限新鲜度和产品集成仍待批准或完成。

## 职责与取舍

`@lody/e2ee-core/protocol` 为既有用途 7、8、9 分别暴露 seal/open API。它们复用 `deriveContentKey`、content-v0 AEAD、严格 Ed25519 和现有内容大小限制。调用方提供可信 genesis、epoch、resource，已安装的不透明 epoch key，以及签名器或独立预期的签名公钥。本改动不选择 resource 前缀约定、body 编码、请求身份、期限或房间 TTL。

复用 `sealDocument` 会扩大受账本授权的文档操作范围；公开通用签名/加密 API 也会暴露多余能力。因此每个公开函数固定一个既有用途，只在私有实现中共享逻辑。成功 open 只证明给定 scope 和签名者下的密码学真实性，不授予权限或执行权。

模块边界继续遵循现有[服务架构](../../implemented/architecture/2026-10-16-e2ee-core-service-architecture.md)。[25S](https://github.com/LodyAI/Lody/pull/1894) 的语义契约候选和 [26a](https://github.com/LodyAI/Lody/pull/1895) 的存储 journal 是独立评审，不是已经批准的集成前提。本改动不批准这些提案，不修改成员/设备管理，不导出私钥，也不启用任何通道。

## 所有权与失败行为

seal 的 Effect 执行前不产生操作。它在异步签名前捕获可变输入，借用 epoch key 和签名器，并在成功、失败或中断时擦除自有明文副本和派生内容密钥。既有不可中断的原生签名边界完成后才释放这些缓冲区。open 在派生/解密前检查 scope 和严格签名者身份，认证失败时释放派生密钥，将解密所得明文交由调用方擦除。局部失败后，借用的 epoch key 仍可使用。

调用方必须保留返回的原始帧用于重试，独立建立当前 epoch/rotation 门禁，并为响应提供原目标的已验证签名者。持有同一 epoch key 的其他设备不能满足该签名者要求。请求关联以及 progress/最终结果/错误分类仍需经过评审的应用 wire 契约。

## 证据与限制

六个完整帧固定向量覆盖用途 7/8/9 及既有 additional-data 绑定的有/无两种情况。独立 Python 生成器使用 RFC 5869 HMAC 和 PyNaCl 1.6.2，不依赖 TypeScript 实现；输入是公开 RFC 8032 seed 和合成明文。重新生成属于评审操作，不改变冻结的 ledger-v1 向量。

行为测试覆盖 scope/用途/epoch/目标/签名者替换，签名有效但 AEAD 上下文错误，复制前大小限制，可变输入捕获，签名/随机数失败，清理、恢复及原生签名中断。本子集没有完成产品 RPC、presence、iroh、打包平台或延迟验收。M5 整体能力仍未完成。
