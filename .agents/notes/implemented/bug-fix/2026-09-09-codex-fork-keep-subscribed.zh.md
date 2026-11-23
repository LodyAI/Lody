# 让分叉后的 Codex 会话保持订阅

Status: implemented
Translation: current

[English](./2026-09-09-codex-fork-keep-subscribed.md)

## 摘要

Codex 分叉会立刻退订子 thread。宿主把这个子会话当活 Session，并等待 `turn/completed` 通知，于是第一句 prompt 永不结束，停止时报没有进行中的 turn，下一句变成 `already active`。这次宿主改动现将 `acp-extension-codex` 钉到已合并的 adapter #37（`e472d56`），成功 fork 后子会话保持订阅，并使用 `acp-extension-core` 0.1.2。冲突更新纳入已包含 #534 的 Lody main，并将所有 submodule 更新到各自当前 main 快照。Codex fork 测试通过；更新后的 DSH main 存在下文记录的 lint 错误，本次改动不发布桌面版本。

## 合并更新（2026-09-09）

下文的初始 pin 和合并顺序警告记录原始方案。adapter #37 现已作为 `e472d56` 合入 Codex main，之前已包含 worktree 归属修复（#35）和 review 完成事件夹具修正（#36）。PR [#544](https://github.com/LodyAI/Lody/pull/544) 合并了已包含 #534 的 Lody main，并选择最新 adapter main 解决 Codex gitlink 冲突。`SessionFork.ts` 与原修复提交 `fc91dce` 完全一致。按用户要求，所有 submodule 更新到各自当前 main，Core 仍为 `9c47fec`。本次更新不发布 adapter 或桌面版本。

其余更新后的 pin 为 Claude `414718e`、DSH `5d79d5b`、Grok `c962338` 和 Kimi `d3f218c`；Kimi 仍独立于根 workspace。冻结 lockfile 安装通过，根 lockfile 无需修改。更新后的 Codex adapter 通过 `session-fork.test.ts` 和 `CodexAcpClient.test.ts`，共 112 项测试。本次更新没有重复下文记录的真实 Codex 或桌面 UI 探针。

验证限制：根类型检查通过，但 `pnpm check` 在 DSH main 的 `scripts/settings-profile-smoke.mjs:39` 因 `typescript-eslint(no-floating-promises)` 中断。该 main 快照缺少旧宿主 pin 中的 `await test(...)`。保留用户要求的 main pin，本次宿主更新不修改或发布新的 DSH 提交。文档、i18n、Code Collab、平台和公开仓库边界检查通过。

## CI 修正（2026-09-09）

Static checks 失败确认了上述 DSH lint 问题。上游 [DSH #14](https://github.com/LodyAI/acp-extension-dsh/pull/14) 恢复 `await test(...)`，现已作为 `ce194fd` 合入 main。宿主 pin 更新到该 main 提交，取代 `5d79d5b` 的临时验证限制。合并后的文件树与已验证的修复完全一致：DSH 构建、11 项单元测试、格式检查和宿主 `check:quick` 均通过。运行时实现和 lint 规则均未修改。

## 原始决策

- 宿主 gitlink `packages/acp-extension-codex` 从 main 的 `f9dbc8c` 移到 `fc91dce`（未合的 adapter PR #37，基线是已合的 #35 / `400384e`）。
- 宿主 gitlink `packages/acp-extension-core` 从 `1aa2431` 移到已发布的 0.1.2 `9c47fec`。根目录 `pnpm-lock.yaml` 仍是 `workspace:*`，不必改写；adapter 子模块自己的 npm lock 已经写明 Core 0.1.2。
- Lody #534 同样钉 Core `9c47fec`，并把 Codex 钉到 `89b1208`（#35 加一条未合入的 review 夹具测试），外加宿主 AgentClient / session-manager 身份代码。本 PR 只共享 Core 0.1.2 gitlink，不复制 #534 宿主文件。若 #534 先合，Codex gitlink 需要再变基到那条旁支（`89b1208` 与 `fc91dce` 是兄弟提交）。
- `LODY-FORK-001` 仍是 runtime-simulator 旅程（`session-fork-acp.mjs`）。它可以回归宿主 fork RPC，但不会执行真实 Codex adapter，不能当修复验收。

## 证据与限制

adapter #37（`fc91dce`）的独立审核使用真实 Codex 0.153.4 和合成模型 HTTP：父会话、fork 第一轮、fork 第二轮、子会话之后的父会话、关闭子会话时的退订均通过。同一探针对旧的退订包会在子会话第一轮挂起。

重新构建的桌面 CLI（`apps/electron/resources/cli/codex-acp.js` → `chunks/index-DfT2wei0.js`）只在 `assignProject` 失败路径退订。独立审核用该新 chunk 复跑同样回合已通过；旧 chunk 会挂。

这不会发布 adapter。在 adapter #37 合入并且发行包含这个 gitlink 之前，桌面用户仍然会遇到该缺陷。隔离的 Electron 界面启动使用 `LODY_E2E=1` 和独立的数据目录 / 宿主端口，这样不会从开发者已打开的窗口抢走单实例锁。那次启动只是桌面 boot smoke（进入了 `#/local/chat`，没有动开发者已有实例），不是窗口内的 Codex 分叉。`LODY-FORK-001` 没有当作修复验收。

相关：[Lody #543](https://github.com/LodyAI/Lody/issues/543)、[adapter #37](https://github.com/LodyAI/acp-extension-codex/pull/37)、[Lody #534](https://github.com/LodyAI/Lody/pull/534)（未纳入）。
