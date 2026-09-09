# Codex ACP 的 Worktree 项目归属缺口

Status: proposed
Translation: pending

## 摘要

当前 Lody 能保存自身的项目引用、Worktree 状态和 ACP 会话 ID，但创建 Codex
会话时只传执行目录，未传独立的项目归属。Codex 0.153.4 已提供项目表和实验性的
项目关联接口；隔离验证确认，同一 Worktree 的线程可以保留实际执行目录并关联到
另一个项目根目录。适配器的历史列表仍按执行目录过滤，因此原始项目路径查询不能
覆盖其 Worktree 对话。建议通过 Core 定义显式项目上下文，再由 Codex 适配器映射到
原生项目 API；这是调查结论和待评审方案，尚未改变运行时或迁移现有会话。

## 范围与证据

后续的[本地项目归属实现](../../implemented/bug-fix/2026-09-08-local-project-acp-identity.zh.md)
已覆盖此次提案的会话建立和补归属部分；下文保存调查时的基线，项目级历史查询
和桌面 Worktree 展示仍属于待验证提案。

- Lody 检查基线：`c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29`。
- Codex 适配器子模块：`9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f`，包版本 1.10.0。
- Lody 锁定的 Codex 原生运行时：0.153.4；Core 子模块：`7bc6332d3f007876895b4a3a827be0060f4d5318`。
- 检查了当前会话的本地元数据，未将真实对话、机器路径、线程 ID 或日志写入仓库。
- 当前 Specs 和活动 Notes 未找到已有的 Codex 项目归属契约；本提案不代表已获批准的新保证。

## 保存链路

Lody 的 `ProjectRef` 区分 GitHub 仓库和本地项目；本地项目有 `localProjectId`、
`useWorktree`，`LocalProjectMeta.rootPath` 保存项目根目录。会话自身还保存
`isWorktree` 和 `acpSessionId`。本地 Worktree 创建逻辑掌握 `originalRootPath`，
但 `Session.createAgent` 到 `createAcpClient` 的参数只有实际 `workdir`。

`AgentClient.getSessionStartMeta` 目前传递会话配置和 fork 边界，没有项目或
Worktree 上下文。`CodexAcpClient.newSession` 把 ACP `cwd` 原样交给
`thread/start`；`loadSession`、`resumeSession` 和 `SessionFork` 同样只提供实际
目录及各自的会话操作参数。ACP 的会话 ID 对应 Codex 的 thread ID。

