# 用不可变镜像产物刷新托管 Agent 运行时

Status: implemented
Translation: current

[English](2026-09-17-managed-runtime-refresh.md) | 中文

## 摘要

内置 Claude、Codex 和 Grok adapter 仍固定在较旧的上游运行时，Lody 的 managed-runtime manifest 也仍指向对应的旧镜像对象。本次刷新把 Claude Agent SDK 升到 0.3.274、Claude Code 升到 2.1.274，把 Codex 升到 0.154.0、Grok Build 升到 1.0.34，并在修改 manifest 前先发布各平台的不可变产物。按 owner 要求，Kimi 保持当前 Lody fork；Pi 也保持不变，因为 0.85.1 已是当前版本。全局新包隔离仍然开启，只对已经验证的 Claude 和 Codex 精确版本放行。

## 决策

Managed runtime 升级继续采用“先产物、后 manifest”的顺序：

1. 把 adapter 依赖或官方运行时 manifest 固定到选定的上游版本。
2. 从官方来源构建或取得全部支持平台的产物，并校验来源完整性。
3. 上传带版本号的不可变对象到生产 R2，再回读并核对固定的 SHA-256 与字节数。
4. 只有全部必需产物通过生产回读后，才更新 CLI runtime manifest。

Claude 包含八个平台目标，Codex 和 Grok 各六个。pnpm 的七天新包隔离只为 Claude SDK 0.3.274、它的八个平台包以及 Codex 0.154.0 添加精确例外；后续版本仍会被隔离。Grok 由 adapter 自己维护的 manifest 固定到 1.0.34；由于本次刷新没有运行需要登录的在线 session，已有的私有 wire 兼容规则继续使用与版本无关的表述。

## 证据

- Claude adapter：build 通过；823 个测试通过，20 个跳过。
- Codex adapter：build 与 typecheck 通过；637 个测试通过，27 个跳过。
- Grok adapter：build 与 typecheck 通过；58 个测试通过。
- Claude 和 Codex 的生产对象都已从 R2 回读，并与生成的 manifest 一致。
- Grok 产物由官方 npm 包可复现地重新打包，校验了可执行文件的哈希与大小，并上传、回读了不可变的 1.0.34 路径。
- 对全部 20 个生产镜像 URL 发起公开 HEAD 请求，返回的字节数都与 manifest 一致。
- 根仓库完整 `pnpm check`、文档检查、格式检查和 frozen lockfile 检查均通过。由于本地 IPC 测试需要绑定 loopback 和 Unix socket，根仓库检查在受限沙箱外重跑。

## 限制

Kimi 明确不在本次刷新范围内。Pi 和不使用 managed binary 的 DSH 不需要新对象。完整 workspace install 在解析新锁文件后进入了 Electron 原生模块重建，但这台机器尚未接受本地 Xcode license，因此不能完成该步骤；adapter 级校验不依赖这次原生构建。Claude 的独立 lint 仍会报告 `src/tests/usage.test.ts` 中原有的未使用 `thinkingTokens` 声明；本次刷新没有修改该文件。
