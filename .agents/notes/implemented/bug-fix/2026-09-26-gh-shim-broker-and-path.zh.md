# 让 Agent 的 `gh` 始终走 Lody 包装脚本

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1026

[English](2026-09-26-gh-shim-broker-and-path.md)

## 摘要

GitHub 仓库里的长时间 Agent 会话大约一小时后，每次 `gh` 调用都返回 HTTP 401，而
`git push` 一直正常。Agent 的 PATH 把系统 `gh` 排在 Lody 的 `gh` 包装脚本前面，Agent
shell 从未调用包装脚本；系统 `gh` 一直读会话启动时的安装 token，直到过期。现在 PATH
合并会把本会话的包装脚本目录固定在最前。事故中同样涉及的包装脚本 broker 查找和全局
`GH_TOKEN` 注入，在本改动合入前已被 `main` 上的
[按命令选择 GitHub 凭据](../architecture/2026-09-26-github-command-credentials.zh.md)
（#1034）取代，所以本改动只保留 PATH 修复。

## 证据

在 #1034 之前，于一台 Linux 主机的 Claude Code 会话中观察到：

- Agent 的 `GH_TOKEN` 是会话启动时的 `ghs_` 安装 token（SHA-256 与
  `LODY_MANAGED_GH_TOKEN_SHA256` 一致）；安装 token 约一小时过期，每轮刷新到达不了已在
  运行的 Agent 进程。
- 包装脚本目录是 PATH 第 21 项，排在第 17 项 `/usr/bin` 之后。会话 env 先把包装脚本放到
  最前，但随后 `mergeLoginShellEnv` 把登录 shell 的 PATH 放在前面，
  `withDefaultAcpPathEntries` 又前置了 `~/.local/bin` 等目录。
- `BASH_ENV` 会重新前置包装脚本，但 Claude Code 的 shell 工具随后 source 自己的快照，其中
  `export PATH=…` 整体替换了 PATH。在同一台主机上，快照 PATH 等于 Agent 进程 PATH 末尾再加
  一个插件目录，所以 Agent shell 得到的就是进程 PATH 的顺序。
- 直接调用包装脚本仍拿不到 token：broker 重启后，会话里的 broker URL 拒绝连接，而包装脚本
  不读 git 凭据助手使用的按工作区状态文件，于是静默地不带 token 运行 `gh`，
  `gh auth status` 看起来只是未登录。

## 决定

当基础 PATH 以包装脚本目录开头时，`agent/setting.ts` 中的 `mergeLoginShellEnv` 和
`withDefaultAcpPathEntries` 会让该目录保持在最前（`getLeadingGhShimBinDir`）；
`prependGhShimBinDirToPath` 正是把本会话自己的目录放在那里。#1034 之后，包装脚本目录按
工作区 broker 划分（`gh-session-bin/<hash>`）。PATH 中其他位置的包装脚本目录可能属于另一个
工作区：在 Lody Agent 内启动的 daemon 会继承那个 Agent 的目录，daemon 的登录 shell PATH
也会带上它。早先的版本会提升找到的第一个 `gh-session-bin` 条目。评审发现这会让本会话的
`gh`/`git` 走另一个工作区的 broker，因此现在只认基础 PATH 开头的条目。之所以放在合并函数
里，是因为 ACP 启动、ACP 认证、Session 的 `buildShellEnv` 和终端 PTY 都组合了这两个函数。该目录
也包含生成的 `git` 传输包装，同样受益。

这个分支最初还让包装脚本优先读 `LODY_GIT_CRED_BROKER_STATE_FILE`，并在 broker 不可达时
输出错误。#1034 取代了这两点：daemon 把工作区 broker 的状态文件路径写死在每个包装脚本里，
子进程环境变量不能再选择 broker，缺少凭据时会给出明确错误。合并时保留 `main` 的包装脚本
不变。#1034 也不再注入启动时的 `GH_TOKEN`，这解决了本分支此前暂缓的那个选项。

## 验证与局限

- `tests/agent-setting.test.ts` 用带有某个工作区 broker 包装脚本目录的会话 PATH 组合
  `withDefaultAcpPathEntries(mergeLoginShellEnv(…))`，断言该目录在最前；登录 shell 带有
  另一个工作区的包装脚本目录时也是如此，而基础 PATH 并非以它开头时它保持原位。
- 如果登录 shell 的 rc 文件在 Claude Code 快照中前置了一个自带 `gh` 的目录，仍可能遮住
  包装脚本；尚未观察到。
- 包装脚本集成测试按 CommonJS 加载生成的脚本。临时目录的祖先目录里若有
  `"type": "module"` 的 `package.json`（某台主机上的 `/tmp/package.json`），Node 会按 ESM
  加载，包装脚本测试会失败；请使用干净的 `TMPDIR` 运行。
