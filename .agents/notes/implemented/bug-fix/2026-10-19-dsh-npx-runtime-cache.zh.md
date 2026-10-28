# 按运行时指纹失效 DeepSeek Harness 的 npx 闭包

Status: implemented
Translation: current

[English](2026-10-19-dsh-npx-runtime-cache.md)

## 摘要

Lody 的隔离 npx 缓存原先只检查顶层 `@deepseek-ai/dsh` 版本与 bin，因此 Electron 升级后仍可能
加载拒绝新 Electron/V8 指纹的嵌套 `node-addon-require-builtin`。现在 DeepSeek Harness 会在每个
闭包中记录活动运行时；仅当标记不匹配时失效该闭包，并在重装前强制一次在线元数据刷新。窄范围的
原生 addon 失败签名用于恢复没有标记的旧闭包。代价是只有 DeepSeek Harness 启用该校验，且在不同
Electron 运行时的 Lody 构建之间切换时，指纹翻转会重新安装 Harness 闭包。

## 问题

`inspectNpxInstallState()` 只校验根清单、请求的顶层包版本和 bin 目标，不检查嵌套原生依赖。
Issue #1704 中，Lody 0.106.0 升级后复用了包含 `node-addon-require-builtin@0.1.7` 的
`@deepseek-ai/dsh@0.2.0-rc.2` 缓存闭包。该 addon 声明支持 Electron 43.0.0、44.0.0 和
45.0.0-alpha.6，但不支持实际使用的 44.7.0 指纹，导致 host preparation 每次都失败。仅删除
`_npx/<hash>` 不够：`--prefer-offline` 会从保留的 `_cacache` packument 再次解析到 0.1.7。该
错误文本不在 `BROKEN_INSTALL_SIGNATURES` 中，启动策略既不会清理也不会重试。

DeepSeek Harness `0.2.1-rc.2` 现在依赖 `node-addon-require-builtin@^0.1.9`，新闭包不会再出现
这一确定的错误解析。但“顶层健康、嵌套 addon 不兼容”的校验缺口仍在，未来 Electron 升级仍可
重现同类问题。

## 决策

- `npx-cache.ts` 暴露运行时指纹（`electron`、`node`、`v8`、`modules`、`platform`、`arch`），
  并读写 `_npx/<hash>/.lody-runtime.json`。
- `inspectNpxInstallState()` 接受可选指纹。标记存在但不匹配时返回
  `runtime-fingerprint-mismatch`；标记缺失仍视为健康，避免升级时一次性失效所有已有闭包。
- `runNpxStartupWithRecovery()` 只清理 `allowedRoots` 内不匹配的闭包，强制一次
  `--prefer-online` 尝试，并在启动成功后用临时文件加 rename 写入标记。标记写入失败只记日志，
  绝不阻止启动。
- 窄范围的原生 addon 签名（`unsupported Electron runtime fingerprint`、
  `node-addon-require-builtin unsupported`、Node ABI 不匹配）对旧闭包执行同样的清理和一次在线
  重试。单一恢复标志限制重试次数，重复失败会抛出原始错误。
- 只有 DeepSeek Harness 传入指纹。Claude、Codex 和 registry npx agent 保持原有
  `--prefer-offline` 行为。

拒绝删除 `_cacache`：所有 npx 闭包共享它，删除会把一个运行时相关的失败放大为全量重装。也拒绝
只通过固定 `node-addon-require-builtin` 版本来修复，因为这只能覆盖一个包，并破坏同版本闭包约定。

## 限制

- 旧的不兼容闭包仍会先失败一次，然后才触发签名恢复；标记只会在新代码成功启动后存在。
- 持续失败的标记写入不会被记住，因此每次启动都会重试；它不会阻止启动。
- 在不同 Electron 运行时的 Lody 构建之间切换会翻转指纹，并每次重装 Harness 闭包。
- 签名集合依赖上游错误文本；措辞不同的原生失败仍会原样暴露。
- 验证是注入 IO 的单元级验证。未端到端重放原始 Electron 44.7.0 / DSH 0.2.0-rc.2 故障；
  addon 支持矩阵来自已发布的 0.1.7 与 0.1.9 二进制。

## 验证

已通过：`pnpm --filter lody test src/agent/npx-cache.test.ts`（67 项）和
`pnpm --filter lody typecheck`。测试覆盖标记匹配/不匹配、旧闭包、强制在线刷新、标记写入失败、
有界原生 addon 恢复，以及拒绝清理默认用户 npm 缓存。
