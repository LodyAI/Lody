# 使用用户安装的 Node.js 运行 DeepSeek Harness

Status: implemented
Translation: current

[English](2026-10-27-dsh-system-node.md)

## 摘要

DeepSeek Harness 0.2.1-rc.2 在 Electron 44.9.3 下尚未完成 ACP 初始化就失败，因为 node-addon-require-builtin 0.1.9 拒绝该 Node/V8 指纹。Lody 改为从最终启动 PATH 选择独立 Node.js，在运行 npx 前检查，并让 Harness 和 Windows npm 入口使用该程序。缺失、版本不支持和无法执行的情况均在前端明确提示安装方法。用户需要负责 Node.js 的安装和升级，Harness 的执行环境不再随 Electron 安全更新而变化。

## 证据与决策

同一份缓存原生加载器在 Electron 44.7.0（Node 24.21.0、V8 15.2.124.28-electron.0）和独立 Node 24.22.1 下均能读取 `internal/modules/esm/loader`。Electron 44.9.3（Node 24.22.0、V8 15.2.124.43-electron.0）可复现 `Unsupported/no-context`，错误明确指出不支持该运行时指纹。此最小对照证明了加载器失败，不验证模型接口或会话存储。

用户批准改用系统 Node，并要求缺失时提示安装。本决策仅替代[内置 Node 决策](2026-09-16-dsh-bundled-node-runtime.zh.md)和 [Electron 兼容决策](2026-10-10-dsh-electron-runtime.zh.md)中的运行时选择。保留 npx 固定依赖、缓存恢复、显式 `runCli()`、Provider 目录和原有会话压缩规则。不回退 [Electron 安全升级](2026-10-26-runtime-dependency-security.zh.md)，不修改下载的原生二进制。

从登录 shell 与 Provider 环境合并后的最终 PATH 中，按顺序选择绝对目录里的第一个 Node。忽略空项和相对目录，避免会话工作目录隐式提供执行程序。首个候选无法执行时明确失败，不静默改用其他安装。检查仓库现有 Node 安全版本下限及 Node-API 10，并拒绝 Electron 程序。仅在 DSH 子进程环境移除 `ELECTRON_RUN_AS_NODE`。保留 PATH 顺序，包括首位的 GitHub shim。Windows npm JS 与 DSH 转发器使用同一个选中的 Node，保留无窗口启动和进程树管理。

会话与能力探测、历史读取、协议认证入口均在环境合并后执行检查。稳定的 `DSH_NODE_NOT_FOUND`、`DSH_NODE_UNSUPPORTED`、`DSH_NODE_EXEC_FAILED` 标识沿现有错误消息传递；前端常开错误提示展示本地化解决方法和 Node.js 下载按钮。原始错误保留检测版本或执行失败原因，仍可完整复制。更新能力来源版本，确保升级后重新探测。

## 所有权与故障范围

有限的前置检查使用原生 Effect v4 和现有进程服务，在 ACP 的 Promise 入口执行。检查有五秒期限、输出上限和进程服务的只读探测终止策略。会话或认证取消会中断检查；进程 Scope 负责清理，释放失败仍由共享进程服务保留。检查失败仅阻止当前启动，不缓存失败，安装后可以重试。历史读取没有外层取消约定，使用同样有时限的检查。其他 ACP 调度仍是 Promise，本次不宣称完成 ACP 传输迁移。

## 验证与限制

六组 CLI 测试共 163 项通过，覆盖 PATH 顺序与空格路径、Windows npx 转发、Node 缺失或不支持或无法执行、安装后重试、生成的真实启动代码，以及取消进行中的检查并确认子进程终止。两组前端测试共 21 项通过；现有错误提示 Storybook 增加缺失 Node 和下载操作状态。CLI 与 components 类型检查、改动代码 Oxlint、进程与公共边界检查、根目录格式化和文档检查通过。

真实本地 ACP 检查使用本次启动代码、此前打包的适配器、缓存的 0.2.1-rc.2 依赖及临时目录。独立 Node 24.22.1 和 Electron 44.9.3 宿主均能选择 PATH Node，完成 `initialize` 与 `session/new`，返回模式、预设、模型和推理选项。没有发送模型请求或使用真实凭据。检查复用已有适配器和缓存，跳过 npx 安装，不等于新安装包或 npm 冷下载验证。

根目录 `pnpm check` 停在未改动的 Codex 适配器构建：复用依赖中的 ACP SDK 版本较旧，缺少新要求的 `@agentclientprotocol/sdk/unstable` 与 `experimental/v2/unstable` 导出。Effect lint 也因缺少 `@effect/tsgo` 无法执行，不能称为全仓检查通过。Magpie 启动测试改用临时 DSH 目录，避免写入用户目录。

当前工作区最初没有依赖和已初始化的适配器；验证复用现有依赖安装，并初始化固定版本子模块。本次不下载或全局安装 Node，不升级 Harness、不降级 Electron、不修改用户配置，也不提交会话原文。原生 Windows/Linux 和签名安装包验收仍需独立验证。
