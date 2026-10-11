# 静态 Claude 模型标签去版本号

Status: implemented
Translation: current

[English](2026-10-11-claude-static-labels-evergreen.md) | 中文

## 摘要

`packages/shared/src/ai.ts` 中的首屏兜底 Claude 模型标签写死了小版本号（`Haiku 4.5`、`Sonnet 5`、`Opus 5`、`Fable 5.1`，快照自 Claude Code 2.1.258），而 #906、#1103 只升级了运行时清单到 2.1.284，没有同步静态表。本次改动去掉静态描述中的版本号，使其在运行时升级之间不再过期。确切版本号仍由实时 ACP 运行时探测提供。本次同时新增契约测试，拒绝静态 Claude 模型标签中出现版本号字样。

## 证据

- 静态来源 `packages/shared/src/ai.ts:931`（`CLAUDE_STATIC_MODELS`）；UI 仅在无机器 capability 缓存时使用（`packages/components/src/components/shared/acp-selector-options.ts:227`，权限为 `provisional`）。
- 内置适配器直接透传 SDK 广播的模型，不硬编码模型列表，因此每次 capability 刷新后探测值自带确切版本号。
- 别名（`haiku` / `sonnet` / `opus`）在服务端解析，去版本号的静态标签不会导致路由错误。

## 备选方案

- 每次升级运行时同步更新静态表版本号：否决，#906/#1103 证明该同步经常被跳过，会重复制造同样的过期标签问题。
- 去掉描述只保留名字：否决，家族名加特性描述（`Fastest for quick answers`）对首屏选择仍有帮助。

## 权衡

- 首屏失去版本号细节（运行时探测返回前不可见）。可接受：探测与会话启动同路，且标签具权威性。

## 验证边界

- 已更新 `ai-claude.test.ts` 期望并新增无版本号断言；本检出无依赖安装，无法运行完整测试集，需 CI 确认。`pnpm check` / `pnpm format` 同样待 CI 覆盖。
