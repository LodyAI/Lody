# Code Collab 刷新不再阻塞 turn 完成

Status: implemented
Translation: current

[English](2026-10-21-code-collab-turn-finalization-wait.md)

## 摘要

Code Collab 刷新 pending 时，已回复完的对话仍会保持收尾 presence，Stop 也可能再等同一队列。
正常、错误和取消收尾现在只发起刷新，不等待它完成。service 管理有时限、可配置的任务，把取消
传到扫描、Git 子进程和发布检查点。迟到结果不能继续写入旧快照，共享 Repo I/O 保留原 owner。
本次修复已复现的故障传播，没有声称找到报告者底层操作 pending 的原因。

## 证据与决定

诊断源码版本为 `a8cffe6f1be2a7b6983770afdebe5231b0a7ae10`。文档已经 idle，执行 lease
仍等刷新后才释放收尾 presence。合成 pending pre-sync 让正常收尾和取消收尾一起等待，
同 owner 共三个 waiter，其他 owner 可以前进。只有 refresh 开始、没有完成，不能区分工作区
解析、扫描、Flock open、flush、sync 或 signal 发布。本次没有用本机 daemon 日志为外部报告归因。

已有[显示决定](2026-10-06-finalizing-status-label.md)继续适用：必要 ACP drain 和本地 turn
证据仍归 turn，可选文件视图投影转给 service。提前清 presence 不能提供这个分离。

## 所有权与取消

- 后台入口处理同步抛错、异步 rejection。成功、错误和 Stop 的 turn 释放、结果通知、下一条输入
  都不依赖刷新完成。
- 按工作区 owner 合并刷新，子 Tab 保留父 owner 路由。每个运行批次只结算自己的 waiter；
  后续批次不会延长前一批等待，也不会继承其错误。
- 工作区解析、执行中的刷新、独立发布/修复使用正数 `taskTimeoutMs`，默认读取
  `LODY_CODE_COLLAB_TASK_TIMEOUT_MS`，未配置为 30,000 毫秒；无效、非正数回退默认值。
  嵌套发布继承刷新取消信号。这是单次执行预算，不把此前所有排队批次合并为一个请求 deadline。
- dispose 取消活跃任务和待刷新 waiter；显式释放 owner 还取消其任务、修复 timer。
  主动取消不安排修复；超时保留未确认发布的重试资格。
- 私有 MessagePort 把取消带入 worker，经共享进程 facade 传给 Git；取消时也等待并行子进程
  结束后才返回。不使用 Tinypool 的 `signal` 直接杀线程，以免丢掉子进程 owner。
  Bun 子进程模式使用按任务 ID 隔离的 ready/abort IPC 握手。取消不会触发新 fallback 扫描。
- 主线程在开始新工作、替换共享状态前检查取消。不能中断的读取仅产生任务局部结果。
  发布在 open/pre-sync 后、写入前检查取消，向 Repo sync 传信号，阻止延迟读取后继续写旧通知、
  旧增删行数摘要。
- 原始共享 Repo/存储 I/O 可能比取消 waiter 活得更久，由原 Repo、每条 stream 的串行 owner
  管理。不创建替代副本、不销毁共享 room，不声称撤销已应用 CRDT 数据。发布未确认时保留
  pending signal 和按 owner 使用最新状态的修复路径。

```text
turn：必要 history / ACP 清理 -> 发起刷新 -> 释放 presence
service：owner 队列 -> 有时限的扫描 -> 有时限的发布 -> 通知
                       取消传给 worker 和 Git
                       迟到结果不能继续写旧快照
```

已评估小范围原生 Effect 迁移，本次暂缓：仍依赖 Lody 的 Promise 工作区解析、diff store、
watcher、进程 facade 和发布的 Promise Repo。只换外层 timer/fiber 不构成完整原生单元。
不改锁定依赖或迁移 ledger 的完成声明。

## 最近版本线索

无限等待在 10 月 17 日 SDK 升级前已存在；此期间 publisher、scan pool/worker 没变化，
#1726 只增加未提交 diff 读取，没有修改队列。浅克隆边界的 blame 不能确定最初引入时间。

- #1607 升级 Repo 0.22.0 → 0.23.0、CRDT 0.17.0 → 0.19.0、Client 0.9.0 → 0.12.0。
  真实发布 client 的受控计时实验确认普通 append 默认超时由 10 秒变成 60 秒；初始同步上传
  旧策略不同。这解释失败等待变长，不能证明永久 pending。
- #1672/#1677 接入 Flock 队列、compaction 修复。#1713 撤回 native consumer，保留新 SDK。
- #1748 接入 CRDT 0.19.1、Client 0.12.1、Repo 0.23.3。
  [独立读循环调查](../../proposed/bug-fix/2026-10-19-streams-read-loop-spin.md)涉及更广泛的 daemon
  故障；没有匹配构建、日志，不能归因于仍可响应的 daemon 中某 owner 队列卡住。合并不等于安装。

## 验证边界

回归覆盖刷新 pending/rejection 时释放 turn 并执行下一条输入，Stop 遇到 pending 刷新，
配置超时后发布更新的排队快照，迟到发布错误、dispose、旧 pre-sync 结果，以及协作式取消
worker 并真实回收 Git 子进程。保留已有发布、文件 RPC 测试；使用显式 gate、fake timers。

目标测试通过 377 项。输出 worker 与实际 pool 的线程、子进程模式都通过取消、回收 Git 和接收
下一任务的 smoke。2048 MiB heap 下的 CLI bundle、类型检查、格式、静态边界和文档检查通过。
组件通过 5,882 项、Shared 1,580 项、E2EE Core 432 项、Electron 26 项。CLI 全量通过 4,461 项、
跳过四项，未改动的递归原生 SSH Git 凭据夹具有一项 `context_unreadable` 失败，因此不把
`pnpm check` 报为全绿。最初的 loopback 权限失败已在允许本机监听的环境补跑。
没有部署，也没有原设备复现；
外部操作为何 pending 仍未确认。
