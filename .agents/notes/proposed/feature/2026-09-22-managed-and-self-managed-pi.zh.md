# 托管与自管 Pi Provider 并存

Status: proposed
Translation: current

[English](2026-09-22-managed-and-self-managed-pi.md)

## 摘要

原有 Pi 迁移会原地替换旧 `pi-acp` Provider，同时改变其启动行为，并让既有会话继续
绑定到已经改变含义的 Provider 身份。本提案改为在用户选中的机器上新增独立的托管 Pi，
保留自管 Provider 及其会话绑定。稳定的托管 Provider ID 让重试保持幂等；不同 Pi
profile 仍由用户显式配置，不把它描述为自动隔离保证。

## 提议决策

将 landing 的迁移动作改为新增动作。仅当目标行不存在时，才在当前选中的机器上创建一个
`builtin/pi` 行；不更新旧 Provider，不复制其命令或环境变量，不切换当前 Provider，
也不改写 Session 元数据。只要旧 Provider 仍存在，启动时的自动注册就继续跳过 Pi，
因此新增托管 Pi 始终是用户的显式选择。

托管行使用每机器确定性 ID，并采用“仅在不存在时写入”。重复点击、结果不确定后的重试和
并发客户端都会收敛到同一行，且不会覆盖之后的用户编辑；已有的内置 Pi 配置优先保留。

对于已经丢失旧 Provider 的用户，Custom Provider 仍是恢复路径，并复用已有命令测试来
验证 ACP 入口。界面明确说明：自管 Pi 需要兼容 ACP 的适配器，普通 `pi` 命令不是 ACP 服务。

## 边界与取舍

Provider ID 隔离启动配置和 Session 绑定，但不隔离 Pi profile 目录。用户可以在其中一个
Provider 上设置 `PI_CODING_AGENT_DIR`；Lody 不移动凭据或配置文件，也不承诺文件系统隔离。
托管运行时仍无法恢复旧 `pi-acp` 的原生会话 ID。

本提案部分替代[托管 Pi ACP 与确认式 Provider 迁移](../../implemented/feature/2026-09-17-builtin-pi.zh.md)
中的原地迁移决策；运行时打包、能力协商和旧会话限制保持不变。

## 证据与验证计划

- Issue：[LodyAI/Lody#832](https://github.com/LodyAI/Lody/issues/832)
- 意图：[内置 Pi 草案 Spec](../../../../specs/builtin-pi.zh.md)
- 实现：`packages/shared/src/pi-provider-migration.ts`、
  `packages/components/src/atoms/agents.ts` 和
  `packages/components/src/components/chat/chat-landing.tsx`
- 验证 Provider 构造约定、仅在不存在时持久化、既有自动注册覆盖、组件类型检查、翻译和文档检查。
