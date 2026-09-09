# 本地项目 ACP 归属元数据

Status: implemented
Translation: pending

## 摘要

本地项目的 Worktree 对话此前只向 Codex 传递执行目录，原始项目归属在 ACP 边界
丢失。此次通过 Core 的版本化 `worktreeProject` 扩展传递原始根目录，由适配器
使用原生项目 API 保存线程归属，同时保留 Worktree 执行目录。实现覆盖创建、
load/resume 补归属、fork 和宿主能力协商，真实 Codex 0.153.4 的隔离验证已确认
保存结果。改动已进入关联草稿 PR，未发布；项目级历史查询和桌面 Worktree 生命周期
功能不属于此次实现。

## 问题与责任

初始[调查提案](../../proposed/architecture/2026-09-08-codex-worktree-project-persistence.zh.md)
区分了执行目录、项目归属和 Codex 管理的 Worktree。用户随后选择修复本地项目
归属；这份实现记录覆盖该范围，不替代提案中尚未实现的项目级历史查询。
[Spec](../../../../specs/local-project-acp-identity.zh.md) 仍为 draft。

- Core 定义 `LodyWorktreeProject` 及 `worktreeProject` v1 能力，元数据放在标准
  建立会话请求的 `_meta.lody.worktreeProject`，格式为
  `{ version: 1, originProjectPath: "/original/project" }`，不新增自定义 JSON-RPC 方法。
  发布前统一采用这一命名，不保留旧草案字段别名；项目映射和执行目录语义不变。
- Lody 按 `localProjectId` 从已有项目记录解析原始根目录。解析回调经 Session
  和 ACP runner 传到 AgentClient，在能力协商和最终目录 claim 后运行。
  预创建、子会话、恢复和替换会话均沿用这一分工；GitHub-only 不猜测本地根路径。
- Codex 适配器对原始根路径做 realpath，按原生项目 roots 查找或幂等创建项目，
  创建键由规范化根路径决定，避免每个 Worktree 各建一个项目。
- 新线程使用 `thread/start.projectId`；恢复仅填空归属，保留已有用户选择；
  fork 使用目标项目，更新目标线程，始终释放 fork 的临时订阅。

## 取舍和兼容

只有宣告 v1 能力的适配器收到本地项目元数据，旧适配器保留当前行为。适配器的
项目 API 基于锁定的 Codex 0.153.4 实验协议，使用与既有 background-terminal
API 一致的窄类型补充，不重生成整个实验协议树。旧 `CODEX_PATH` 覆盖可能不支持
原生接口，不能把失败伪装为已关联。

同一根目录匹配多个原生项目时显式报歧义，不任意覆盖某个项目。历史线程仅在
重开时补齐空归属，不批量扫描或迁移，也不覆盖既有用户项目选择。项目根元数据
不增加可信/可写目录，不改变 cwd，不触碰 SQLite 或桌面全局状态文件。

Core 和 Codex 的改动当前通过根工作区的 `acp-extension-core: workspace:*`
override 联合验证。对外发布时必须先发布包含新契约的 Core，再更新 Codex 的
独立 npm 依赖及 lockfile，再发布适配器。Lody 草稿引用两个子模块的 PR 提交；
当前没有进行包发布，也没有伪造未发布包的 lockfile 完整性信息。

关联草稿：[Lody #534](https://github.com/LodyAI/Lody/pull/534)、
[Core #6](https://github.com/LodyAI/acp-extension-core/pull/6)、
[Codex #35](https://github.com/LodyAI/acp-extension-codex/pull/35)。

## 验证

- Core build/typecheck、Codex 适配器 build/typecheck，以及全仓 `pnpm typecheck`
  通过。最初单独检查 CLI 时发现尚未构建 Claude 适配器；执行标准适配器准备流程
  后，全仓类型检查通过。
- Codex 精简后完整测试集：579 通过、27 跳过。ACP 协商和 new/load/resume/fork 请求验证
  检查最终 Worktree cwd 和原始根元数据同时存在；未宣告能力时不运行项目解析。
- 项目映射测试覆盖原生项目复用、目录别名、分页、并发幂等键、恢复保留用户选择、
  fork 只改子线程、无元数据兼容和无效/歧义元数据拒绝。
- 临时 Git 仓库和 Worktree、独立 CODEX_HOME、无用户凭据的真实 0.153.4 app-server
  验证，直接运行修改后的 CodexAcpClient。模型目录发现被离线替代，使用合成
  history item 使线程落盘；创建、恢复空归属、fork 三个线程均经只读 SQL 确认
  保留 Worktree cwd 且指向同一项目，项目总数为一。
- 未运行真实模型推理，未修改用户历史；未验证桌面徽标、Handoff 或项目级历史列表。

## 消融：2026-09-09

先创建关联 PR，再以 Codex 适配器提交 `55b48510` 为固定基线，每次只修改
`src/WorktreeProject.ts` 中一项实现并运行 13 项行为测试。每轮恢复基线，
最后组合通过的删减再测；禁用测试重试，避免把偶发通过当成证据。

```sh
./node_modules/.bin/vitest run --no-file-parallelism --retry=0 src/__tests__/CodexACPAgent/worktree-project.test.ts
```

| 变体 | 结果 | 决定 |
| --- | --- | --- |
| 原始基线 | 13 通过 | 对照 |
| 移除 pending Map 及其 get/set/finally，直接返回项目查找 | 13 通过 | 删除缓存 |
| 移除原生更新后的 thread.projectId 写回 | 13 通过 | 删除本地写回 |
| 跳过输入路径的 realpath | 1 失败：目录别名产生不同项目身份 | 保留 |
| 只查询第一页项目 | 1 失败：无法复用后续页的已登记项目 | 保留 |
| 去掉恢复时已有项目的保护条件 | 1 失败：尝试重写已有用户归属 | 保留 |
| 同时删除缓存和本地写回 | 13 通过 | 采用，模块从 98 行减为 87 行 |

缓存只合并同一适配器进程内的同时查询；原生确定性 idempotencyKey 才负责
跨进程项目身份。删除缓存可能增加同进程并发时的查询次数，未作性能收益声明。
原生更新成功后各调用者不依赖被改写的临时 Thread 对象：load 重新读取线程，
resume/fork 返回的会话元数据不使用该字段。

为避免只依赖 mock，精简前后分别运行独立 CODEX_HOME 下的真实 Codex 0.153.4：
同一解析器的两个并发调用及另一个解析器的调用均返回同一项目；随后创建、恢复
空归属及 fork 的三个落盘线程仍保留 Worktree cwd，并指向唯一项目。两组均通过，
使用合成 Git 仓库和注入的 history item，不读取用户历史、不发起模型推理。

全仓 `pnpm check` 通过，包括类型检查、lint、CI 测试和边界检查；初次沙箱运行
因 IPC socket 的 EPERM 中断，在允许本地 socket 的环境重跑通过。`pnpm format`
和文档检查也已执行，格式化产生的无关 Electron 测试改动已恢复。

## 入口

- [Core 协议](../../../../packages/acp-extension-core/README.md)
- [CLI 元数据生命周期](../../../../apps/cli/src/agent/README.md#local-project-identity)
- [Codex 项目解析](../../../../packages/acp-extension-codex/src/WorktreeProject.ts)
- [Codex 回归测试](../../../../packages/acp-extension-codex/src/__tests__/CodexACPAgent/worktree-project.test.ts)
