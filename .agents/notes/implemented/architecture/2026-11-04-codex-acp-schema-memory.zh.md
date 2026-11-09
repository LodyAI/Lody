# 延迟创建 Codex ACP 校验规则

Status: implemented
Type: architecture
Translation: current
PR: https://github.com/LodyAI/acp-extension-codex/pull/78

[English](2026-11-04-codex-acp-schema-memory.md)

## 摘要

每个 Codex 适配器进程启动时都会构造两个协议版本的 ACP SDK 校验对象。Node/Electron 适配器包改为首次校验时创建未使用的规则，保留 V1、V2、会话隔离和协议行为。

## 决策

适配器构建时用 Zod 的缓存型 lazy schema 延迟创建 ACP SDK 2.0.2 生成的 V1 和 V2 规则。NES 对外提供可扩展的对象规则，因此这些对象及其传递依赖保持原有类型。其他 SDK 版本使用自身生成的代码。此改动只作用于适配器包，不修改已安装的 SDK 或 Bun 可执行文件的构建。

让多个会话共享适配器会改变进程边界；延迟创建保留现有边界和全部协议处理器。

## 测量

在 macOS arm64、Electron 44.9.3 和 Codex 0.164.0 下，六组独立的 Codex 适配器及原生进程通过本地模型替身完成短合成对话。使用 Lody 适配器打包方式、空闲 60 秒后，进程组合计 footprint 从 397 MiB 降至 310 MiB；这不是整桌面的占用。

配对的本地延迟实验中，V1 权限规则首次校验的中位数增加约 0.8 毫秒，V2 初始化规则首次校验增加约 1.3 毫秒。合成对话的首段回复在两种实现中均约为 20 毫秒。这些测量不包含远端模型或桌面界面。

## 验证

适配器的 [schema 打包测试](../../../../packages/acp-extension-codex/scripts/lazy-acp-schemas.test.mjs) 对照 V1、V2 生成规则的解析结果及错误，检查 NES 对象扩展和首次使用时初始化。真实 Codex 验证使用合成会话和本地模型替身。
