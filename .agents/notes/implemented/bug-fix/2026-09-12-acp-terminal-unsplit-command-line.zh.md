# 接受未拆分的 ACP 终端命令行

Status: implemented
Translation: current

[English](2026-09-12-acp-terminal-unsplit-command-line.md)

## 摘要

ACP `terminal/create`传递的是可执行文件加 argv，但有些 Agent 会把整条 shell 命令行放进
`command`、并让 `args` 为空；按字面 spawn 会以 `ENOENT` 失败，而这个失败根据 sandbox 的不同
要么不可见、要么致命——Linux 上暴露为未分类的 errno `-2`，使 Agent 直接丢弃会话；darwin 上则
返回一个 `wait_for_exit` 永不完成的 terminal id。现在 Lody 仍按协议原样 spawn 这一对参数，只
在上述这一种形态（`args` 为空、`command` 含空白、该路径上没有文件）下重建命令，交给非交互、
非登录的 `sh -c`（Windows 上为 `cmd.exe /c`）执行。若 spawn 仍然失败，`terminal/create` 会带
JSON-RPC 错误码拒绝，并记录退出状态，因此不会有等待方被挂起。除文件检查之外，这个回退无法
分辨"确实只有一个含空格的可执行文件"与"未拆分的命令行"，所以它刻意保持狭窄，而不是变成一种
通用的 shell 模式。

## 问题与归属

按 Agent Client Protocol，拆分命令行是 Agent 的职责，而进程执行由
`ShellTerminalManager` 负责。因此这里的兼容处理是执行边界上的互操作，而不是修正 Lody 对协议
的理解：`command` + `args` 仍然是契约，也仍然是默认路径。

同一次调用里叠加了两个不同的缺陷。第一个是解析：cross-spawn 把 `ls -al` 当作 `argv[0]`，而
操作系统并没有这样一个可执行文件。第二个是上报。`sandbox.spawn` 在各平台上的行为并不一致——
cgroup sandbox 会等待子进程 pid 并因此 reject，而 POSIX 回退实现会先把 handle 解析出来，让错误
稍后从进程错误通道到达。终端的 `onError` 钩子当时只记录日志，因此这个迟到的错误什么也没有收
敛：`createTerminal` 早已返回 id，而 `waitForTerminalExit` 会永远等下去。两个平台因此需要同一个
有类型的答复。

## 决策

三处改动，每一处都很窄：

1. `resolveTerminalSpawnTarget` 只在 `args` 为空、`command` 含空白，且 `stat` 在相对于 workdir
   的该路径上找不到文件时才重建命令。正是这个文件检查保住了路径中含空格的可执行文件；
   `args.length > 0` 永远不会被包裹，因此已经自行拆分好 argv 的调用方保持完全一致的 spawn 语义。
2. `waitForSpawnConfirmation` 在 pid 尚未就绪时等待子进程 pid，于是 spawn 失败会让
   `createTerminal` reject，而不是对外发布一个永远无法退出的终端。已经启动的进程在这里没有任何
   代价：Node 会同步赋值 `pid`，检查随即返回。
3. `ENOENT`/`EACCES` 会转成 `TerminalSpawnError`，再由 `AgentClient.createTerminal` 答复为
   `acp.RequestError.invalidParams`（`-32602`）。无法执行的命令属于错误的请求，而一个数值化的
   JSON-RPC 错误码才能让 Agent 报告这次失败，而不是把它当成连接已断。终端的 `onError` 钩子现在
   也会记录退出状态，因此启动成功之后才发生的进程错误会让等待中的调用完成，而不是被挂起。

选择 `sh -c` 是有意的。`bash -lc` 会执行用户的登录 profile，在 Agent 只是想在会话自身环境中运行
一条命令的情况下改变 `PATH`、shell 选项和环境变量，而且在没有 bash 的机器上还会直接失败。

另外，`resolveCustomACPSetting` 现在会展开自定义 Agent 启动命令开头的 `~`：它由人手工填写，而
`spawn` 并不会展开它。终端命令行被刻意排除在外：那些命令来自 Agent，而当 shell 回退真正运行时，
它自己已经会展开 `~`。

## 备选方案

- 只要 `args` 为空就包裹，不做文件检查（[#470](https://github.com/LodyAI/Lody/pull/470)）。
  更简单，但会把路径中含空格的可执行文件送进 shell，于是引号和元字符开始作用在一条 Lody 本应
  原样接收的路径上。
- 在 Lody 内部拆分命令行并直接 spawn `argv[0]`。这需要一个在引号、转义和运算符上都与 shell 一致
  的解析器；`sh` 已经有一个，而 Agent 写下的那条命令行本来就是给它的。
- 只把失败作为终端输出加非零退出码上报。这样 Agent 会看到一个"运行过"却没有有用输出的终端，
  而会话层面的原因仍然不可见。

## 验证

`apps/cli/tests/terminal-manager.test.ts` 用 stub sandbox 覆盖 spawn 决策——POSIX 与 Windows 上的
未拆分命令行、保持原样的已拆分 argv、路径中含空格的可执行文件、已经带有 args 的命令行、两种
spawn 失败形态（sandbox reject 与迟到的错误通道），以及由进程错误完成的挂起等待——另外通过
`createNoopSessionSandbox` 覆盖两个针对真实进程的 POSIX 用例：一条未拆分的 `printf` 命令行能取回
输出与退出码，以及一个无法解析的可执行文件会 reject 而不是发布终端。`~` 展开由
`apps/cli/tests/agent-setting.test.ts` 覆盖。消融验证：去掉文件检查会让含空格路径的用例失败，去掉
spawn 确认会让迟到错误的用例失败，去掉 `onError` 的退出状态记录会让等待用例一直挂到超时。

此处未验证：真实发送未拆分命令行的 Agent（报告者使用的 `codebuddy-code`），以及真实 Windows 主机
上的 `cmd.exe` 行为——Windows 分支仅通过注入的 platform 覆盖，针对真实进程的用例在 Windows 上会被
跳过。

PR：[#645](https://github.com/LodyAI/Lody/pull/645)，关闭
[#469](https://github.com/LodyAI/Lody/issues/469)。
