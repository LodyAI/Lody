# 从机器自有配置解析导入的自定义会话启动参数

Status: proposed
Translation: current
PR: https://github.com/LodyAI/Lody/pull/689

[English](2026-09-14-imported-custom-session-launch.md)

## 摘要

导入的自定义 ACP 会话保留了 provider 身份，但没有保留最初启动 provider 的 agent 配置 ID。因此，即使同一台机器仍有且仅有一个匹配配置，会话恢复也无法取回自定义命令。解决方案是从已经打开的目标机器 Flock 中解析唯一匹配；若零个或多个配置匹配，则保持未解析状态，避免任意选择可执行程序。

## 问题

外部历史导入会创建一个带有 `cliType`、`agentType` 和 `externalHistory`，但没有 `agentConfigId` 的本地会话。Builtin 和 registry provider 可以从静态 provider 元数据重建可执行程序；custom provider 则需要机器自有的 `customAcp`、环境变量和 runtime override。当前启动解析器在缺少 ID 时直接返回，不会读取任何 agent 配置，因此打开导入会话时，恢复流程拿不到自定义命令并报 `session_restore_failed`。

历史同步在 daemon 中以目标机器为授权边界解析启动配置。会话恢复也必须保持该边界：导入元数据和 control-plane 调用方都不能提供可执行程序路径。

## 决策

当外部导入的会话没有 `agentConfigId` 且 `cliType` 为 `custom` 时，扫描已经打开的目标机器 Flock 中的 `agentConfig` family，并用会话的 `cliType` 与 `agentType` 匹配：

- 恰好一个匹配时，使用其当前 `customAcp`、环境变量与 runtime override；
- 没有匹配时，保留既有的未解析结果；
- 多个匹配时视为有歧义，同样保持未解析；
- 非导入会话、带明确 ID 的会话、builtin 与 registry provider，以及旧的逐会话字段继续沿用现有解析路径。

该方案有意读取当前机器配置，因此修改自定义命令后，后续恢复会直接使用新值，无需改写导入会话元数据。同时无需给会话或 control-plane schema 增加可执行程序字段。

## 验证

定向 resolver 测试覆盖唯一匹配、当前命令更新、无匹配、歧义、非导入会话的旧字段保留，以及既有的明确 ID 行为。测试没有启动真实的第三方 custom ACP 进程。
