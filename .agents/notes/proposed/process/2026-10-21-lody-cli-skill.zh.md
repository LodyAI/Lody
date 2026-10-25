# Lody CLI 操作技能

Status: proposed
Translation: current

[English](2026-10-21-lody-cli-skill.md)

## 摘要

在 Lody 会话中运行的 Agent 会调用 `lody` CLI。但仅靠内置帮助，它们无从得知各命令需要哪种运行时、`LODY_SESSION_ID` 何时作为回退值、调度草稿的格式，以及登录和派发失败时如何恢复，只能靠猜。新增的 `lody-cli` 技能把这些约定集中记录在一处，补充用户需求到命令的映射、认证失败和派发结果不确定时的恢复流程，并标出需要人工确认的命令。登录指引明确禁止 Agent 直接运行裸 `lody login`：它会等待浏览器授权，且 stdout 不是终端时可能没有可见输出；应让用户在终端运行，或使用 `--auth`。精确的参数仍以 `--help` 为准；目前核对了命令树，并对登录做了 PTY/非 TTY 的定点验证，尚未在真实工作区派发会话。

## 决策

- 正本位于 `.agents/skills/lody-cli/SKILL.md`，并由 `.claude/skills/lody-cli` 链接，与仓库内其他技能布局一致。
- 面向外部：全局安装 `lody` 或用 `npx lody` 的用户，由 Lody 会话内的 Agent 或外部编码 Agent 调用。技能只描述产品行为，不写源码路径、内部通信方式或构建步骤；维护者需要的证据留在本记录里。
- 只覆盖登录后的云端产品功能。开源本地版和 `migrate --from-oss` 导入不写入技能，正文开头明确这一范围，避免 Agent 将云端登录前提套用到本地版。
- 登录指引对 Agent 安全：不在 Agent 里直接运行裸 `lody login`；由用户在终端运行，或由用户通过受控的密钥渠道提供 CLI API key 后使用 `--auth`。技能用只读命令探测认证，并区分 Lody token 失效与模型提供方凭据错误。
- 派发流程列出三种工作上下文（父会话、已注册的本地项目、GitHub 仓库），并记录 `--machine`、`--agent-config`、`--parent`、`--worktree`、`--branch` 的默认值与互斥关系。
- 技能只写帮助里没有的内容：版本范围与运行时前提、选择器与分页约定、幂等键、来自 `packages/shared/src/schedule-control.ts` 的严格调度草稿格式，以及执行前需确认的命令。面向用户的参考仍是 site-docs 的 CLI 页面。全文照搬会形成第二份逐渐失准的参考。
- 恢复指引区分 Lody 凭据、浏览器授权、网络故障和模型提供方认证。连接故障时保留凭据，重试 create/chat 前先确认原请求是否已接受；回合结束后仍需核对回复是否满足用户目标。
- 已否决的方案：从帮助输出自动生成技能。这样得到的内容不会比 `--help` 多。

## 证据与局限

- 命令树和参数来自 2026-10-21 对 cloud 组合 `dist-dev` 构建递归执行 `--help` 的结果。技能中提到的 86 个参数已用脚本逐一与该输出核对，并用一个故意编造的参数做反向对照，确认能被检出。发布在 npm 的 `0.107.2` 帮助早于 `--mcp-server-ids`；技能把该参数标为随版本而异。
- 运行时相关结论来自阅读源码：`project` 走本地项目 IPC；`refresh-capabilities` 需要守护进程；`schedule` 在 local 平台经守护进程 IPC 执行，在 cloud 构建中直接写入工作区副本；`operation list` 读取本机的 SQLite 存储。另外，`session create/chat/cancel` 仅在目标机器是本机时需要本地运行时；远程目标只要求目标在线。
- 登录行为已在隔离 HOME 下用发布版 CLI 实测：裸 `lody login` 经管道运行 15 秒没有任何输出，而同一命令在 PTY 下会打印设备授权 URL 并开始轮询。恢复指引还对照了 `apps/cli/src` 下的 `commands/login.ts`、`lib/auth.ts`、`commands/daemon.ts`，以及 `commands/session.ts` 的派发和等待路径。这是定点登录检查，不是端到端恢复测试。
- 尚未在真实工作区中派发命令。local 平台的帮助树没有单独导出；`migrate` 仅存在于 cloud 版本，这一点依据的是 `apps/cli/src/index.ts`。
- CLI 参数变化时需要手动更新本技能，目前没有自动检查。
