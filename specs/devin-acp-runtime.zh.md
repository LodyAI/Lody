# Devin ACP 运行时

Status: draft
Translation: current

[English](devin-acp-runtime.md)

用户无需先在全局安装 Devin CLI，即可添加 registry 中的 Devin provider。Lody 使用
ACP registry 发布的官方平台 binary，通过 registry binary 安装流程下载，将其缓存在当前
installation profile 下，并启动其中的 `acp` 命令。Provider setup 会展示下载进度；artifact
安装失败时，用户可以重试。

Registry 条目是版本和平台信息的唯一来源。不受支持的操作系统或架构必须明确报告为不支持，
不能回退到无关的全局命令。有意使用自行安装的 Devin executable 的用户，可以通过 Custom ACP
provider 配置对应命令和参数。

## 证据

- [Registry 生成](../scripts/generate-acp-registry.mjs)
- [Registry binary 安装](../apps/cli/src/agent/acp-binary-manager.ts)
- [启动解析](../apps/cli/src/agent/setting.ts)
- [决策记录](../.agents/notes/implemented/bug-fix/2026-09-18-devin-managed-binary-restoration.zh.md)
