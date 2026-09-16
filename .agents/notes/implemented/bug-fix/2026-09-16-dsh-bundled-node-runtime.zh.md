# 使用 Lody 内置 Node 运行 DSH

Status: implemented
Translation: current

[English](2026-09-16-dsh-bundled-node-runtime.md)

## 摘要

Lody 通过某些用户安装的 Node 版本启动 DeepSeek Harness 0.1.5-rc.2 时，因
`import.meta.main` 不可用而静默退出，能力刷新最终只显示 `ACP connection closed`。Lody
现在仍由 npx 准备并修复固定版本的依赖闭包，但改用应用内置的 Node 运行 DSH 入口，并显式
调用其导出的 CLI。包安装仍要求系统中有可用的 npx；DSH 执行本身不再继承用户 Node 的特性集。

## 原因与决策

已发布的 DSH 入口末尾使用了 `import.meta.main` guard。问题机器以 Node 24.1.0 启动时，
该属性为 `undefined`，所以命令以零状态退出，却没有启动 ACP。Lody 应用内置的 Helper 使用
Node 22.22.0 并提供该属性，但原来的 `npx ... dsh` 启动方式会让 npm 为可执行文件选择用户的
Node。

宿主现在让 npx 的 Node 运行一个极小的 CommonJS 转发器，即使 Lody Helper 路径含空格，也能安全
spawn `process.execPath`。该子进程中的小型 ESM bootstrap 从 npx 提供的 PATH 中找到
`@deepseek-ai/dsh`，核对其精确固定版本，恢复 DSH 预期的 `process.argv`，导入入口并显式等待
`runCli()`。在打包后的桌面应用中，`process.execPath` 是 Lody Helper；既有的
`ELECTRON_RUN_AS_NODE=1` 继承会让它以 Node 模式工作。保留 npx 外层启动，也保留了 Lody 自有
npm 缓存检查、冷启动超时、陈旧 metadata 重试和损坏安装恢复流程。

降级 DSH 会把修复绑定到较旧功能集，却不能建立稳定的 Node 兼容性契约。修改下载后的包还会
绕过包完整性与缓存恢复。上游直接入口修复仍然有价值，但宿主控制运行时依旧必要，因为桌面行为
不应随用户安装的 Node 变化。

## 验证

运行时回归测试构建了合成 npx 包闭包，在独立进程中执行生成的转发器与 bootstrap，并验证所选运行时
即使导入的模块不是 main module，也会使用精确的 profile 参数调用 `runCli()`。完整 CLI 测试通过：
266 个文件、2,849 项测试通过，3 项跳过。

macOS 真实探针使用已安装的 Lody Helper（Node 22.22.0）、缓存的固定版本 DSH
0.1.5-rc.2 闭包和生成的 Lody profile，成功返回 ACP `initialize` 响应并声明
`acp-extension-dsh` 0.2.0。Windows 与 Linux 原生打包探针仍待执行；bootstrap 使用 Node 的
跨平台路径分隔符和包路径，不依赖 shell launcher 解析。

## 集成

- [Lody PR #747](https://github.com/LodyAI/Lody/pull/747)
