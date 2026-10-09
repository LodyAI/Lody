# 内置 Devin

Status: draft
Translation: current

[English](builtin-devin.md)

用户在添加 Agent 或引导中选择 Devin。目标机器从公共托管运行时渠道准备经过
校验的官方 Devin，再以显式运行时路径启动随 CLI 打包的 ACP adapter。下载、
缓存复用、取消及后台升级沿用已有托管运行时契约。

Adapter 使用固定提交的公共 submodule。官方运行时字节不做修改；版本化清单固定
macOS、Linux、Windows 的 arm64/x64 六个平台归档。发布必须先校验官方源哈希，
再完成正式渠道的全部上传和回读。自定义镜像和 dry run 不得改变正式校验值。

认证使用 Devin 公布的 ACP 浏览器方法，并检查目标机器的协议能力。凭据由
provider 自己管理。模型、权限和扩展能力来自实时探测，不添加推测性的静态模型
列表或标题所有权。

Devin、Dimcode、Kimi、Kimi Code 不出现在 registry 发现列表。已有 registry
配置仍能启动，不自动转换 provider 记录或原生 session ID。保留 builtin 品牌图标。

## 证据

- `apps/cli/src/agent/setting.ts` 与 `managed-agent-runtime.ts`。
- `scripts/generate-acp-registry.mjs`。
- 官方版本清单：<https://static.devin.ai/cli/3000.11.3/manifest.json>。
