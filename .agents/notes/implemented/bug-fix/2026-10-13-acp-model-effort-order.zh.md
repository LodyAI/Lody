# 在选择模型后应用 ACP 模型相关选项

Status: implemented
Translation: current

[English](2026-10-13-acp-model-effort-order.md)

## 摘要

Agent Role 配置了 Max，但如果先应用 Effort、后应用模型，Worker 仍可能以 Low 启动。Lody 优先应用顶层模型字段，却按字典枚举顺序应用选项字典中的模型字段。共享会话配置应用器现在统一解析两种表示，按模式、模型、其他相关选项的顺序应用。合成状态测试复现了顺序错误；未能验证报告中的实际 Worker 及其安装的 OpenCode 版本。

## 原因与决策

Registry/custom Agent 在 `packages/components/src/components/shared/acp-selector-options.ts`
中使用通用配置选择器。因此 Role 表单把模型和 Effort 一起保存在
`runConfig.configOptionValues`，MCP 创建 Role 会话时保留该配置。
旧版 `applyAcpSessionRunConfig` 直接枚举字典：Effort 在模型之前时，成功的模型切换
可能清除刚设置的 Effort，而两次请求均不报错。这取决于字段顺序，不是时序竞态。
顶层 `modelId` 则走另一条顺序正确的路径。

这一风险存在于共享的 registry/custom ACP 路径，并非 OpenCode 专属。
当模式或模型变更重置相关控制项，或选项仅被目标模型支持时，问题才会显现。
内置 Agent 的 Role 选择器使用顶层模型字段，避开了这条字典顺序路径；但调用方若通过
配置选项传入其模型，仍可触发。本次修复对所有 provider 的两种表示均生效。
这不代表所有 provider 都会重置 Effort，也不覆盖 provider 内部的配置错误。

OpenCode 的[配置源码](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/acp/config-option.ts)
根据当前模型的 variants 构造 Effort 选项。`selectVariant` 保留有效的 variant，
否则优先选择目录中的 `default`，不存在时选择第一个 variant。所以回退值并非总是 Low，
而取决于模型目录。[ACP 文档](https://dev.opencode.ai/v2/docs/cli/acp/#config-options)
也明确说明 Effort 依赖模型。上述上游链接是可变分支及文档，不能证明受影响安装的版本。

依据代理声明的 category 定位模式及模型字段，并保留原有字段名回退规则。
顶层选择继续优先，先应用模式、再应用模型，随后应用其他选项，跳过字典中的重复字段。
这也覆盖模式切换会改变模型的情况。保留拒绝诊断、模型警告、已确认的运行状态和取消检查。
字典中的模式拒绝现在采用与顶层模式相同的既有警告策略。
不重排保存的 Role，也不只在编辑器中约定顺序：存储及传输字典的顺序不应成为执行协议。
预准备、前台执行和恢复路径共用此应用器。这补充了
[启动模型决策](2026-10-09-codex-resume-model.zh.md)：忽略启动元数据的 Agent 仍需要运行时应用。

底层请求仍由 Promise 接口的 AgentClient 管理。Effect 迁移将涉及尚未完成的 Lody
依赖，且不能直接帮助解决本次顺序错误，因此不纳入此次修改。
每次请求完成后、后续状态变更前继续检查取消；本修改不声称可以取消原始 ACP I/O。

## 验证与限制

原有测试套件覆盖不同字典顺序、顶层与字典混合选择、仅目标模型支持的 Effort、
优先级、拒绝和取消。测试断言代理最终状态及确认后的运行配置，而非仅检查调用次数。
修复前最初三个顺序用例失败；修复后，配置应用、AgentClient 预准备和运行配置套件的 42 项测试全部通过。
验证复用已有检出的已安装依赖，未修改锁文件。完整 CLI 类型检查受未初始化的 ACP
子模块及该安装中不匹配的 shared 依赖声明阻塞。文档检查报告了已有的未初始化子模块链接。
未发送真实推理请求、部署修改或更改保存的 Role。提交前尝试了根目录
`pnpm check` 和 `pnpm format`，但因该工作树缺少已安装的 `tsgo`/`oxfmt`
可执行文件而停止。复用已有安装运行的定向 Oxfmt 检查通过。
