# Codex ACP SDK 升级的精确发布期例外

Status: implemented
Translation: current

[English](2026-10-27-codex-acp-sdk-release-age-exception.md)

## 摘要

提交 `b6e34c7de` 把 `acp-extension-codex` submodule 升级到 `@agentclientprotocol/sdk ~2.0.2` 和 `@openai/codex ^0.164.0`，`87fcf52aa` 也把 Codex 运行时清单改成了 0.164.0，但 `pnpm-lock.yaml` 没有重新生成。因此 main 上每次冻结安装都以 `ERR_PNPM_OUTDATED_LOCKFILE` 失败，所有 CI 任务和 PR 都受影响。两个版本都发布于 2026-10-23，处在 7 天的 `minimumReleaseAge` 隔离期内，lockfile 根本无法解析。负责人选择加入精确的 `minimumReleaseAgeExclude` 条目（SDK 2.0.2；Codex 0.164.0 及其 6 个平台构建，追加到已有的那条 Codex 规则中），并重新生成 lockfile。之后的新版本仍受隔离期约束。

## 范围与证据

- lockfile 的改动只限 `packages/acp-extension-codex` 这个 importer：SDK `1.5.1 → 2.0.2`，Codex `0.160.1 → 0.164.0` 及其平台别名。不再被引用的 SDK 1.5.1 条目被移除；其他 importer 仍使用 SDK 1.8.0。
- `pnpm install --frozen-lockfile` 成功，`acp-extension-codex` 能基于 SDK 2.0.2 构建。
- 之前在导入时因 `Codex runtime manifest 0.164.0 does not match @openai/codex 0.160.1` 失败的 CLI 测试现在通过（`provider-setup-manager`、`terminal-pty-service`、`codex-profile-store`、`local-control-handler`）。

## 替代方案

等到 2026-10-30 再更新不需要策略例外，但在那之前所有 PR 的 CI 都是红的。回退 `b6e34c7de` 和 `87fcf52aa` 会撤销 main 想要发布的这次升级。

## 限制

本次改动没有用 0.164.0 跑过已认证的 Codex ACP 提示。这个例外记录的是负责人对这些精确版本的批准，不是对其内容的安全审查。
