# 用发布版 Streams SDK 验证公开密码学接口（P10 准备）

Status: implemented
Translation: current

PR: [#1433](https://github.com/LodyAI/Lody/pull/1433)

[English](2026-10-11-e2ee-sdk-preparation.md)

## 摘要

此前渲染端传输只有可逆的保护测试，不能证明内容签名与认证加密能通过真实 SDK 边界。这次在现有传输测试中组合已合入的 P07 公开原语和 P08 合成当前作者回放，使用 Repo 0.22.0 验证真实更新与快照。原生 Ed25519 签名完全留在测试中，生产没有新增入口。历史作者授权、生产签名密钥宿主和坏快照客户端恢复仍缺失，因此这不是 P10 完成或产品 E2EE 验收。

## 边界与证据

固定输入是公共 main `f1ba33a61244e2da07aaea93a30f06227311c4b6`，包含 P07-b 与 P08。[输入指纹](../../../../packages/components/tests/workspace-streams-crypto-provenance.json) 标明实际已合入源码，没有迁入候选模块或 Lab 宿主。唯一依赖新增是 components 对现有 core 的 **devDependency**。Effect 保持 4.0.2、Repo 0.22.0、Streams CRDT 0.16.2、Loro 1.16.3。P07-c 密码学与 P09 journal 目录不在本次范围。

```text
合成原生签名端 -> 公开 v0 AEAD 与签名字节 -> 真实 SDK batch/快照
读端固定上下文与签名者 -> 严格验签 -> AEAD -> 快照位置
  -> 解压 -> CRDT 导入 -> repo 持久保存 -> 游标
```

测试宿主只保存字节，不接纳签名或授予权限。发布版 `encodeStreamsRoomAdditionalData` 重建真实快照 AAD，供单独验签。坏 tag 会重新签名，说明签名有效仍须另验 AEAD。错误组织、逻辑文档、用途和代次失败；包内信息不能建立可信上下文。真实安全随机源失败时不上传。读取失败保留已存内容与旧游标；同一传输中的另一文档继续工作。有效压缩快照可导入；坏签名、密文认证失败和错误续读位置在解压前拒绝。只使用公开 RFC 8032 测试种子与可丢弃合成数据。

P08 公开 `verifyLedger` 从固定创世与链尾/数量认证合成当前个人 Owner。公开 `LedgerState.devices` 描述当前设备，未暴露撤权或重新加入后所需的原作者/成员实例映射。[P08 限制](../../../../packages/e2ee-core/src/ledger/README.md) 明确把历史作者 API 与快照信任留到后续。[P07-b](../architecture/2026-10-11-e2ee-content-crypto.zh.md) 仅提供 AEAD，没有 signer 或完整签名流程。直接搬候选 ContentCipher、权限或签名宿主会掩盖依赖缺失，因此先交付可独立运行的准备测试。

现有传输 Spec 仍说失败范围未决定；相对已定单文档行为，这是旧文档。测试证明一篇文档失败不必停止另一篇，不新增空间监督器或用户体验。空间授权失效另处理。本次不改 Spec 意图，不决定新协议、恢复格式、期限或用户体验。

## 验证与后续

Node 22.23.1、pnpm 10.20.0：传输/游标测试 43/43（传输 37，含 13 个新增用例），核心 85/85，components 全量 556 文件、5,076 测试通过。核心、components 源码与所属测试类型检查、定向类型感知 lint、根格式化、固定 base 的文档检查、i18n/导入/进程/平台/公共边界，以及八个源码指纹通过。根 `pnpm check` **未全绿**：普通沙箱的 socket/端口测试报 EPERM 或超时；允许本地端口后，未修改的 preview/worktree 测试 33/33、IPC 9/9 通过。允许端口的完整检查通过 typecheck/lint，CLI 为 3,710 通过、1 失败、4 跳过；唯一失败是未修改的 native Git helper 测试报 `context_unreadable`。单独复现为 5 通过/1 失败，仅从该测试进程移除 `GIT_EXEC_PATH` 后 6/6 通过。其余根测试组被该失败中断，没有修改相关实现或断言。额外所属测试类型检查包含 components 源码的全局声明；缺这些声明的孤立文件检查不代表包的编译上下文。

本次没有生产 signer、历史权限策略、快照宿主准入、取钥、功能开关、服务端/云/私有 gitlink 或部署。坏快照**拒绝不等于恢复**：历史或副本选择、替换、保留本地修改和恢复后续读仍需独立实现验收。产品未暴露 nonce 或 verifier 注入。资源所有权与运行时不变，测试沿用已有清理与假时钟。候选原有七项 core、两项 Lab 失败保持在本范围之外，见 [P07-b 限制](../architecture/2026-10-11-e2ee-content-crypto.zh.md)。定向测试和 CI 不等于独立高风险审查、生产或全平台验收；额外审查与后续集成由协调方安排。
