# Lody MCP 操作工具与 Session PR 关联引导

Status: implemented
Translation: current

[English](2026-11-21-mcp-action-tools.md)

## 摘要

Lody 启动的每个 Agent 都会加载完整的 Lody MCP 工具列表，不延迟加载 schema 的客户端每一轮都要付出这个成本。在合并单条/批量、读取/列表成对工具（40 个减到 30 个）之后，owner 批准把低频工具族改为操作工具：预先公开的 schema 只有 `action` 枚举和 `arguments` 对象，各操作的细节由 `lody_help` 提供。结果是 21 个工具、27,769 字节。读取保留在只读工具中，因此比设计估计的约 19 个多出两个工具。同一改动为 Agent 提供只作用于自身 Session 的 `pr_link` / `pr_unlink` / `pr_list`，并在 git 工作目录中加入一句 owner 批准的提示，措辞取决于 Session 的托管 `gh` shim 是否已会关联 PR。Agent 是否遵循这句提示、读取操作帮助是否与完整 schema 一样可靠，均未测量。

## 决定

- **操作工具。** `lody_session_manage`（rename、archive、share、`pr_link`、`pr_unlink`、`pr_list`）、`lody_schedule`（propose、pause）、`lody_agent_role`（create、update）、`lody_operation`（get、batch、list）和 `lody_catalog`（machines、projects、mcp_servers、agent_configs、agent_roles、schedules）。每个操作沿用原有 schema 校验 `arguments`。高频工具保留完整的预先 schema。
- **读取保持可自动批准。** 客户端可能自动批准标注 `readOnlyHint` 的工具，而一个工具的标注覆盖它的所有操作。若把 Role 和 Schedule 的读取并入其写入工具族，或把 cancel 并入 `lody_operation`，这些读取就会失去该标注。因此读取放在 `lody_catalog` 和 `lody_operation`（均为只读），`lody_operation_cancel` 保持独立。`pr_list` 是唯一位于可写工具中的读取。`lody_mcp_configure` 作为执行与凭据边界保持独立。
- **执行位置。** `share` 和 catalog 的 `schedules` 与原工具一样，在收到调用的 MCP 进程中执行（`executeLocally`）。daemon 拒绝经 IPC 执行它们。其余操作都走 daemon Session 工具路由。
- **PR 关联。** `pr_*` 只作用于从 MCP 会话上下文解析出的调用方 Session，任何参数都无法指定其他 Session。它们以来源 `agent` 调用 `lib/session-pr-links.ts`（[显式关联](2026-11-21-session-explicit-pr-links.zh.md)）。
- **常设引导，每个位置一句（owner 于 2026-11-21 批准，仅当工作目录含 git）。**
  - 每次提示中的 Lody 工具提醒，每个 Session 一句。owner 于 2026-11-21 批准了两种措辞：
    - Session 的 PATH 上有托管 `gh` shim 时，`gh pr create` 已会关联其 PR，因此 `LODY_PR_LINK_GUIDANCE` 覆盖其他途径：“A pull or merge request this Session opened without gh pr create is linked to it with lody_session_manage action pr_link.”
    - 没有 shim 时（使用原生凭据的本地项目），`gh pr create` 不会关联任何 PR，因此 `LODY_PR_LINK_GUIDANCE_WITHOUT_GH_SHIM` 覆盖所有 PR：“A pull or merge request this Session opens is linked to it with lody_session_manage action pr_link.”
  - 选择哪种措辞，依据与把 shim 放上 PATH 相同的事实，即托管 broker 凭据（`session.getGitHubCredentials().mode === 'managed'`），而不是项目类型。当项目是 GitHub 项目，或工作目录包含 `.git`（通过 stat 判断，不启动 git 进程）时才加入这句。两个常量都在 `apps/cli/src/mcp/tool-help.ts`。
  - `gh` shim 的“未关联”stderr 行写明 `lody_session_manage` 的 `pr_link` 操作。

## 备选方案

- 把低频能力移到 `lody` CLI：owner 已否决，因为 lody-cli skill 不会注入 Lody 启动的 Agent。
- 动态工具列表和搜索/执行元工具在合并阶段已被否决：部分客户端忽略列表变更，变化的列表会破坏提示缓存，单个执行工具会丢失逐工具的权限和标注。
- 完全按最初设计合并所有工具族（约 19 个工具）：因上述只读代价未采用。

## 测量

在 Linux 上通过内存 MCP 客户端读取 `buildLodyMcpServer()` 的工具列表；该平台不提供 iOS 预览。

| 版本 | 工具数 | `tools/list` 字节 |
| --- | --- | --- |
| main 0f24fb82c | 40 | 51,355 |
| 合并成对工具（#3022） | 30 | 35,596 |
| 操作工具 | 21 | 27,769 |

## 验证

- `apps/cli/src/mcp/tool-help.test.ts`：精简的预先 schema、逐操作帮助以及对实际参数的校验。
- `apps/cli/src/mcp/lody-mcp-server.test.ts`：精确的工具名称和只读集合。
- `apps/cli/src/mcp/daemon-session-tools.test.ts`：`pr_link`、`pr_list`、`pr_unlink` 以 agent 记录作用于调用方 Session；`share` 从不经 IPC 执行。
- `apps/cli/tests/session-execution-helpers.test.ts`（两种措辞各一例，无 git 时不加）和 `apps/cli/tests/gh-shim-script.test.ts`（stderr 行）。
- 未验证：Agent 在真实提供方会话中的遵循情况。
