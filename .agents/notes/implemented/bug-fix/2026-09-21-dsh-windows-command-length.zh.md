# 绕过 DSH 启动时的 Windows 命令行限制

Status: implemented
Translation: current

[English](2026-09-21-dsh-windows-command-length.md)

## 摘要

Lody 锁定的 DSH 依赖展开后产生超过 12,000 字符的命令行，超出 Windows
cmd.exe 的 8191 字符限制。npx 脚本在 ACP 初始化前退出，最终表现为
`ACP connection closed` 和 `turn_pre_prompt_failed`。会话及能力探测／标题生成
现在使用 Lody 的 Node 执行 npm 的 JavaScript npx 入口，保留依赖版本锁定和
现有 npx 恢复逻辑。进程回归使用合成包，仍需验证 Windows 原生打包环境。

## 决策

缓存隔离、冷启动分类和重试仍使用逻辑上的 `npx` 命令及完整包参数。在每次
Windows DSH 实际创建进程时，根据最终环境的 PATH/PATHEXT 和工作目录选择
npx，再用 `process.execPath` 执行其相邻的
`node_modules/npm/bin/npx-cli.js`。保留继承的 `ELECTRON_RUN_AS_NODE`。
原生 `.exe`／`.com` 启动器本身不经过 shell；脚本启动器缺失 npm 入口时明确
报错，不转而选择另一个安装。其他 provider 和 POSIX 启动保持原有行为。

`Session.createAgent` 与 `spawnAcpProcess` 共用转换，因此普通对话、能力探测
和标题生成均包含修复。npm 继续安装完整的精确版本依赖并调用现有的短 Node
转发器；DSH 仍在 Lody 运行时中调用 `runCli()`。不向生成文件或测试样本写入
凭据或用户日志。

本修复补充了[内置 Node 修复](2026-09-16-dsh-bundled-node-runtime.zh.md)，后者
处理 `import.meta.main` 兼容性而非命令长度。改为新的依赖清单／缓存安装协议
需要替换已有恢复行为；仅转换实际启动入口避免了更大的改动。非标准且仅支持
shell 的 npx 包装器需要提供标准 npm 安装或使用原生启动器。

## 验证

所属运行时测试通过合成 npm JavaScript 入口、现有 Node 转发器以及合成 DSH
`runCli()` 入口实际执行完整参数列表，验证参数完整保留、缓存环境、选定运行时
及 profile 参数，并覆盖带空格的安装路径。失败场景验证 npm 非零退出码及
诊断传播、入口缺失和 npx 缺失时的拒绝，测试不访问网络。同一测试集保留
POSIX 引导回归。将其视为发布验证前，仍需检查 Windows 原生打包执行。

在 macOS 上，`pnpm check`、`pnpm format` 与 `pnpm run docs check` 均通过。

## 集成

- [Lody PR #871](https://github.com/LodyAI/Lody/pull/871)
