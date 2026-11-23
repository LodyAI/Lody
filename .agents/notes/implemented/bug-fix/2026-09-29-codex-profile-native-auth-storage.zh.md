# 无系统密钥库时的 Codex 账户登录

Status: implemented
Translation: current

[English](2026-09-29-codex-profile-native-auth-storage.md)

## 摘要

托管 ChatGPT 账户此前强制 Codex 使用系统密钥库，导致无密钥库的 Linux 容器中设备
授权成功后仍无法保存凭据。新账户现在于独立目录使用固定版本 Codex 的原生默认存储，
可写入文件而无需在账户间搬运凭据。此前已在密钥库中就绪的账户继续使用原后端；
独立的 API Key 凭据库仍要求系统凭据服务。

## 决策与兼容性

[Issue #1109](https://github.com/LodyAI/Lody/issues/1109)记录了 OAuth 交换成功后，
Linux Secret Service 写入失败。Codex 0.156.0 在未指定
`cli_auth_credentials_store` 时默认使用 `file`；去掉 Lody 的密钥库覆盖后，
原生程序可以在账户私有目录中的 `CODEX_HOME/auth.json` 写入凭据。登录、会话启动和
退出登录始终使用同一账户目录；切换提供商不会把文件复制到全局 Codex 目录。

新账户元数据记录 `authStore: codex-default`。旧版已就绪 ChatGPT 记录没有此字段，
按 `keyring` 读取，避免升级后丢失既有凭据。旧版待登录记录没有成功凭据需要保留，
重试时采用原生默认存储。删除时先持久化解析出的后端，再清理凭据；清理中断后
仍沿用同一后端。API Key 代次继续留在宿主系统凭据库，本次不增加 API Key 文件回退。

此前的[账户配置决策](../../proposed/architecture/2026-09-26-codex-account-profiles.zh.md)
要求 ChatGPT 使用密钥库并排除文件存储。本决策只改变新账户的存储选择，保留账户
隔离、不可变提供商绑定以及由 Codex 负责 OAuth 刷新。现行契约见[草案 Spec](../../../../specs/codex-account-profiles.zh.md)。

## 证据与限制

官方[Codex 认证文档](https://learn.chatgpt.com/docs/auth)说明 `auth.json` 位于
`CODEX_HOME`、系统密钥库不可用时 `keyring` 模式失败，以及文件中含有明文凭据。
固定版本的[0.156.0 配置源码](https://github.com/openai/codex/blob/rust-v0.156.0/codex-rs/config/src/config_toml.rs)
将 `file` 标为默认值。现有账户目录以 `0700` 模式创建；验收流程检查两个
ChatGPT 账户使用不同认证文件，且文件权限仅允许所属用户访问。

存储测试覆盖新记录、旧版待登录和已就绪记录，以及删除时的后端保留。macOS 验收
录制器覆盖原生登录和账户切换，但本次尚未在无密钥库 Linux 容器中使用真实账户验证。
现有同账户原生刷新竞争不变。
