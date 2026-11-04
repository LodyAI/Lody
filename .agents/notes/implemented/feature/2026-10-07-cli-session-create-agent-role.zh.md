# CLI session create --agent-role

Status: implemented
Translation: current

[English](2026-10-07-cli-session-create-agent-role.md)

## 摘要

`lody session create` 此前无法选择工作区 Agent Role，CLI 用户只能手动拼装
machine、代理配置和运行配置，而 MCP 创建工具早已能按 Role id 解析这些字段。
该命令现在支持 `--agent-role <idOrName>`，并复用与 MCP 完全一致的解析逻辑：
Role 行是 machine、代理配置、运行配置和 Prompt 前缀的唯一权威来源，手填的
覆盖参数被忽略并输出 stderr 警告，id/revision/snapshot 作为创建溯源信息冻结。
共享解析逻辑从 MCP 服务端模块迁入 `apps/cli/src/lib/agent-role-create.ts`，
行为不变。Role 不存在时立即失败并列出候选；machine、配置、model 或 mode
不可用时仍由既有创建校验失败，与 MCP 语义一致。

## 决策与证据

[Issue #1282](https://github.com/LodyAI/Lody/issues/1282) 要求 CLI 支持 Role
选择器，解析结果与 MCP 一致。[创建合同](../../../../specs/session-orchestration.md#session-creation-configuration)
规定 Role 优先级；`apps/cli/src/mcp/AGENTS.md` 中的 MCP 规则要求 Role 存在时
在解析前移除手填 Machine/Agent/run-config 字段，`packages/shared/AGENTS.md`
要求创建时冻结 Role revision、Prompt、目标和派发配置。

MCP 服务端已有的三个函数——工作区目录读取、Prompt 前缀组合、向
`CreateOptions` 绑定溯源信息——原样迁入 `lib/agent-role-create.ts`（目录
sync 的 reason 字符串改为 `agent-role-catalog-read`）。CLI 在其上新增两个纯
函数：仿照 `selectUniqueAgentConfigByIdOrName` 的 id 或唯一名称选择器，以及
`resolveAgentRoleCreate`/`applyAgentRoleCreateTarget`——它们推导出与
`resolveMcpSessionCreate` 相同的 `{ ...role.runConfig, inheritSessionDefaults: false }`
派发配置和组合 Prompt，随后清空手填参数，使下游无法观察到被覆盖的值。创建
动作在 `withWorkspaceManager` 内、构建派发配置之前解析 Role；
`resolveCreateContext` 与能力校验保持不变，因此 machine 访问、在线检查和
mode/model 校验保持既有的快速失败行为。工作上下文参数（`--repo`、
`--local-project`、`--branch`、`--worktree`）和 `--parent` 不受影响。

已考虑并否决的替代方案：从命令层直接引用 MCP internals 对象（会形成与既有
方向相反的 commands→mcp 依赖），以及在 CLI 侧复制第二套解析逻辑（违反单一
合同规则并会与 MCP 漂移）。同样否决了在解析时额外检查
`resolveAgentRoleAvailability`：MCP 路径只检查目录中存在性，既有创建校验已经
能对离线/无权限 machine 和未公布的 mode/model 快速失败，额外的可用性检查会
成为第二套相互偏离的策略。

## 验证

新增测试套件 `apps/cli/src/lib/agent-role-create.test.ts` 覆盖：选择器解析
（id 优先、唯一名称、歧义与未找到错误并附候选列表）、派发配置与 Prompt
推导、被忽略覆盖参数列表、通过 mock `LoroDocumentManager` 的目录加载、溯源
绑定，以及断言同一 Role fixture 下 CLI 解析结果与 `resolveMcpSessionCreate`
+ `buildMcpCreateOptions` 一致的平价测试。MCP 套件保持原有覆盖，仅更新了
sync reason 字符串。

[PR #1286](https://github.com/LodyAI/Lody/pull/1286) 合入当前 `main` 后，Role
解析、MCP 服务端和 session 命令三个套件共 149 个测试全部通过。冲突解决保留
主分支对旧 Review agent 的移除及 CLI 参考文档链接迁移，同时保留 Role 参数。
合并后的命令继续使用当前附件准备与冻结输入创建流程。

类型检查、lint、边界检查、格式化和文档检查均通过。全仓检查遇到两项与改动
无关的主机环境失败：worktree 查询测试中的 macOS `/var` 与 `/private/var`
路径别名，以及原生 Git 传输测试中的会话凭据包装器。规范化临时目录，并从
测试进程移除该包装器后，两个套件的 25 个测试全部通过。

未验证：对真实工作区端到端执行 `lody session create --agent-role`（该命令
没有 commander 级测试设施，与其他创建参数一样只有单元测试覆盖）。

实现：[共享解析](../../../../apps/cli/src/lib/agent-role-create.ts)、
[CLI 创建边界](../../../../apps/cli/src/commands/session.ts)、
[MCP 服务端](../../../../apps/cli/src/mcp/lody-mcp-server.ts)、
[回归套件](../../../../apps/cli/src/lib/agent-role-create.test.ts)。
相关：[MCP 跨机器 Role](../bug-fix/2026-09-28-mcp-cross-machine-agent-role.md)、
[显式 MCP 创建配置](2026-10-02-mcp-create-run-config.md)。
