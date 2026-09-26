# 让 Agent 的 `gh` 始终走 Lody 包装脚本和本会话的 broker

Status: implemented
Translation: current

[English](2026-09-26-gh-shim-broker-and-path.md)

## 摘要

GitHub 仓库里的长时间 Agent 会话大约一小时后，每次 `gh` 调用都返回 HTTP 401，而
`git push` 一直正常。原因是两个缺陷叠加：Agent 的 PATH 把系统 `gh` 排在 Lody 的 `gh`
包装脚本前面，于是 `gh` 一直读会话启动时的安装 token，直到过期；即使直接调用包装脚本，
它也忽略了本会话按工作区划分的 broker 状态文件，找不到重启后的凭据 broker。现在每个
Agent PATH 都把包装脚本目录固定在最前，包装脚本解析 broker 的方式与 git 凭据助手完全
一致，并在 broker 连不上时往 stderr 写出失败地址。会话仍然注入 `GH_TOKEN`，所以绕过
包装脚本的 `gh` 仍可能拿到过期 token。

## 证据

在一台 Linux 主机的 Claude Code 会话中观察到：

- Agent 的 `GH_TOKEN` 是 `ghs_` 安装 token，SHA-256 与 `LODY_MANAGED_GH_TOKEN_SHA256`
  一致，即会话启动时的副本。安装 token 约一小时过期；`refreshGhTokenForSession` 的
  每轮刷新只更新 Session 的配置 env，已在运行的 Agent 进程看不到。
- `~/.lody/bin` 是 PATH 第 21 项，排在第 17 项 `/usr/bin` 之后。会话 env 先把包装脚本
  放到最前，但随后 `mergeLoginShellEnv` 把登录 shell 的 PATH 放在前面，
  `withDefaultAcpPathEntries` 又前置了 `~/.local/bin` 等目录。
- `BASH_ENV=~/.lody/bashenv` 会重新前置包装脚本，但 Claude Code 的 shell 工具随后 source
  自己的快照，其中 `export PATH=…` 整体替换了 PATH。在同一台主机上，快照 PATH 等于 Agent
  进程 PATH 末尾再加一个插件目录，所以 Agent shell 得到的就是进程 PATH 的顺序。
- 直接调用包装脚本仍拿不到 token：broker 重启后，会话里的 `LODY_GIT_CRED_BROKER_URL`
  拒绝连接，新地址只写在 `LODY_GIT_CRED_BROKER_STATE_FILE` 指向的文件里。git 凭据助手
  优先读这个文件（#8 加入），包装脚本只读共享的 `broker.json` 路径。随后包装脚本不带 token
  运行 `gh`，也不输出任何信息，`gh auth status` 看起来只是未登录。

## 决定

- `agent/setting.ts` 的 `pinGhShimBinDirFirst` 在 `mergeLoginShellEnv` 和
  `withDefaultAcpPathEntries` 中都把包装脚本目录移到最前。它只移动已存在的条目，从未
  包含包装脚本的 env 不受影响。之所以在合并函数里保证，而不是在每个启动点，是因为 ACP
  启动、ACP 认证、Session 的 `buildShellEnv` 和终端 PTY 都组合了这两个函数。
- 包装脚本的 `BROKER_STATE_PATHS` 以 `LODY_GIT_CRED_BROKER_STATE_FILE` 开头；broker 请求
  失败时向 stderr 写一行，列出尝试过的所有 URL 和错误码，然后像以前一样不带托管 token
  继续执行。

## 备选方案

- **不再注入 `GH_TOKEN`，完全依赖包装脚本。** 绕过包装脚本的 `gh` 会立即失败而不是一小时
  后才失败，更容易诊断。暂缓：注入的 token 也是会话中非包装脚本消费者读取的（使用
  `GH_TOKEN` 的脚本和 SDK、没有 `BASH_ENV` 的 Windows shell），`ghTokenInjected` 标志控制
  每轮刷新和用户 token 检测；包装脚本固定在最前、broker 可恢复之后，剩余的绕过路径很窄。
  如果包装脚本排在 PATH 最前时仍出现过期 token 的 401，再重新评估。
- **只修 `BASH_ENV`。** 否决：Agent shell 可能在 source 它之后替换 PATH，Claude Code
  的快照就是这样。

## 验证与局限

- `tests/agent-setting.test.ts` 用带包装脚本前缀的会话 PATH 组合
  `withDefaultAcpPathEntries(mergeLoginShellEnv(…))`，断言包装脚本目录在最前。
- `tests/gh-shim-script.test.ts` 让生成的包装脚本连接一个会被拒绝的回环端口：有状态文件时
  从重启后的 broker 取到 token；没有时在 stderr 写出失效 URL 和 `ECONNREFUSED`。两条测试
  在没有修复时都失败。
- 如果登录 shell 的 rc 文件在 Claude Code 快照中前置了一个自带 `gh` 的目录，仍可能遮住
  包装脚本；尚未观察到。
- 包装脚本集成测试按 CommonJS 加载生成的脚本。临时目录的祖先目录里若有
  `"type": "module"` 的 `package.json`（某台主机上的 `/tmp/package.json`），Node 会按 ESM
  加载，所有包装脚本测试都会失败；请使用干净的 `TMPDIR` 运行。
