# 扩展围绕持久化用户旅程的桌面 E2E

Status: implemented
Translation: current

[English](2026-09-08-desktop-e2e-user-journeys.md)

## 摘要

桌面回归套件此前覆盖首次启动和三种资源生命周期，但常用的目录、元数据和分叉流程仍停留在
组件或 Node 测试边界。本次实现了五条旅程，并在真实 Electron renderer、IPC 图和 bundled
CLI 上执行。Agent Role、workspace MCP 选择、Session 管理、本地项目移除和 Session 分叉
均已成为 active。分叉旅程当前会在 worktree commit 阶段暴露已知产品缺陷，并保持可执行，
用于为另行提交的修复提供回归门禁。

## 决定与范围

- 将 `LODY-MCP-001`、`LODY-ROLE-001` 和 `LODY-SESSION-002` 从有证据的
  backlog 提升为 active，并新增 active P1 `LODY-PROJECT-001`。
- 将 `LODY-FORK-001` 激活为 P1 覆盖。真实桌面运行创建 worktree 和目标 ACP runtime 后，
  第二次写入 `forkOperation` LoroMap 时会出现 `Map value must be an object`；产品修复仍由
  独立改动处理。
- 交互策略放在 Page Object 中，断言使用可观察的持久状态或进程证据；Gherkin 只描述用户结果。
- runtime-none 的 Session 旅程通过 renderer 的真实持久化 workspace repo 注入数据，
  不启动 ACP provider，同时保留生产数据路径。
- 项目旅程复用已有合成 Git fixture。
- MCP SDK 只加入 E2E 开发依赖。scripted ACP 用 stdio transport 启动配置中的合成 MCP
  server，并随 Session 关闭，因此进程清理来自实测，而不是从配置转发推断。

## 证据与限制

套件检查器确认 9 条 active 场景都与 registry 对应且 stable ID 唯一。激活分叉旅程之前，
三轮全新的 focused 真实桌面运行均通过 4 条新增 active 旅程和全部 37 个步骤；对应的完整
active 回归通过 8 个场景和 62 个步骤。当前分叉运行会到达异步 commit，并在 teardown 前
保留 trace、CLI backlog、截图和进程快照；在独立产品修复落地前，该旅程预期失败。fixture
使用显式文件信号、进程证据、持久目录读取和
Playwright polling，不增加 wall-clock sleep 或实时外部 provider 依赖。
