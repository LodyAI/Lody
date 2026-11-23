# Windows 下保持 DSH 后台子进程无窗口

Status: implemented
Translation: current

[English](2026-09-22-dsh-windows-console-popups.md)

## 摘要

尽管 Lody 隐藏了直接启动的 ACP 子进程，DSH 仍可能反复弹出 Windows 控制台。
锁定版本的 npm／DSH 启动链还会创建后代进程，DSH 的 Job 执行器也直接调用了
未设置无窗口标志的原生进程 API。现在由宿主在这些启动边界内抑制控制台，保留
标准输入输出、环境、退出处理和 Job 约束。macOS 上的合成进程测试已通过，
Windows 打包应用实测仍是验收项。

## 证据与决策

问题诊断记录显示 Windows 上启动 DSH、数次取消草稿预热，随后成功完成 ACP
初始化和会话建立。记录不足以证明预热存在无限循环；切换选择或上下文本就可能
取消预热，因此本次不改变该生命周期。不提交捕获的日志或用户／会话标识。

检查锁定的 `@deepseek-ai/dsh@0.1.5-rc.2` 依赖闭包发现：

- Node 转发器没有设置 `windowsHide`；npm 的 `@npmcli/run-script` 创建 shell
  时也没有设置。隐藏 Lody 的直接子进程不会自动传递给后代。
- `dsh-subprocess-local/lib/index.js` 启动 Windows Job 执行器时未设置
  `windowsHide`，其 fallback 子进程路径则已设置。
- `dsh-win32-process/lib/index.js` 用标志 `1028`（挂起启动加 Unicode 环境）
  调用 `CreateProcessW`，未包含 `CREATE_NO_WINDOW`；STARTUPINFO 仅配置
  标准输入输出，没有隐藏窗口。仅修正 Node spawn 无法覆盖这一原生调用。
  微软的[进程创建标志文档](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)
  说明了无窗口标志。

本次补充[Windows 命令行长度修复](2026-09-21-dsh-windows-command-length.zh.md)：
对选中的 npm JavaScript 入口添加仅 Windows 生效的 import 前置代码，转发器
显式隐藏子进程，DSH 引导程序在导入上游代码前安装同样的异步 spawn 策略。
拦截 `ChildProcess.prototype.spawn` 可覆盖规范化后的 CJS／ESM spawn、execFile
和 fork 调用，无须改写函数重载。守护进程和其他提供商不安装此策略。

Windows 引导程序包装锁定版本的原生绑定表，仅为 `CreateProcessW` 和
`CreateProcessAsUserW` 增加 `CREATE_NO_WINDOW`。对精确匹配的 Job 执行器，
通过 Node 参数传入相同前置代码；普通代理命令和 MCP 服务不会收到 `NODE_OPTIONS`
钩子。匹配执行器前先解析依赖闭包的真实路径，因为 Node 导入会解析符号链接。
不改写上游源码、npm 缓存或版本，也不降级进程约束。保留挂起创建、Job 分配、
令牌处理、IPC 和所有标准输入输出载体。POSIX 启动行为保持不变。

此兼容代码依赖锁定闭包的执行器路径及原生绑定 API；升级 DSH 时应重新核对。
原生 npx 可执行文件仍使用已有的直接启动路径，npm 前置代码针对标准 npm JS
安装。待锁定版本包含上游修复后，应优先使用上游实现。

## 验证

扩展现有运行时套件，以完整包参数执行合成 npm／DSH 模块和真实 Node 子进程。
观察器记录规范化的 spawn 选项，原生 API 夹具暴露完整创建参数。测试覆盖两种
平台策略、独立 Job 执行器、参数和原生标志保留、重复子进程的成功输出，以及
stderr／非零退出码传递；保留缺失 npm、npm 失败、配置及压缩格式检查。
测试均为确定性的本地测试，不证明 Windows GUI 行为或原生 FFI 执行。
Windows 打包应用验收应覆盖冷启动、能力刷新、重复执行命令及取消操作。

`pnpm check`、`pnpm format` 和 `pnpm run docs check` 均已在 macOS 上通过。

## 集成

- [Lody PR #891](https://github.com/LodyAI/Lody/pull/891)
