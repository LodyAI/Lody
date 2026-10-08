# 以 Lody 运行时启动 GitHub 凭据适配器

Status: implemented
Translation: current

[English](2026-10-08-github-host-node-runtime.md)

## 摘要

Lody 生成的 Git 与 gh 适配器通过 PATH 中的 `node` 启动，桌面主机没有 Node 时，托管 GitHub
checkout 会在 Agent 启动前失败。它们现在改由运行 CLI 的运行时重新执行，并保留 Electron 的
Node 模式，不改变用户工具看到的 `node`。测试已编写但作者 Agent 未运行，也未在打包后的
macOS 或 Windows 上运行。

## 证据

已在 macOS 确认：PATH 只含系统目录时，生成的 Git 包装脚本以 127 退出
（`env: node: No such file or directory`）；显式 Node 运行同一文件则输出 Git 版本。桌面应用以
`ELECTRON_RUN_AS_NODE=1` 在 Electron helper 中运行 CLI。Git 包装脚本、HTTP 适配器和 gh shim
使用 `#!/usr/bin/env node`；凭据 helper 执行 `!node`，诊断 helper 探测直接启动 `node`。
Windows 的 `.cmd` 启动器原本就使用 `process.execPath`。

## 决策

`lib/host-node-launcher.ts` 为 Git 包装脚本、HTTP 适配器和 gh shim 生成两行 sh/CommonJS 前导：
sh 以带引号的运行时路径重新执行文件（并设置 Electron 的 Node 模式），Node 把第二行读作指令加
注释。文件名、`__filename`、`.cmd` 入口和基于 vm 的测试不变。凭据 helper 命令与诊断 helper
探测使用同一运行时。

未采用：绝对路径 shebang 无法容纳 `Lody Helper.app` 路径中的空格，也不能设置 Electron 模式；
独立 sh 启动器加 `.cjs` 主体会增加文件并破坏 gh shim 基于 `__filename` 的自我排除；把 Lody
运行时加入 PATH 会替换用户自己的 `node`。只改变 Lody 自有启动器。

限制：生成文件内嵌运行时路径，每次托管预准备都会重写，应用位置变化在下一个会话生效。Windows 上
经由 Git for Windows sh 的执行未验证。

## 验证

回归测试在空 PATH、带空格的运行时路径和两种运行时模式下运行生成脚本、Git 包装脚本、两个 HTTP
适配器、gh shim 与真实 `git credential fill`。作者环境未执行这些测试。相关：
[按命令选择凭据](../architecture/2026-09-26-github-command-credentials.zh.md)、
Issue [#1307](https://github.com/LodyAI/Lody/issues/1307)。
