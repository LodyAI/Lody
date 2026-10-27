# 使用用户安装的 Node.js 运行 DeepSeek Harness

Status: implemented
Translation: current

[English](2026-10-27-dsh-system-node.md)

PR: https://github.com/LodyAI/Lody/pull/1948

## 摘要

DeepSeek Harness 0.2.1-rc.2 在 Electron 44.9.3 下尚未完成 ACP 初始化就失败，因为 node-addon-require-builtin 0.1.9 拒绝该 Node/V8 指纹。Lody 改为从最终启动 PATH 选择独立 Node.js，在运行 npx 前检查，并让 Harness 和 Windows npm 入口使用该程序。缺失、版本不支持和无法执行的情况均在前端明确提示安装方法。用户需要负责 Node.js 的安装和升级，Harness 的执行环境不再随 Electron 安全更新而变化。

## 证据与决策

同一份缓存原生加载器在 Electron 44.7.0（Node 24.21.0、V8 15.2.124.28-electron.0）和独立 Node 24.22.1 下均能读取 `internal/modules/esm/loader`。Electron 44.9.3（Node 24.22.0、V8 15.2.124.43-electron.0）可复现 `Unsupported/no-context`，错误明确指出不支持该运行时指纹。此最小对照证明了加载器失败，不验证模型接口或会话存储。

用户批准改用系统 Node，并要求缺失时提示安装。本决策仅替代[内置 Node 决策](2026-09-16-dsh-bundled-node-runtime.zh.md)和 [Electron 兼容决策](2026-10-10-dsh-electron-runtime.zh.md)中的运行时选择。保留 npx 固定依赖、缓存恢复、显式 `runCli()`、Provider 目录和原有会话压缩规则。不回退 [Electron 安全升级](2026-10-26-runtime-dependency-security.zh.md)，不修改下载的原生二进制。

从登录 shell 与 Provider 环境合并后的最终 PATH 中，按顺序选择绝对目录里的第一个 Node。忽略空项和相对目录，避免会话工作目录隐式提供执行程序。候选因 EACCES/EPERM 无法检查时继续搜索后续 PATH 项；没有可用候选时保留首个权限错误。其他检查错误仍明确失败。文件选中后若无法执行，仍明确失败，不静默改用其他安装。检查在实际子进程工作目录执行，并固定使用其报告的绝对 `process.execPath` 运行 Harness 和 Windows npm；保留版本管理器 shim 会使检查与实际运行的 Node 不同。检查仓库现有 Node 安全版本下限及 Node-API 10，并拒绝 Electron 程序。仅在 DSH 子进程环境移除 `ELECTRON_RUN_AS_NODE`。保留 PATH 顺序，包括首位的 GitHub shim。Windows npm JS 与 DSH 转发器使用同一个选中的 Node，保留无窗口启动和进程树管理。

普通会话在 `Session.createAgent` 的每次启动 attempt 中执行检查，位置在 shell/cache、凭据和记忆环境合并之后。返回的同一份环境用于可执行程序解析和 `sandbox.spawn`。能力与配额探测、历史读取、协议认证入口在各自环境合并后使用同一检查。稳定的 `DSH_NODE_NOT_FOUND`、`DSH_NODE_UNSUPPORTED`、`DSH_NODE_EXEC_FAILED` 标识沿现有错误消息传递；前端常开错误提示展示本地化解决方法和 Node.js 下载按钮。原始错误保留检测版本或执行失败原因，仍可完整复制。更新能力来源版本，确保升级后重新探测。

初版 `44ff47f2c` 从启动 overlay 移除了 `LODY_DSH_NODE_EXECUTABLE`，却漏接普通 `Session.createAgent`，导致所有普通 DSH 会话缺少转发器要求的变量，Windows 也跳过 npm JS 分支。**更正此前验证结论：**原隔离 ACP 检查执行的是生成的 bootstrap，没有经过普通 Session 主链。当前用 Session 专属检查与行为测试验证此边界，不能用能力探测成功替代。

## 所有权与故障范围

有限的前置检查使用原生 Effect v4 和现有进程服务，在 ACP 的 Promise 入口执行。检查有五秒期限、输出上限和进程服务的只读探测终止策略。会话或认证取消会中断检查；进程 Scope 负责清理，释放失败仍由共享进程服务保留。检查失败仅阻止当前启动，不缓存失败，安装后可以重试。历史读取没有外层取消约定，使用同样有时限的检查。其他 ACP 调度仍是 Promise，本次不宣称完成 ACP 传输迁移。

## 验证与限制

九组 CLI 测试共 194 项通过，包含 Session 环境、资源限制、终止，以及 Harness 启动、运行时检查、runner、认证、历史和 Agent 设置。新增 `Session.createAgent` 用例验证缺 Node 时不进入 sandbox spawn、安装后恢复、Windows npm JS 分支、最终记忆/Provider/shell 环境、取消后确认检查进程终止，以及 npm 恢复重试时重新检查 Node。临时撤掉 Session 接入后，缺 Node 和 Windows 分支两个回归测试均失败。新增真实 Session 边界用例验证：项目指定不支持的 Node 时在 sandbox spawn 前失败、修正版本后恢复、保留实际 Node 路径而非 shim，以及跳过不可访问的 PATH 目录且不改变权限。受控真实进程 Session 检查使用缓存 Node 24.22.0/24.22.1 和本地合成 ACP 服务，确认拒绝不支持版本、同一个 Session 修正后完成 initialize/session-new，以及不可访问目录仍存在时也能启动；不访问网络或发送模型请求。此前两组前端测试 21 项覆盖的 UI 未改变。CLI 类型检查、改动代码 type-aware Oxlint、进程与公共边界、根目录格式化和文档检查通过。

真实隔离检查现在直接调用 **`Session.createAgent`**，经过普通环境构造、sandbox 和 ACP client。独立 Node 24.22.1 与 Electron 44.9.3 宿主均完成 `initialize` 和 `session/new`，得到 Session client 与模型能力后正常终止。检查复用此前打包的适配器、缓存 0.2.1-rc.2 依赖和仅使用缓存的 npx shim，不发送模型请求，不使用真实凭据或内置 MCP server；不验证 npm 冷安装、新安装包或原生 Windows/Linux。

一次 Electron 宿主经 VitePlus Node shim 的检查触发原有五秒前置期限；不改配置的下一次相同检查成功，直接使用 Node 24.22.1 的 PATH 对照也成功。这证明该次超时后可以重试恢复，不代表冷启动或慢速 Node 管理器路径已经验收。

根目录 `pnpm check` 停在未改动的 Codex 适配器构建：复用依赖中的 ACP SDK 版本较旧，缺少新要求的 `@agentclientprotocol/sdk/unstable` 与 `experimental/v2/unstable` 导出。Effect lint 也因缺少 `@effect/tsgo` 无法执行，不能称为全仓检查通过。Magpie 启动测试改用临时 DSH 目录，避免写入用户目录。

当前工作区最初没有依赖和已初始化的适配器；验证复用现有依赖安装，并初始化固定版本子模块。本次不下载或全局安装 Node，不升级 Harness、不降级 Electron、不修改用户配置，也不提交会话原文。原生 Windows/Linux 和签名安装包验收仍需独立验证。
