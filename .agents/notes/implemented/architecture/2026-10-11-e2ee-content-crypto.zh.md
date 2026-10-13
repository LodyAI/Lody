# 提取绑定上下文的内容密码原语（P07-b）

Date: 2026-10-11
Status: implemented
Translation: current
PR: [#1417](https://github.com/LodyAI/Lody/pull/1417)

[English](2026-10-11-e2ee-content-crypto.md)

## 摘要

主线能编码内容 v0 和验签，但还不能派生钥匙或检查密文标签。本切片在公开入口加入绑定上下文的 HKDF-SHA-256 与 XChaCha20-Poly1305 原语。候选算法和协议字节保持不变，输入限制和随机源失败有明确结果。生产调用方、签名私钥、账本、存储及完整内容工作流仍需独立实现；独立审查与产品验收也分别进行。

## 范围与来源

基于已合入 P07-a #1405 与 main `c52e5d26b5260cc94191cbae62d4fe11cfa2bb04`。
Effect 保持 4.0.2，hashes 保持 2.2.0；ciphers 2.1.1 与候选一致，根锁文件已有此版本，只添加 importer。开工已核对现有 E2EE PR 防止重复。

[来源记录](../../../../packages/e2ee-core/provenance.json) 扩展 [P07-a 记录](2026-10-10-e2ee-foundations.zh.md)，补充 content-frame 与 platform-content 指纹。两份源文件均与候选提交 `bd5a9c1ec71ed7fa8085e51faec4f1e8dbe985b8` 一致，未迁入暂存的 SDK 修复。现行协议和候选在本范围一致：salt/info、文档用途共钥、外部绑定、包头、算法、nonce 与 tag 长度。候选保持只读，测试在临时副本中运行。

切片停在 ContentCipher、DocumentKey 导入导出和签名工作流之下。ContentKey 保存不可直接取出的秘密并绑定上下文；四种文档用途共钥，其他用途隔离。同步 noble HKDF 复用已锁定 hashes，不增加异步 WebCrypto 服务或运行时；实际候选 WebCrypto 对照验证字节一致。HPKE 留后续。

## 职责

```text
调用方提供可信包头、上下文与 EpochKey
  deriveContentKey -> 绑定上下文的内容钥（HKDF-SHA-256）
  sealContentAead -> 安全随机 nonce 与密文/tag
  openContentAead -> 检查长度、上下文和标签 -> 明文
调用方另行检查签名、作者资格和当前权限
```

不选择生产授权或平台存钥方案，不拥有游标，不恢复快照或保存数据。单文档失败、客户端恢复、全平台 Beta 的已定规则不变。

新加密要求宿主 crypto.getRandomValues；缺失或抛错只返回固定错误码。调用宿主前已捕获输入，不开放 nonce/随机源覆盖或明文降级；重试保留原密文。复制大输入前检查限制，长度错误与标签失败分开。临时组织钥、操作钥、PRK 和明文副本清理；派生钥随对象可达性保留。JavaScript 清理不保证运行时擦除所有副本。

## 证据与限制

- 公开入口 64/64 项通过，原 46 项加新 18 项；类型通过。覆盖 8 个独立编码的 Python HMAC/libsodium 固定向量、原生 HKDF、九种用途、错上下文/钥/包头/绑定、损坏、16 MiB/1024 字节精确边界、随机源失败与输入所有权。生成器已保存。
- 临时副本实际候选内容测试 25/25；额外实际候选 WebCrypto/AEAD 对照覆盖九种用途各两种绑定。
- 公开入口浏览器包构建并在 Chromium 运行，真实随机源、加解密与损坏拒绝通过。支持版本、原生/手机存钥、生产接线及完整安全验收未完成。
- 新测试首轮问题：16 MiB 深比较耗尽测试进程内存，改为长度加 Buffer.compare，仍检查全部字节；错用途用例误用了原上下文，修正后验证实际拒绝。
- 候选 7 项核心/2 项 Lab 旧失败仍属账本信任、投递、换钥恢复和控制同步，详见 P07-a。未迁入这些模块，不关闭这些失败。

全仓类型/lint、format/format:check、docs（零错误/无受保护 topic）、i18n 与各项边界检查通过。完整 pnpm check 停在未改动的 CLI 递归 Git 凭证用例：context_unreadable，3708 过/1 败/4 跳过。临时目录固定 main 源码的六项套件同样 5 过/1 败。首轮沙箱 loopback EPERM 单独记录，完整重跑允许本地监听；不称其他排队套件已完成。一轮 CI 记录在 PR。没有触碰真实密钥、全局设置、设计目录或其他执行者工作区。本轮不发布、部署、转 Ready 或合入。

## 修订：失败路径的临时副本清理

实际 Effect 4.0.2 的 Result.gen 遇到 Failure 后直接返回，不会关闭生成器。因此生成器中的 yield* 失败可能跳过 finally，原提交在随机源或标签失败时没有清理临时副本。现在先在普通函数中执行完 finally，再 yield 返回的 Result，不改变协议字节或错误码。新回归保存实际数组引用并检查随机失败后的钥/明文副本、认证失败后的钥副本已清零且叶子钥仍可使用；同一用例在 9abee347f 源码副本上失败。它检查结果状态，不依赖 mock 调用次数。
