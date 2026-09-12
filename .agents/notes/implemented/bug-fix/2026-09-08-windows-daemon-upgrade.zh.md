# 通过 npm 命令脚本启动 Windows daemon 升级

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/488

[English](2026-09-08-windows-daemon-upgrade.md)

## 摘要

远程 daemon 升级在 Windows 上选择了 `npm.cmd`，却直接交给 Node 原生 spawn 执行，
而命令脚本需要解释器才能运行。升级现在复用 CLI 已有的 `cross-spawn` 依赖，处理
Windows 命令脚本的解析和转义。测试使用合成 npm 可执行文件验证安装参数、成功和失败
结果以及升级意图清理，不实际安装包。本地尚未验证 Windows 执行和已部署机器的远程升级。

## 决策与范围

复用 CLI agent 和进程工具已经使用的跨平台启动器，避免另写命令行转义逻辑或在所有平台
启用 shell。包名、registry、目标版本校验、超时、取消和 watchdog 交接代码保持不变。
这是对现有 Windows 行为的修复，不改变产品意图或协议。

生命周期确认响应发送失败后可能卡在 pending 的问题，由同一 PR 中单独的
[ACK 修复](2026-09-08-machine-lifecycle-ack.md)处理。
未找到升级启动器的现有归属 Note。

## 证据与验证

- [Node 的 Windows 命令脚本文档](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
  说明了对解释器的要求。
- [实现](../../../../apps/cli/src/lib/machine-lifecycle.ts)使用已有依赖，无需修改 manifest 或锁文件。
- [回归测试](../../../../apps/cli/src/lib/machine-lifecycle-upgrade.test.ts)把 PATH 隔离到含空格的临时目录，
  Windows 执行 `.cmd`，POSIX 执行 shell 脚本，覆盖退出码 0 和 1。
- macOS 上的 10 项定向生命周期测试通过；允许已有本地 IPC 测试在沙箱外创建 socket 后，
  `pnpm check` 通过。测试不覆盖 registry 访问、原生模块替换、Windows 进程树取消
  或真实 watchdog 交接。
