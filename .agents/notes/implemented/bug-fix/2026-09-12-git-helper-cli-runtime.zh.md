# 在 CLI 自身运行时下执行 git 凭据助手

Status: implemented
Translation: current

[English](2026-09-12-git-helper-cli-runtime.md)

## 摘要

在从 Dock 启动桌面端的 Mac 上，GitHub 仓库 Session 无法启动：令牌预取和凭据
Broker 都成功，但 git 以 `terminal prompts disabled` 中止了 bare clone，对外表现
为 `turn_pre_prompt_failed`。根因是 `credential.helper = !node "<helper.cjs>"` 这一
依赖 PATH 查找的写法——从图形界面启动的应用继承的是 Dock 的最小 PATH，其中通常
没有 `node`，于是助手根本没有运行，git 在 `GIT_TERMINAL_PROMPT=0` 下也就拿不到
用户名。现在 Lody 改为用 `process.execPath` 构造助手命令并对两个词都加引号，诊断
探针也以同一运行时启动，并在 CLI 就是 Electron 可执行文件时为 git 子进程设置
`ELECTRON_RUN_AS_NODE=1`。容器内的助手仍使用 `node`，因为镜像里的 PATH 上有它。

## 决策与归属

CLI 在 CLI/MCP/适配器以及 watch worker 的子进程启动中早已用这种方式解析自身的
Node（`agent-client.ts`、`workspace-watch-coordinator.ts`）；宿主机 git 凭据助手是
最后一个仍依赖环境 PATH 的子进程。让它与其余部分保持一致，优于考虑过的两个替代
方案：

- **内嵌第二份 Node 运行时**或在 `~/.lody/bin/node` 建符号链接：增加安装体积和
  一条更新路径，还会引入一个宿主机可写、且会被 git 执行的可执行文件。
- **从登录 shell 解析 PATH**：CLI 确实已有登录 shell 环境的辅助能力，但它慢、依赖
  用户的 shell 配置，而且对根本没有安装 `node` 的用户仍然失败——而打包桌面端的
  用户本来就可能属于这一类。

有两个细节不是可选项。两个词都加引号，是因为安装目录中含有空格（`Lody Helper`、
`Program Files`）；在 Windows 上反斜杠要改成正斜杠，因为 git 通过随附的 MinGW bash
执行 `!` 形式的命令，其中 `\` 是转义符而非路径分隔符。`ELECTRON_RUN_AS_NODE` 必须
同时到达 git 子进程、探针和 ACP Session 环境，否则 `process.execPath` 会再启动一个
GUI 应用，而不是执行助手脚本。

诊断探针（`runCredentialHelperProbe`）存在同样的 `spawn('node', …)` 缺陷，其影响是
双重的：在受影响的机器上，探针报告的是启动进程失败而不是 Broker 的判定结果；而在
恰好 PATH 上有 `node` 的机器上，探针会用一个 git 从未使用过的运行时取得成功，反而
掩盖了正在被诊断的缺陷。[worktree/AGENTS.md](../../../../apps/cli/src/session/worktree/AGENTS.md)
中的 Broker 路由规则没有改变；这是一个表征相同、原因不同的故障，因此今后看到
`terminal prompts disabled` 需要区分两种不同的成因。

## 验证

`git-credential-helper-script.test.ts` 用生成出来的助手命令实际运行
`git credential fill`：助手放在含空格的目录下，并在 PATH 前置一个必然失败的 `node`
垫片——以此复现 Dock 的环境，而不依赖本机真实的 PATH。回滚该修复会重现线上完全
一致的报错 `fatal: could not read Username for 'https://…': terminal prompts disabled`。
Windows 的分隔符规则由字符串格式断言覆盖，因为该集成测试需要 POSIX 垫片、在 win32
上跳过；Windows 桌面端的原生启动仍未验证。

`worktree-manager-broker-auth.test.ts` 覆盖宿主机 git 的参数、探针的启动命令以及
`ELECTRON_RUN_AS_NODE` 的传递；`session-manager.test.ts` 覆盖 `GIT_CONFIG_VALUE_1`
以及 ACP Session 环境上的同一个标志。每条新增断言都针对修复前的代码单独做过消融，
缺少修复即失败。测试在 macOS 上以 Vitest 3.2.4 运行。