Codex 使用 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` 保存 rollout，
包括 `session_meta`、`turn_context`、`response_item`、`event_msg` 等记录。
0.153.4 的 `state_5.sqlite` 保存线程索引，以及 `projects`、`project_roots` 和
`threads.project_id`；分页历史还使用 `thread_history_1.sqlite` 的
`thread_turns`、`thread_items` 等表。这里描述的是观测到的内部布局，不应作为
客户端直接写数据库的契约。

当前 ACP 会话的观测结果是：`cwd` 为 Worktree 路径，Git 元数据包含提交、分支和
远端 URL，`originator` 为适配器，`source` 为 `vscode`，`project_id` 为空。
`source` 描述客户端来源，不能当作 Worktree 标志。JSONL 的 Git 元数据也不表达
原始项目路径。隔离样本中显式分配的项目关联存于状态库，不能假设仅复制 rollout
就能恢复完整项目归组。

## 原生能力与适配器缺口

从实际 0.153.4 二进制执行下列命令取得协议，避免根据旧版桌面状态推断：

```sh
codex app-server generate-json-schema --experimental --out /tmp/codex-project-schema
```

实验协议具有以下能力：

| API | 相关语义 |
| --- | --- |
| `project/create` | `idempotencyKey`、`name`、`roots: [{path}]` 创建独立项目 |
| `project/list` / `project/read` | 查询原生项目和根目录 |
| `thread/start.projectId` | 新线程的持久项目归属，独立于 `cwd` |
| `thread/metadata/update.projectId` | 将已有落盘线程分配给现有项目 |
| `thread/list.projectId` | 按项目查询，独立于精确匹配的 `cwd` 过滤 |

适配器 `package.json` 的 `generate-types` 没有 `--experimental`，所以提交的
`ThreadStartParams` 和 `ThreadMetadataUpdateParams` 缺少这些字段，ClientRequest
也缺少项目方法。初始化已经设置 `experimentalApi: true`，但没有消费对应能力。
`Thread.projectId` 虽已出现在返回类型中，却未在 ACP 会话列表里返回；
`project/changed` 和 `thread/project/updated` 也被忽略。

`CodexAcpClient.listSessions` 向 `thread/list` 传绝对 `cwd`，随后再次比较目录，
只返回 ID、cwd、标题和更新时间。这是按执行目录列历史的行为；若要按逻辑项目
覆盖关联 Worktree，应定义额外查询语义，不能悄悄扩大标准 cwd 过滤。

`createSessionConfig` 的 `projects[path].trust_level = "trusted"` 是配置层的目录
信任设置，不是创建项目记录。`additionalDirectories` 和 `runtimeWorkspaceRoots`
表达工作目录/访问范围，也不能替代项目归属。

## 验证与限制

使用临时 `CODEX_HOME`、合成 Git 仓库和关联 Worktree，直接连接锁定版本的
app-server，未使用真实账户凭证，也未修改用户的 Codex 数据：

1. 创建根目录为源 checkout 的项目；相同 Worktree 分别创建 cwd-only 和显式
   projectId 线程，返回结果分别为 null 和预期项目 ID。
2. 用合成 `thread/inject_items` 使线程落盘，再 unsubscribe；状态库保留实际
   Worktree cwd 和显式项目 ID。
3. 对 cwd-only 的已落盘线程调用 `thread/metadata/update`，随后 `thread/read`
   和只读 SQL 均确认项目归属成功。
4. 空线程刚完成 start 时还可能没有 rollout，元数据更新会报 no rollout found；
   历史补归属必须针对已经持久化的线程。

注入项目不是正常用户回合，样本的 `has_user_event` 为 0，列表查询返回空；因此
未将该结果作为项目列表端到端验证。另一次针对本机不可达 mock provider 的合成
回合等待完成事件超时，测试进程已结束。未验证真实模型回合、桌面项目显示、
Worktree 徽标或 Handoff。cwd 列表遗漏的结论来自适配器实现和原生过滤 schema。

## 建议的责任划分

- Lody 在建立 new/load/resume/fork 会话时提供明确的逻辑项目根目录和 Worktree
  上下文，保留实际 cwd；共享扩展应由 `acp-extension-core` 定义并版本协商。
- Codex 适配器根据项目根目录解析或复用原生项目，通过项目 API 关联线程。
  要处理路径规范化、幂等创建、多进程并发、已有人为分配的项目以及旧运行时兼容。
- 新会话直接用 `thread/start.projectId`；恢复或历史补归属走受控元数据更新。
  fork 的项目继承行为需单独验证，不能假定改变 cwd 会自动改变归属。
- 项目级历史查询和返回元数据需要同步补齐，否则只修创建仍不能从源项目列出历史。
- `cwd` 继续指向 Worktree；不把原始目录加入写权限来模拟归组，不直接改 SQLite
  或桌面全局状态文件。

当前 GitHub Worktree 模式使用共享 bare 仓库，未必存在唯一的原始 checkout；
本地项目 Worktree 才明确持有 `originalRootPath`。Git common-dir 可以说明仓库
关系，但无法决定用户希望归属哪个项目，这个选择应由宿主明确提供。

[官方 Worktree 文档](https://learn.chatgpt.com/docs/environments/git-worktrees)
还区分 Codex 管理的临时 Worktree 和作为独立项目的永久 Worktree。项目归组不等于
Codex 接管 Worktree 创建、Handoff 或清理；Lody 的外部 Worktree 生命周期必须保留
在 Lody。若要让桌面显示完全相同的 Worktree 标志，仍需额外验证桌面识别契约。

## 实现入口

- [项目模型](../../../../packages/shared/src/project.ts)
- [Lody 会话创建](../../../../apps/cli/src/session/session.ts)
- [Lody Worktree 来源](../../../../apps/cli/src/session/session-manager.ts)
- [ACP 启动元数据](../../../../apps/cli/src/agent/agent-client.ts)
- [Codex 会话创建和列表](../../../../packages/acp-extension-codex/src/CodexAcpClient.ts)
- [Codex fork](../../../../packages/acp-extension-codex/src/SessionFork.ts)
- [Core 扩展归属原则](../../../../packages/acp-extension-core/README.md)
