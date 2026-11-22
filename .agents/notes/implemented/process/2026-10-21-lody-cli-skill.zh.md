# Lody 用户指南与 CLI 操作技能

Status: implemented
Translation: current

[English](2026-10-21-lody-cli-skill.md)

## 摘要

用户与 Agent 需要两类不同的 Lody 指引：覆盖界面入口、应用内直达深链与源码查证路径的产品参考，以及补充 `--help` 未涵盖的运行时前提、认证恢复与重试规则的 `lody` CLI 操作约定。两份面向外部用户的技能统一存放在独立的 `LodyAI/skills` 仓库，并以根目录 `skills` 子模块挂载到主仓，暂不内置进 MCP 技能服务，使 `skills.sh` 分发独立于 CLI 发版，同时通过 `.agents/skills` 软链接保留仓内发现能力。`lody` 通过五份按需参考、实时 `lody_help`/`--help`/`llms.txt` 自省及 `LodyAI/Lody` 规格与源码地图分层回答产品问题；`lody-cli` 负责安全登录、工作上下文与需人工确认的命令。技能文档与引用路径已完成静态核验，跨外部宿主的端到端自动触发尚未实测。

## 决策

- 面向外部用户的可安装技能统一由 `LodyAI/skills` 承载，并在主仓根目录挂载为 `skills` Git 子模块（正本位于 `skills/skills/lody/SKILL.md` 与 `skills/skills/lody-cli/SKILL.md`）。`.agents/skills/lody`、`.agents/skills/lody-cli` 与 `.claude/skills/lody-cli` 通过符号链接指向子模块内部，保持仓内技能发现不变，且暂不将 `lody` 打包进内置 MCP 技能服务。
- 按职责拆分而非合并成单一巨型文档：`lody` 负责产品概念、应用内直达深链、界面/快捷键/预览/Role/MCP/E2EE 指引、故障排查以及 `LodyAI/Lody` 源码定位地图（`references/*.md`），涉及纯 CLI 调用细节时交由 `lody-cli`，涉及后台条件脚本编写时交由内置 `lody-automations`。
- `lody-cli` 面向全局安装 `lody` 或使用 `npx lody` 的外部用户与 Agent，只描述 CLI 产品行为，不涉及内部通信或构建步骤；`lody` 则在专门的源码寻址章节中提供 `LodyAI/Lody` 下 `specs/`、`.agents/docs/`、`locales/`、`packages/` 与 `apps/` 的权威阅读顺序，并明确说明开源客户端与闭源云端后端的仓库边界。
- 只覆盖登录后的云端产品功能。开源本地版和 `migrate --from-oss` 导入不写入技能，正文开头明确这一范围，避免 Agent 将云端登录前提套用到本地版。
- 登录指引对 Agent 安全：不在 Agent 里直接运行裸 `lody login`；由用户在终端运行，或由用户通过受控的密钥渠道提供 CLI API key 后使用 `--auth`。技能用只读命令探测认证，并区分 Lody token 失效与模型提供方凭据错误。
- 派发流程列出三种工作上下文（父会话、已注册的本地项目、GitHub 仓库），并记录 `--machine`、`--agent-config`、`--parent`、`--worktree`、`--branch` 的默认值与互斥关系。
- 技能只写帮助里没有的内容：版本范围与运行时前提、选择器与分页约定、幂等键、来自 `packages/shared/src/schedule-control.ts` 的严格调度草稿格式，以及执行前需确认的命令。面向用户的参考仍是 site-docs 的 CLI 页面。全文照搬会形成第二份逐渐失准的参考。
- 恢复指引区分 Lody 凭据、浏览器授权、网络故障和模型提供方认证。连接故障时保留凭据，重试 create/chat 前先确认原请求是否已接受；回合结束后仍需核对回复是否满足用户目标。
- 已否决的方案：从帮助输出自动生成技能。这样得到的内容不会比 `--help` 多。

## 证据与局限

- 命令树和参数来自 2026-10-21 对 cloud 组合 `dist-dev` 构建递归执行 `--help` 的结果。技能中提到的 86 个参数已用脚本逐一与该输出核对，并用一个故意编造的参数做反向对照，确认能被检出。发布在 npm 的 `0.107.2` 帮助早于 `--mcp-server-ids`；技能把该参数标为随版本而异。
- 运行时相关结论来自阅读源码：`project` 走本地项目 IPC；`refresh-capabilities` 需要守护进程；`schedule` 在 local 平台经守护进程 IPC 执行，在 cloud 构建中直接写入工作区副本；`operation list` 读取当前机器的 SQLite 存储。另外，`session create/chat/cancel` 仅在目标机器是当前机器时需要本地运行时；远程目标只要求目标在线。
- 登录行为已在隔离 HOME 下用发布版 CLI 实测：裸 `lody login` 经管道运行 15 秒没有任何输出，而同一命令在 PTY 下会打印设备授权 URL 并开始轮询。恢复指引还对照了 `apps/cli/src` 下的 `commands/login.ts`、`lib/auth.ts`、`commands/daemon.ts`，以及 `commands/session.ts` 的派发和等待路径。这是定点登录检查，不是端到端恢复测试。
- 尚未在真实工作区中派发命令。local 平台的帮助树没有单独导出；`migrate` 仅存在于 cloud 版本，这一点依据的是 `apps/cli/src/index.ts`。
- CLI 参数变化时需要手动更新本技能，目前没有自动检查。
