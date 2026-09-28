# 固定已合并的 Codex 适配器及其匹配的 Core 版本

Status: proposed
Translation: current

[English](2026-09-27-codex-adapter-core-pins.md)

## 摘要

Lody 当前固定的 Codex 适配器尚未包含已合并的托管账户刷新修复，而较新的适配器依赖 Core 0.1.9 的契约。只升级适配器会让工作区使用不匹配的 Core，因此本次同时更新两个子模块以及锁文件中的 Core 依赖记录。宿主未声明新的子代理事件能力；本 PR 不实现由 [#1027](https://github.com/LodyAI/Lody/pull/1027) 单独负责的账户管理宿主逻辑。

## 决策与范围

- 将 `acp-extension-codex` 固定到已合并的 main 提交 `0d7bb30`（[适配器 #58](https://github.com/LodyAI/acp-extension-codex/pull/58)）。其中包含托管 ChatGPT 刷新争用的分类修复，覆盖全部四条会话打开路径，包括 `loadSession`。
- 将 `acp-extension-core` 固定到已发布的 0.1.9 提交 `c806162`（[Core #15](https://github.com/LodyAI/acp-extension-core/pull/15)）。适配器中较早的 #56 提交使用了该标准化子代理事件契约。
- 在根目录 `pnpm-lock.yaml` 的 Core importer 中记录 SDK 依赖。Lody 的能力声明和账户管理实现留给各自的改动。

不采用仅升级适配器的方案，因为新适配器会从工作区解析到旧的 Core 0.1.8 契约。将三个版本输入放在一起，也能让宿主账户管理 PR 依赖可独立验证的合并升级，而不再重复 gitlink 改动。

## 验证与边界

这组提交已在账户管理分支完成验证：Core 8 项测试及适配器 825 项测试通过，适配器另有 27 项跳过；两者的类型检查通过。本独立分支已通过安装、格式化、文档、公开仓边界、根仓类型检查和 lint。完整 `pnpm check` 在并发负载下因无关的 `code-review-helper` 测试达到 5 秒超时而中止；同一测试单独运行通过。仍需查看针对当前 `main` 的 CI。未声称验证了真实账户的认证刷新；根仓宿主目前也未声明 `subagentEvents`。
