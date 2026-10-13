# 提取固定代次 HPKE 原语（P07-c）

Date: 2026-10-11
Status: implemented
Translation: current
PR: [#1432](https://github.com/LodyAI/Lody/pull/1432)

[English](2026-10-11-e2ee-hpke-primitive.md)

## 摘要

main 已有格式、验签和内容加密基础，但缺 HPKE 原语。本切片保留现行代次信封的 Base 套件与精确上下文，加入有输入边界的封装/解封装，不接账本、投递或安装。设备原生句柄由调用方持有，封装要求宿主安全随机数；取消等待原生操作完成及清理。成功不证明发送者身份或权限，也不代表生产存钥、完整内存擦除或全平台验收。

## 决定与来源

最终固定 main base 为 `26726a46b11a9b8ae9f1f7f8a0e89ef7d430b760`，已包含 #1417/#1418。初查使用 `978fb404cd2ef0de6c6e35322c226103704167b2`。初查 #1418 仍开放，未使用未合入实现。clone 与 pnpm store 独立，不修改候选、主协调计划或其他作者目录。

候选 `bd5a9c1ec71ed7fa8085e51faec4f1e8dbe985b8` 同时保留旧 JSON 原型和现行账本信封。现行账本规范 §8.5 固定 Base 0x0020/0x0001/0x0003、info `lody-e2ee/hpke-epoch/v1\0`、规范 CBOR `[genesis32, epoch, senderSign32, recipientSign32]`、32 字节明文和 `AAD || enc32 || ct48 || signature64`。外层签名域保留 `lody-e2ee/epoch-env/v1\0`。白皮书 v0.16 保留 epoch 信封；不迁入使用 `lody-epoch-key-hpke/v1` 的旧 JSON 格式。不选择新协议字段或恢复格式。[来源指纹](../../../../packages/e2ee-core/provenance.json)记录源/目标 SHA-256。

新增依赖只包含候选闭包 core 1.9.0、chacha20poly1305 1.8.0 和 common 1.10.1。Effect 仍为 4.0.2。已撤掉 pnpm add 附带的锁文件重排/间接升级，冻结安装验证最小锁文件。

## 所有权与信任

```text
可信上下文 + 不透明代次钥 + 收件加密公钥 -> 固定 Base seal -> 未签名 enc32/ct48
可信上下文 + 外部设备句柄 + 预期公钥 -> 固定 Base open -> 不透明 EpochKey
调用方：外层签名、当前资格、承诺、异步后复核、持久安装
```

不公开套件/info/随机覆盖，不生成身份、导出私钥、提供账本权限、投递、存储、运行时或后台 fiber。密码操作成功不带“已授权信封”品牌。调用方拥有原生设备密钥生命周期，每次调用结束丢弃套件状态。普通 try/finally 清理临时明文和随机副本，避免 Result.gen 失败短路跳过清理；调用方秘密/句柄继续可用。

WebCrypto/HPKE 无 AbortSignal 接口，因此仅这一次有限原生操作不可中断，取消在已有 owner 内等待完成和清理。原生宿主若不返回，关闭仍可能等待；清理 JS 缓冲区不保证擦除库/原生运行时内部副本和派生 CryptoKey。

## 证据与剩余限制

公开入口包测试与类型检查覆盖 RFC 9180 A.2.1、独立 Python HMAC/X25519/ChaCha20Poly1305 字节、精确 AAD、可信上下文替换、严格长度、低阶 DH 拒绝、旧 info 拒绝、随机失败、不可导出原生私钥及显式信号驱动的 scope 取消。Python 生成器先复现 RFC，再生成 Lody 向量；测试不依赖 Python 或网络。

实际候选驱动对照与浏览器证据在 PR 交接记录。候选 core 七项/Lab 两项历史失败保留 [P07-a](2026-10-10-e2ee-foundations.zh.md) 和 [P07-b](2026-10-11-e2ee-content-crypto.zh.md) 的原边界；对应账本/恢复/投递模块未迁入，不声称修复历史失败。额外独立高风险审查由协调安排。生产存钥、完整信封工作流、全平台矩阵与已部署客户端仍未验证。

最终基线作者验证：包 **113/113**（HPKE 28、foundation 46、内容 crypto 18、ledger 21）和包类型通过。只读实际候选驱动与独立向量一致、双向互通。公开入口在 Chromium 145.0.7632.6 打包运行，实际安全随机、不可导出原生 X25519 私钥、往返及篡改拒绝通过。冻结安装、root format、docs（零错误、65 条既有提醒、无受保护 topic 改动）、i18n 及公共/平台/进程/import 边界检查通过。

完整 pnpm check 通过全仓类型/lint 后停在未改动 CLI 原生 Git 凭证递归用例：context_unreadable，3720 过/1 败/4 跳过。隔离 main 26726a46 的六项套件复现 5 过/1 败；只移除测试进程继承的 GIT_EXEC_PATH 后 6/6。不改全局设置或源码，不称其他排队套件已完成。初始 clone 缺 acp-extension-core 构建产物，构建锁定源码后解决准备错误。初版取消测试误用了 v4 不存在的 Fiber.poll，异常后未释放测试门导致超时；改为显式门与 pollUnsafe 后通过，未改变运行时代码。
