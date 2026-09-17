# 内置 Pi Provider

Status: draft
Translation: current

[English](builtin-pi.md)

用户可以选择内置 Pi Provider。Lody 下载带校验和的运行时，其中包含固定版本的
公开 ACP 适配器及锁定的官方 Pi 依赖。适配器是独立 submodule，不进入桌面依赖图。
Windows 原生模块必须来自同一提交的成功构建。凭据继续由执行机器或已有 Provider
环境变量管理。

Registry 生成时排除 `pi-acp`，不再提供新建入口。已有 registry Provider 在其所有者
明确确认 chat landing 卡片之前仍可启动。同一机器存在旧 Pi Provider 时，启动不得自动
创建 builtin Pi；确认迁移后复用相同 ID 的 builtin 行。
daemon 仅在 Node 版本和平台满足固定运行时要求时
声明 `builtinPi`，不兼容的机器不得允许迁移。迁移要求目标 daemon 声明 `builtinPi` v1，
在原 Provider 行上改为 `builtin/pi`，保留 ID、机器、名称、环境、提示词及其他字段。
已删除或已切换类型的行不会被恢复或覆盖。部分失败可以重试，已完成的行不会重复迁移。

这是 Provider 迁移，不是原生会话转换。新适配器接受 Pi 原生 JSONL 路径，不能恢复
旧 `pi-acp` ID。确认卡片要求升级后新建对话，已有对话历史不被改写。

## 实现依据

- `packages/shared/src/pi-provider-migration.ts`
- `packages/components/src/components/chat/pi-provider-migration-card.tsx`
- `apps/cli/src/agent/setting.ts`
- `scripts/package-pi-runtime.mjs`
