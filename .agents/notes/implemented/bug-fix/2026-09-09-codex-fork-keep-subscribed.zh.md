# 让分叉后的 Codex 会话保持订阅

Status: implemented
Translation: current

[English](./2026-09-09-codex-fork-keep-subscribed.md)

## 摘要

Codex 分叉会立刻退订子 thread。宿主把这个子会话当活 Session，并等待 `turn/completed` 通知，于是第一句 prompt 永不结束，停止时报没有进行中的 turn，下一句变成 `already active`。这次宿主改动把 `acp-extension-codex` 钉到 `fc91dce`（adapter #37），成功 fork 后子会话保持订阅；同时钉 `acp-extension-core` 0.1.2，因为该 adapter 已经依赖它。不带入 Lody #534 的宿主 worktree 身份改动。adapter #37 尚未合入，在它合并前这个 pin 不能随桌面发布。

## 决策

- 宿主 gitlink `packages/acp-extension-codex` 从 main 的 `f9dbc8c` 移到 `fc91dce`（未合的 adapter PR #37，基线是已合的 #35 / `400384e`）。
- 宿主 gitlink `packages/acp-extension-core` 从 `1aa2431` 移到已发布的 0.1.2 `9c47fec`。根目录 `pnpm-lock.yaml` 仍是 `workspace:*`，不必改写；adapter 子模块自己的 npm lock 已经写明 Core 0.1.2。
- Lody #534 同样钉 Core `9c47fec`，并把 Codex 钉到 `89b1208`（#35 加一条未合入的 review 夹具测试），外加宿主 AgentClient / session-manager 身份代码。本 PR 只共享 Core 0.1.2 gitlink，不复制 #534 宿主文件。若 #534 先合，Codex gitlink 需要再变基到那条旁支（`89b1208` 与 `fc91dce` 是兄弟提交）。
- `LODY-FORK-001` 仍是 runtime-simulator 旅程（`session-fork-acp.mjs`）。它可以回归宿主 fork RPC，但不会执行真实 Codex adapter，不能当修复验收。

## 证据与限制

adapter #37（`fc91dce`）的独立审核使用真实 Codex 0.153.4 和合成模型 HTTP：父会话、fork 第一轮、fork 第二轮、子会话之后的父会话、关闭子会话时的退订均通过。同一探针对旧的退订包会在子会话第一轮挂起。

重新构建的桌面 CLI（`apps/electron/resources/cli/codex-acp.js` → `chunks/index-DfT2wei0.js`）只在 `assignProject` 失败路径退订。独立审核用该新 chunk 复跑同样回合已通过；旧 chunk 会挂。

这不会发布 adapter。在 adapter #37 合入并且发行包含这个 gitlink 之前，桌面用户仍然会遇到该缺陷。隔离的 Electron 界面启动使用 `LODY_E2E=1` 和独立的数据目录 / 宿主端口，这样不会从开发者已打开的窗口抢走单实例锁。那次启动只是桌面 boot smoke（进入了 `#/local/chat`，没有动开发者已有实例），不是窗口内的 Codex 分叉。`LODY-FORK-001` 没有当作修复验收。

相关：[Lody #543](https://github.com/LodyAI/Lody/issues/543)、[adapter #37](https://github.com/LodyAI/acp-extension-codex/pull/37)、[Lody #534](https://github.com/LodyAI/Lody/pull/534)（未纳入）。
