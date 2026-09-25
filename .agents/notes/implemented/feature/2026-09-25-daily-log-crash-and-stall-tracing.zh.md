# 在每日日志中追踪桌面端、CLI 退出与事件循环卡顿

Status: implemented
Translation: current

[English](2026-09-25-daily-log-crash-and-stall-tracing.md)

## 摘要

一位 0.100.0 用户报告 Lody 每次启动都会关闭或断连。随报告提交的日志无法解释原因：Electron
主进程不写任何文件，CLI 60–90 秒的卡顿说不出是哪段代码，进程退出前写下的日志也会丢失。现在
Electron 主进程会把控制台输出、生命周期、崩溃和对内置 CLI 的监管写进 CLI 的每日日志。CLI
新增一个看门狗线程，在卡顿发生期间对主线程采样，并在退出和崩溃时同步写入标记行。这次改动
只增加证据，不改变任何重启、终止或超时行为。原生崩溃仍然只能表现为缺少退出记录。

## 问题与证据

报告附带的 `~/.lody/logs/2026-09-24.log` 等文件显示：

- 每个由 Electron 启动的 CLI 都反复出现 57–91 秒的定时器延迟，`cpuRatio≈1`。两次
  Homebrew daemon 处理同样的 Session，却没有一次卡顿。延迟日志只说明发生了卡顿，从不说明
  在运行什么。
- 每次 MCP host `host handshake timed out` 都紧跟在这样的卡顿之后。定时器先于待处理的管道
  I/O 执行，所以已经回应的 host 仍会被杀掉。日志无法把这种情况与 host 真的故障区分开。
- 三次桌面启动都在约 8 秒后结束，每次父 PID 不同，CLI 没有留下任何一行。Electron 主进程
  的输出只进 stdout，也不存在 `~/Library/Logs/Lody/main.log`，桌面为什么关闭无从得知。
- 报告里的 "OOM" 无法核实。V8 中止只写 stderr，而 stderr 只进了渲染进程的输出缓冲区，没有
  落盘。

## 决策

用一个文件 `<数据目录>/logs/<本地日期>.log` 讲清完整经过。共享模块
`@lody/shared/node/daily-log-file` 规定外部写入者如何追加：写入当天正在使用的轮转文件
（`<date>.log.<n>`，没有则 `<date>.log`），使用 CLI 的行格式，同步写入。

Electron 主进程（`desktop-log.ts`，在 `desktop-bootstrap` 确定 `userData` 后安装）：

- 安装失败时自动降级：出错只会停用日志，启动照常继续。打包入口的启动测试会在测试数据目录中
  运行真实的安装流程。
- 以 `desktop:<pid>` 作用域把 `console` 镜像到文件，终端照常输出。Bearer token 与凭据类
  查询参数会被脱敏，但这只是兜底。
- 记录启动横幅、`before-quit`/`will-quit`/`quit`/`exit`、`render-process-gone`、
  `child-process-gone`、电源休眠/恢复、≥2 秒的主线程定时器延迟，以及
  `uncaughtExceptionMonitor`。用 monitor 变体是为了不改变 Electron 默认的崩溃处理。
- 在 `userData` 中保存运行记录，只在拿到单实例锁之后写入。下次启动时如果记录没有
  `cleanExit`，就记为异常结束。
- 追踪每个内置 CLI：启动（只记子命令和参数个数，因为渲染进程传入的参数可能含凭据）、每一行
  stderr、退出码/信号/终止类型/存活时长、Supervisor 的每次退出决策，以及每次 Supervisor
  状态变化。子进程仍在却处于 `reconnecting`，说明 CLI 没有应答探测，界面上表现为断连。

CLI：

- `event-loop-stall-profiler.ts`：主线程定时更新 SharedArrayBuffer 心跳。worker 线程发现
  心跳超过 4 秒未更新时，通过 `inspector.Session.connectToMainThread()` 附着，在卡顿期间
  采样 3 秒 CPU，再追加自身耗时、包含耗时和最热调用栈。每次卡顿、每分钟最多一份，每个进程
  最多 20 份。在 `lody start` 一开始就启用，启动阶段的卡顿也能被记录。设置
  `LODY_EVENT_LOOP_STALL_PROFILER=0` 可关闭。
- 延迟监控在每条卡顿日志中加入 V8 堆上限，并在用量达到上限的 70/85/95% 时各警告一次。这样
  OOM 中止前的增长过程会留下记录。
- `process-exit-trace.ts`：为 `lody start` 同步写入 `[process-exit]`。所有 CLI 进程（包括
  平时写独立日志文件的 MCP host）在处理未捕获异常、开始清理之前，都会同步写入
  `[process-fatal]`。
- MCP host 握手超时会记录 pid、已耗时和定时器延迟；host 退出会记录信号和存活时长。

## 备选方案

- **在 `~/Library/Logs` 下另建桌面日志。** 未采用：bug 报告和 `lody daemon logs` 读取的
  都是每日日志，而这次恰恰是跨两个文件对照 PID 失败了。
- **Electron 主进程使用异步或 winston 写入。** 未采用：最重要的日志行出现在进程死亡之前，
  排队中的写入会丢失。
- **只在卡顿结束后归因（查看卡顿期间未结束的 trace span）。** span 只覆盖有埋点的 await，
  而这些卡顿是同步 CPU 计算。卡顿期间采样才是唯一的直接证据。
- **始终开启 CPU profiling。** 因持续开销而未采用。看门狗在卡顿发生前一直空闲。
- **单独打包 worker 入口。** 改用 eval worker。三个命名/格式化辅助函数通过
  `Function.prototype.toString()` 内联，因此必须保持自包含（共享模块中已注释说明）。这样就
  不需要新增 `*-worker.js` 布局约定。

## 验证与限制

- `event-loop-stall-profiler.test.ts` 真实阻塞主线程，直到 worker 写出 profile，再断言
  结果点出了阻塞代码和当前轮转文件。延迟监控和桌面日志测试使用注入的时钟。
- 从 Vite 构建产物中提取的 profiler 分别在 Node 24 和 Electron 39.5.1
  （`ELECTRON_RUN_AS_NODE=1`，Node 22.22.0，与用户运行时一致）下运行。两者都在约 30 ms 内
  附着，并定位到阻塞帧。尚未在已签名打包的 macOS 应用中验证。
- SIGKILL、V8 OOM 中止和原生崩溃本身仍然写不出任何内容。它们表现为缺少 `[process-exit]`
  行、Electron 端的退出记录和 stderr 行，或一条异常运行记录。原生调用栈仍需依靠 macOS
  崩溃报告。
- 多个进程追加同一个文件。每次追加只有一行左右并使用 `O_APPEND`；轮转仍由 winston 负责，
  外部写入者跟随它找到的当前轮转文件。
- 握手定时器仍可能杀掉已经回应的 host。追踪让这种情况可见；是否修改超时行为是另一项决策。
