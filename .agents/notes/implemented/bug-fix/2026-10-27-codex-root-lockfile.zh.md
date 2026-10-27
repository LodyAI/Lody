# 同步 Codex 子模块与根锁文件

Status: implemented
Translation: current

[English](2026-10-27-codex-root-lockfile.md)

## 摘要

main 升级 Codex 子模块时没有同步根工作区锁文件，导致 PR 合并检查在安装阶段失败，测试尚未开始。重新生成锁文件，使 ACP SDK 2.0.2 和 Codex 0.164.0 与子模块保持一致。仅对这些选定版本添加精确的发布时间例外，后续版本仍遵循七天等待规则。

## 决策与证据

[PR #1935](https://github.com/LodyAI/Lody/pull/1935) 的完整 CI 和 Desktop E2E 日志均报告 `ERR_PNPM_OUTDATED_LOCKFILE`：根 importer 仍为 SDK `~1.5.0`、Codex `^0.160.1`，合并后的子模块要求 `~2.0.2`、`^0.164.0`。本地 frozen 安装复现了相同问题。SDK 和 Codex 的解析版本与子模块 package-lock 固定版本一致。

保留 frozen 安装校验，只更新对应依赖图和精确的发布时间例外，包括 Codex 的各平台包。pnpm 10.20 使用同一个包的第一条匹配规则，因此扩展原有例外。不需要修改运行时代码、子模块源码、工作流或全局等待天数。

## 验证与限制

本地 frozen 安装、根类型检查、Codex 类型检查、格式化、静态和边界检查、文档检查及 Ed25519 子群边界测试通过。完整 `pnpm check` 执行至 CLI 测试：4868 项通过、四项跳过，已有原生 Git 传输测试在当前环境报 `context_unreadable`。因此不能宣称本地全量测试通过，推送后的合并结果还需远端检查验证。
