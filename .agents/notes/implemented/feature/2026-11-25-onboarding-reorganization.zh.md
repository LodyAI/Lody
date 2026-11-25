# 桌面端 Onboarding 重组与共用模型连接面板

Status: implemented
Translation: current

[English](2026-11-25-onboarding-reorganization.md)

## 摘要

桌面端 Onboarding 过去横跨最多十一屏（五步桌面引导、五步 Harness Setup 向导以及 Summary 页），在守护进程启动时静默探测外部 CLI，并要求先选定 Agent 与仓库才能看到输入框。重组后的路径将首次启动决策收敛至最多三步（`Arrive -> Account -> Model -> Start`），通过无头 Sorbet `ArrivalProbe` 在进入时一次算准 `needsModel`，在 Onboarding 与 `Settings -> Lody Agent` 之间共用同一个 `ConnectModelSheet`，并在 `Start` 屏直接挂载真实的 `<ChatComposer>`（支持无项目直接对话）。由于 Claude Code 与 Codex 的订阅 OAuth 使用单次轮换刷新令牌，直接复制会导致原 CLI 掉线，因此导入仅复制静态 API Key，而遇到轮换式 OAuth 凭证时引导一键完成 Sorbet 订阅登录。

## 决策与证据

### 前置无头 `ArrivalProbe` 与零未授权外部读取

在 `Arrive` 播放期间，Electron 调用内置 CLI 的无头辅助命令（`lody __internal sorbet-onboarding probe`），显式关闭登录 Shell 环境探测并清空继承的第三方密钥变量。辅助命令基于 `<LodyDataDir>/sorbet` 打开 `@sorbetai/control`（遵循 [Sorbet 认证与本地控制](2026-11-02-sorbet-acp-authentication.zh.md) 的数据目录边界），仅调用 `credentials.list()`、`authentication.methods()` 与 `providers.availableModels()`。由于无需启动 ACP 会话或等待云端登录，即便在云端版本尚未完成浏览器登录前，`getDesktopOnboardingSteps({ cloudAccount, needsModel })` 也能在进入时给出准确步骤，避免中途跳步。

Electron 托管的守护进程启动（`apps/cli/src/commands/start.ts`）在未显式传入 `--cli-types` 时不再扫描 `~/.claude*`、`~/.codex*`、`~/.kimi-code*` 或 `~/.grok*`；同时 `Lody.ensureBuiltinAgentConfigs` 默认为每台机器注册随包内置的 `Lody Agent`（`cliType: 'builtin'`，`agentType: 'sorbet'`），并将默认自治级别设为 `permission_mode: 'ask'`（操作前询问）。

### 外部凭证导入与刷新令牌轮换约束

核对 `@sorbetai/control` 所依赖的 `@earendil-works/pi-ai` 实现可见，Anthropic Claude OAuth（`platform.claude.com/v1/oauth/token`）与 OpenAI ChatGPT/Codex OAuth（`auth.openai.com/oauth/token`）均采用单次轮换式 refresh token。若将 `~/.claude/.credentials.json`（或 macOS 钥匙串 `"Claude Code-credentials"`）或 `~/.codex/auth.json` 中的 OAuth 令牌直接写入 Sorbet，任一端刷新都会令另一端失效下线。

- 静态 API Key（Claude Code 配置中的 `primaryApiKey` / `env.ANTHROPIC_API_KEY`、`~/.codex/auth.json` 中的 `OPENAI_API_KEY`，以及通过 `$SHELL -ilc env` 扫描并勾选的变量）不会轮换，在用户确认后通过 `control.authentication.login({ type: 'api_key' })` 安全写入。
- 当仅检测到轮换式 OAuth 凭证时，`runSorbetImportSource` 返回 `status: 'oauth_conflict'` 且不写入凭证，由 `ConnectModelSheet` 用一句话说明轮换冲突并提供一键跳转至对应订阅登录。
- 在 macOS 上展开 Claude Code 导入行时，会先说明可能触发的系统钥匙串授权弹窗，用户点击“确认导入”后才执行 `/usr/bin/security`。

### 非敏感来源元数据与精简 Settings 向导

Sorbet 的 `credentials.list()` 仅返回 `{ providerId, type }` 并将密钥留在内部存储中。为了让 `OnboardingChipRail` 与 `Settings -> Lody Agent` 展示连接来源（`订阅`、`从 Claude Code 导入`、`从 Codex 导入`、`从环境变量导入`、`API Key ····last4`）且不解析 Sorbet 私有 `credentials.json`，Lody 在 `<LodyDataDir>/sorbet-connection-sources.json`（权限 `0o600`）中仅保存非敏感来源描述，并在 `logout` 时同步清理。

原有的独立五步向导（`packages/components/src/components/harness/setup.tsx`）已移除，`Settings -> Lody Agent` 直接进入普通设置标签页，并在本机尚无已连接模型来源时内嵌 `ConnectModelSheet`。将 `ConnectModelSheet` 置于 `packages/components/src/components/onboarding/shared/` 下可保持 `apps/electron/scripts/check-settings-route-chunks.mjs` 校验的设置页按需分包边界。

### 非 TCC 目录按需仓库扫描与输入框转场

`StartScreen` 默认不预选项目（`project = null`），复用现有的无项目会话工作目录支持。仅当用户点开 Project 浮层时，`discoverRecentLocalRepos` 才扫描 `~/dev`、`~/code`、`~/Developer` 与 `~/projects` 下 1–2 层 Git 仓库，严格跳过 `~/Documents`、`~/Desktop` 与 `~/Downloads` 以免触发未预期的 macOS TCC 授权弹窗。进入产品时，在未开启减弱动效且支持 View Transitions 的环境下，路由跳转将 `[data-lody-composer-box]` 平滑过渡到产品内的输入框位置。

## 影响

首次引导不再预先后台下载第三方托管运行时（`use-onboarding-builtin-runtime-prefetch.ts` 与 `use-builtin-runtime-readiness.ts` 已移除），第三方 Agent 改为在 `Start` 输入框的 Agent/Model chip 或设置中按需安装。升级前残留的旧阶段枚举（`ceremony`、`login`、`workspace`、`providers`、`projects`、`firstTask`、`summary`）会自动归一化至 `arrive | account | model | start`。

## 验证

- [`apps/cli/src/lib/sorbet-onboarding-control.test.ts`](../../../../apps/cli/src/lib/sorbet-onboarding-control.test.ts) 验证无头 `ArrivalProbe`、非敏感来源元数据读写、静态 Key 导入、轮换 OAuth 冲突识别与登录 Shell 环境变量扫描。
- [`apps/electron/src/main/services/local-repo-discovery.test.mjs`](../../../../apps/electron/src/main/services/local-repo-discovery.test.mjs) 验证允许的开发目录扫描、TCC 目录隔离及静态仓库提示信号检测。
- [`packages/components/tests/onboarding-flow.test.tsx`](../../../../packages/components/tests/onboarding-flow.test.tsx)、[`packages/components/tests/desktop-onboarding-completion.test.ts`](../../../../packages/components/tests/desktop-onboarding-completion.test.ts) 与 [`packages/components/tests/onboarding-analytics.test.tsx`](../../../../packages/components/tests/onboarding-analytics.test.tsx) 覆盖四步平台矩阵、`ConnectModelSheet`、`StartScreen` 输入框交互与完成埋点契约。真实第三方 OAuth 浏览器回调与系统钥匙串弹窗不在自动化测试覆盖范围内。
