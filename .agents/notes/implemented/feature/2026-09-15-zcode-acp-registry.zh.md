# 新增 ZCode ACP registry 条目

Status: implemented
Translation: current

[English](2026-09-15-zcode-acp-registry.md)

PR: https://github.com/LodyAI/Lody/pull/729

## 摘要

Lody 此前没有提供 ZCode，即使 ZCode 桌面端已经内置 headless app-server。新的本地 registry 条目通过 `npx` 启动社区桥接包 `acp-extension-zcode@0.38.1`；桥接器会从 `ZCODE_BIN`、`PATH` 或桌面应用 bundle 自动发现 `zcode`。该改动只新增 registry 数据，现有运行时启动器和能力缓存不变。固定的 npm 版本必须先发布，且尚未在安装 ZCode 桌面端的机器上验证真实会话。

## 决策与证据

- 在 `scripts/generate-acp-registry.mjs` 的 `LOCAL_REGISTRY_AGENTS` 中加入 `zcode-acp`，并在同一文件补充 fallback 名称和描述。
- 条目复用现有 `npx` 分发，而不是 builtin 或托管运行时。这符合“Lody 维护的 registry 类型”的需求，同时让运行时所有权保留在独立适配器中。
- 版本固定为 `0.38.1`，这是包含 ACP 合规 `authenticate` 与 `session/fork` 修复的第一个版本。
- `zcode-acp.svg` 作为 local-only registry 资源打包，保证选择器离线渲染。
- 重新生成快照时也刷新了无关的上游条目（`minimax-code` 及常规版本更新）；它们只是生成产物，不代表额外的 provider 决策。

## 验证

- `node --test scripts/generate-acp-registry.test.mjs` — 3 项测试通过。
- 既有分支验证：`@lody/shared` 与 `@lody/components` typecheck、`@lody/shared` 107 个文件 / 1225 项测试，以及 `check-public-boundary` 均通过。
- 未验证：发布 `acp-extension-zcode@0.38.1`，以及在安装 ZCode 桌面端的机器上启动真实会话。

## 集成

- [acp-extension-zcode PR #1](https://github.com/Leeeon233/acp-extension-zcode/pull/1)
