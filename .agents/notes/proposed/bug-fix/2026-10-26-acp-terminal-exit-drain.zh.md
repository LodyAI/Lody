# 限制 ACP 命令退出后的输出排空时间

Status: proposed
Translation: current

[English](2026-10-26-acp-terminal-exit-drain.md)

## 摘要

ACP terminal 原来等待 Node 的 `close`；继承 stdout/stderr 的后台后代会在命令退出后继续阻塞 agent 回合。
修复在直接进程 `exit` 时记录状态，等待 `close` 或 100 ms 排空窗口，再保留原有资源检查并完成 waiter。
kill/release 在排空期间也能识别命令已经退出，避免杀死其后台后代。
100 ms 用于保留普通尾输出，不保证长期后台任务的所有未来输出；此方案仍待审阅，也不限制资源检查本身耗时。

## 边界与决策

[Issue #1270](https://github.com/LodyAI/Lody/issues/1270) 及贡献者的
[参考 diff](https://github.com/Dante-dan/Lody/compare/86e0da5ee125d911d097210dda6ac4d382230c1a...cbea5f4adfc81798d21f6d1bf51ba693ba08face)
指出相同的事件错配。当前 sandbox 已独立缓存和重放 exit/close，无需修改。
本修复延续[命令启动决策](../../implemented/bug-fix/2026-09-12-acp-terminal-unsplit-command-line.zh.md)。

manager 拥有输出缓冲、订阅、单个排空计时器和 waiter。直接退出状态只记录一次；
排空完成单独记录，避免后来加入的 waiter 跳过尾输出。close 可提前完成，或在没有 exit 时提供兜底状态。
单次报告标记避免重复资源检查并取消计时器。release 清理订阅和计时器，以已记录状态完成所有 waiter，
活动命令则使用 SIGTERM 兜底，随后删除 terminal。空 manager 的重复 dispose 无操作；已释放 id 保持原有 not-found 行为。

取消通过 kill/release 继续使用 sandbox 终止活动命令。观察到直接退出后，包含排空期间，
kill/release 均不能终止其后台后代。排空超时只完成本地等待，不宣称整棵进程树终止，也不创建替代 owner。
session sandbox 保留原有进程所有权和关闭策略。资源检查或回调失败通过原有错误 hook 记录，
不会覆盖已知退出码和信号。没有新增失败栅栏、重试 owner 或保留 map；独立 terminal 的计时和清理互不阻塞。

已按 feature/fix 模式评估 Effect 4.0.2 原生迁移。manager 仍依赖已登记的 Promise sandbox facade
和 Session 资源限制回调；迁移其所有权会扩展到尚未迁移的 Session 编排链。
本修复保留该适配边界，不新增 Effect runtime/facade，也不改变迁移 ledger。

## 验证与简化

terminal 原有套件独立控制 exit/close 并推进假时钟，覆盖有界返回、两路尾输出、原始状态、
排空期间新增 waiter、kill/release、启动错误及资源检查失败。
真实 POSIX shell 启动一个被 FIFO 阻塞的后台后代；测试观察实际 exit，只推进排空计时器，
确认管道尚未关闭就已返回。测试先执行 kill/release，再写入 FIFO；后代输出 `background survived` 并关闭管道。
FIFO 控制描述符使用 O_RDWR，避免回归误杀 reader 时清理阻塞在打开管道。不使用真实 sleep 或网络。

删除仅断言 mock 调用的命令路由/终止测试，以真实命令输出、argv 和含空格路径测试保留可观察边界覆盖。
macOS 复现不代表 Windows 执行和 Linux cgroup 已验收。
PR 提供红绿命令、截图、消融对照与检查结果；临时消融不进入最终源码。

同一组 15 项测试分别验证 baseline `91fa467a` 的生产源码、临时消融版本和简化后的修复：

| 删除或简化的设计 | 结果 |
| --- | --- |
| 整个修复（baseline） | 退出 1；6 项失败、9 项通过，包含真实 FIFO 回归。 |
| 排空截止计时器 / 将窗口从 100 ms 改为零 | 均退出 1；分别 3 / 2 项失败。 |
| close 提前完成 | 退出 1；3 项失败。 |
| waiter 独立排空完成状态 | 退出 1；排空期间加入的 waiter 提前完成。 |
| 首个退出状态保护 | 退出 1；3 项退出码、信号、错误保留用例失败。 |
| 单次报告标记 | 退出 1；迟到 close 导致资源限制通知重复。 |
| release 取消计时器 | 退出 1；释放后残留计时器。 |
| 资源检查保存的原始状态 | 退出 1；close 信号导致原始资源限制通知丢失。 |
| dispose 标记赋值 / exit 入口保护 | 均退出 0、15 项通过；均已从最终修复删除。 |
| 简化后的修复 | 退出 0；15 项全部通过。 |

这些设计仅涉及各 terminal 的状态和适配回调，没有新增导出抽象、service、facade、重试或栅栏。
清理沿用 sandbox 事件订阅边界；其 unsubscribe 可幂等执行。

验证使用独立 clone、锁定依赖/子模块和 Node 26.12.1（Node-API 10），不在原 nested checkout 安装。
最终完整检查执行到 CLI 测试：4,657 项通过、4 项跳过；一项无关的相对 global Git identity 测试失败，
换回 baseline 生产源码仍相同失败（该独立套件两侧均 1 失败、9 通过）。格式化通过。
Docs check 在两侧均报告旧双语 subagent note 指向 Pi 中不存在的 `src/subagents.ts` 的两处链接；
没有登记受 SHA 保护的主题。这些限制如实报告，不扩展本 issue 修复。
