# 恢复 Devin 的托管 registry binary

Status: implemented
Translation: current

[English](2026-09-18-devin-managed-binary-restoration.md)

## 摘要

Registry 中的 Devin provider 曾要求机器上全局安装 `devin` 命令，因此全新安装的 Lody 虽然
可以配置该 provider，却无法启动它。现在 Devin 保留 ACP registry 提供的官方 binary
distribution，并复用 Lody 现有的 registry 下载、缓存和 setup 进度流程。这使六个受支持平台
目标重新具备零安装启动能力；如需使用用户自行管理的 Devin 版本，仍可通过 Custom ACP 配置。

## 决策

本决策部分取代[Devin 改用用户本地 CLI](../simplification/2026-09-16-devin-local-runtime.zh.md)
中的启动方式选择。从 `LOCAL_REGISTRY_AGENTS` 删除 Devin 后，生成器不再丢弃其上游
distribution。生成的 catalog 会将 Devin 分类为 `binary`，产品中已有的下列流程会随之生效：

1. Provider setup 在探测 Devin 前，检查选定机器并安装 archive。
2. 会话启动时异步解析缓存的 executable；如果 setup 尚未安装，则按需下载。
3. Binary manager 合并并发安装，仅发布完整解压的结果，并明确报告不支持的平台。

本次没有新增“本地优先”的回退逻辑。在选择 distribution 前解析 GUI 进程最终使用的 login-shell
`PATH`，会引入第二套启动策略，并让 provider setup 依赖机器环境的隐式状态。Custom ACP 已经
提供了显式指定用户自管 executable 的入口。

## 证据

- 改动时，ACP registry 为 Darwin、Linux 和 Windows 的两种受支持 CPU 架构发布了 Devin
  binary。
- 生成的 catalog 包含这六个平台目标，且不再包含 Devin local launcher。
- `agent-setting.test.ts` 断言同步 local 解析会拒绝 Devin，并保留所有 binary 目标。

## 验证

- `agent-setting.test.ts` 与 `acp-binary-manager.test.ts`：52 个测试通过。
- Registry 生成器测试：3 个测试通过。
- Shared 与 CLI 类型检查通过。
- 文档检查和局部格式检查通过。
- 对六个固定 Devin archive 的 HTTP HEAD 请求均返回 200。

本次未运行真实的 Devin 登录或已认证 ACP 会话。
