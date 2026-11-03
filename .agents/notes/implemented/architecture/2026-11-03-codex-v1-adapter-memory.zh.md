# Lody 的 Codex 适配器只加载 ACP v1

Status: implemented
Type: architecture
Translation: current

[English](2026-11-03-codex-v1-adapter-memory.md)

## 摘要

每个保留的 Codex 会话都有独立的适配器进程。Lody 使用 ACP v1，通用适配器入口却会在每个进程中同时加载 ACP v2 协议定义。Lody 内置入口现在直接连接已有的 v1 处理逻辑，不再加载 v2 协议定义。每个会话仍保留独立的适配器和 Codex 进程。

## 决策

SDK 的通用协议路由即使在客户端使用 v1 时也会导入两个版本的协议定义。Lody 入口直接使用适配器现有的 v1 处理逻辑；响应发送和会话建立逻辑仍由共用路由核心负责。适配器的标准入口继续使用通用路由。Codex 原生的 app-server v2 协议与 ACP v2 是两回事，保持不变。

## 验证

[历史传输测试](../../../../packages/acp-extension-codex/src/__tests__/ReadSessionHistoryTransport.test.ts)同时覆盖 Lody 入口的路由和原有路由。[对话测试工具](../../../../packages/acp-extension-codex/src/__tests__/CodexACPAgent/v2-prompt-harness.ts)在 v1 对话、取消、权限和恢复测试中使用该路由。
[入口构建测试](../../../../packages/acp-extension-codex/src/__tests__/LodyEntryBuild.test.ts)在 ACP v2 SDK 不可用时构建 Lody 入口。

在 macOS arm64 上，以本地模型服务运行十个独立的合成 Codex 会话，自然空闲 120 秒且不强制垃圾回收后，标准入口的适配器和原生进程合计物理足迹为 676.2 MiB，Lody 入口为 537.3 MiB。这里测量的是 Agent 进程，不是整个桌面。
