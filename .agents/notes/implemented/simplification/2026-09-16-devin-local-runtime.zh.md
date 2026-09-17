# Devin 改用用户本地 CLI，不再下发托管 binary

Status: implemented
Translation: current

[English](2026-09-16-devin-local-runtime.md)

PR: https://github.com/LodyAI/Lody/pull/763

## 摘要

Devin 此前以 `binary` 分发的 registry agent 形式接入：Lody 会把固定版本的
Devin CLI 压缩包下载到 `acp-bin/` 并启动这份托管副本。现在它被加入受管理的
本地 agent 清单，Lody 直接从 PATH 启动用户自己的 `devin acp`（ACP spawn 环境
本来就前置了 `~/.local/bin`、`~/bin`、`~/.claude/local`）。这个取舍是有意为之：
会话运行的是用户自己安装和升级的 Devin 版本，但零安装路径不复存在——
机器上没有 `devin` 命令时会在 spawn 阶段失败，而不是自动下载 runtime。

## 决策与证据

`scripts/generate-acp-registry.mjs` 的 `LOCAL_REGISTRY_AGENTS` 新增 `devin`
条目（`command: 'devin'`、`args: ['acp']`、`versionArgs: ['--version']`），
重新生成的 `packages/shared/src/acp/registry-generated.ts` 把六个平台的
`static.devin.ai` 压缩包替换为 `local` 启动器。由于启动方式优先级是
`local > npx > uvx > binary`，调用方无需改动：同步 launch 解析器现在直接为
Devin 服务，`machine/acp-binary-*` 状态/安装流程返回 `not-applicable`（映射为
installed），agent 配置对话框也不再出现 Download 门槛。能力缓存键仍使用上游
registry 版本号（`devin@<version>`）。

曾考虑"优先 local、缺失时回退托管 binary"的混合方案，但最终选择与
cursor/goose/junie 一致的纯 local 语义；`local + binary` 混合分发需要为单个
agent 新增 PATH 探测与回退逻辑。没有安装 CLI 的用户仍可通过 Custom ACP
provider 指向任意 `devin acp` 命令。

## 验证

重新运行了 registry 生成脚本：内容 diff 只有 Devin 的分发方式替换和生成
时间戳，图标包无变化。`node --test scripts/generate-acp-registry.test.mjs`
通过（3 个用例）。此 worktree 未安装依赖，无法运行完整 `pnpm check`。
`devin` 缺失时的 spawn 行为（ENOENT 经 ACP 启动监控上报）沿用现有 local
agent 路径，未做端到端复测。
