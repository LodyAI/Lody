# 记录各内置 provider 的 ACP 与扩展能力支持

Status: proposed
Translation: current
Language: [English](2026-10-06-docs-acp-feature-support.md)

## 摘要

从 Codex 或 Claude Code 迁移过来的读者，此前只能翻适配器源码才能知道 Lody 各内置 provider
支持哪些能力。本提案在两种语言下新增 `(migrating)/acp-feature-support`：先简要说明 ACP 与
`acp-extension-core` 的 `_meta.lody` 契约，再用一张 provider × 功能矩阵列出标准 ACP 可选
能力和十项面向用户的 v1 Agent 扩展能力。矩阵来自已发布适配器与外部 ACP 服务的能力常量、
`InitializeResponse` 和源码，是文档快照而非运行时探测，因此 provider 升级后可能滞后，需要
维护者重新核对。

## 问题

- 迁移页说明了 Lody 增加了什么，却没有说明各内置 provider 实际声明了哪些可选能力。
- Lody 的扩展能力按功能逐项发布在 `_meta.lody` 下，公开文档里没有一页汇总这套契约和各
  provider 的支持情况。
- Devin、Grok 兼容代理，以及外部的 Bub、Dimcode ACP 服务，让读者难以判断哪些能力由 Lody
  保证、哪些取决于连接背后的运行时。

## 决策

- 新增 `site-docs/content/docs/{en,zh}/(migrating)/acp-feature-support.mdx`，并写入两个
  `(migrating)/meta.json`。在迁移页正文和「下一步」卡片中加入链接。这是对
  [信息架构记录](2026-10-01-docs-information-architecture.zh.md)所定义读者路径分组的扩展。
- 说明 ACP、`acp-extension-core` 的协商模型和 `_meta.lody` 能力键，并链接协议官网与公开
  契约仓库。
- 发布一张矩阵：列为标准 ACP 可选能力和十项面向用户的 v1 Agent 扩展能力，行为九个内置
  provider。
  Lody 行依据适配器能力常量填写（`CLAUDE_LODY_CAPABILITIES`、`CODEX_LODY_CAPABILITIES`、
  `LODY_CAPABILITIES`、`GROK_LODY_CAPABILITIES`、`LODY_EXTENSION_CAPABILITIES`、
  `initializeResponse()` 以及 Devin 代理），标准 ACP 行则依据各适配器的 `InitializeResponse`
  或外部 ACP 服务的源码。只使用 `✓`、`◐`、`—`，并将 provider 名称链接到对应的运行时或
  适配器仓库。
- 把合并的加载/恢复列拆成 `ACP：加载` 和 `ACP：恢复`，避免只支持其中一项的 provider 被写成
  两者都支持。
- 链接 [ACP Wall](https://github.com/wibus-wee/acp-wall)，作为标准 ACP 实现的独立、带版本
  的对比。
- 为这十项面向用户的能力增加扩展能力列说明。两个 provider 内部使用的 Codex key
  （`sessionHistory` 只读导入和 `worktreeProject` 原生项目映射）刻意不放进面向用户的矩阵；
  其他 provider 分别通过标准 ACP 回放和 Lody 侧 worktree 达到同样结果。

## 考虑过的替代方案

1. 把矩阵直接放在现有迁移页里。否决：19 列的表格会把迁移清单埋掉，而且这份矩阵属于迁移
   读者的参考材料。
2. 对 Lody 只是代理的外部运行时保留 `运行时`。评审后否决：它没有回答该能力到底可不可用。
   表格现在改为依据 provider 自己的 `initialize` 声明或源码填写。
3. 构建时逐个探测 provider 生成表格。否决：静态站点构建没有 provider 凭据和运行时；已发布
   的声明是当前可得的事实来源。

## 验证与限制

- `pnpm run docs status`、`node scripts/docs/main.mjs check`、site-docs 的 `typecheck`、
  `test` 和生产构建均通过；静态浏览器套件仍只有原先两个移动端 no-js 导航超时，没有新增失败。
- 矩阵是已发布适配器与外部 ACP 服务版本当时的快照。provider 升级后，实际协商结果可能在本页
  重新核对之前就发生变化。
- 依据 `acp-extension-dsh` 0.2.0（`8cf61ea`，acp-extension-core 0.1.9）刷新了
  `DeepSeek Harness` 一行：新增声明标准加载、恢复、Fork，以及 Core 的按轮 Fork、转向、
  子代理、持久目标与后台任务；图片输入仍取决于模型，定时任务与速率限制仍未声明。
