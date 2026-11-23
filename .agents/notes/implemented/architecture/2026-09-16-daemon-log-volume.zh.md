# 把热路径诊断记录与守护进程的默认日志分开

Status: implemented
Translation: current
PR: [#756](https://github.com/LodyAI/Lody/pull/756)

[English](2026-09-16-daemon-log-volume.md)

## 摘要

守护进程的文件 transport 被硬编码为 `debug`，与用户的控制台级别无关，因此每一条位于逐 token
或逐次 flush 路径上的 `logger.debug` 都会被格式化并落盘；而轮转只保留 20 MB 窗口，少数几类
高频记录就会把排查需要的历史冲掉。现在 `debug` 之下新增了 `trace` 级别；文件 sink 仍停在
`debug`，只有在 `LODY_LOG_TRACE=1` 时才下探到 `trace`。用新的路由规则回放最近一个完整日
（12.88 MB），可移除 3.91 MB（30.4%）；同一日志里专为崩溃、卡顿和退出加的诊断输出不受影响。
剩余最大的一块——presence 心跳的投递诊断——是有意保留的，因为当房间显示 `joined` 而机器
却被判为离线时，只有它能定位原因。这与省电无关——格式化加落盘摊下来约 0.15 KB/s——本次只
关心窗口里能装下多少可诊断的历史。

## 决策

本次每一处降级都遵循同一条判据：**在一条记录离开默认 sink 之前，先问没有它还能不能定位这个
子系统的故障。** 答案是否的就保留该记录，或者收窄降级范围，让异常路径仍然以 `debug` 记录。
下面每一项——包括被这条判据留下的那项——都由它决定，而不是按单项体积排序。

之所以引入真正的 `trace` 级别而不是给每个调用点加环境变量开关，是因为这样「哪些记录会进文件」
只有一个答案，并且可以在一个地方测试。控制台仍然跟随 `config.level`；文件 sink 通过
`resolveFileLogLevel` 解析自己的级别，transport 工厂和 `setLevel` 都调用它，因此让控制台静音
永远不会收窄诊断记录。

已降级：

- **`ACP Session started`** 会把完整的 `NewSessionResponse`——所有 mode、model、描述以及
  `_meta` 扩展——在每次会话启动时 pretty-print 成多行块。现在改成单行摘要，写出会话 id 以及
  所声明目录的*形状*（数量、当前 mode/model、选项 id、`_meta` 键名）。启动排查读的正是这些
  字段；完整响应仍会 dump，只是落在 `trace`。
- **`acp.flush_updates_batch` 与 `history.turn_gate_wait`** 每次流式 token flush 各执行一次——
  gate 等待位于每次 flush 之前。`startTraceSpan` 与 `traceAsync` 新增了 `hot` 选项，把
  start/end 路由到 `trace`。关键路径上的可诊断性得以保留：失败的 hot span，或者超过 `slowMs`
  （默认 1 秒）的 hot span，仍然以 `debug` 记录，因此 flush 路径上的卡顿或错误无需事后开启
  trace 也能看到。
- **`Loro repo flush started`/`completed`** 每次 flush 必定成对出现。实测健康 flush 的 p50 为
  2 ms、最大 39 ms。start 记录移到 `trace`，completed 记录只在超过 200 ms 时才以 `debug` 记录。
  若 flush 挂住而非返回，现有的 `withSlowOperationWarning` 定时提示仍会报告，因此这两行原本
  要捕捉的故障模式不受影响。
- **Local control** 在完成记录之前还会写出到达、请求体大小和解析三条记录。前三条移出默认
  sink，完成记录则吸收了 workspace id 与耗时，因此仍有一行描述一次被服务的请求。解析失败、
  machine 不匹配和分发失败分支各自保留原有的 `debug` 记录。

按同一判据保留：

- **Presence machine heartbeat `written`/`delivered`**——在回放日中占 3.33 MB，约为日志的四分
  之一。这些行记录共享 presence 写队列的深度、写错误，以及每个心跳真正离开进程时的年龄；
  [presence 诊断流程](../../../docs/cli-lib-loro-presence.md)正是从 daily log 里读取它们，来
  解释「会话同步正常、机器却被判离线」这种没有其他记录能说明的故障。没有它们这个故障就无法
  定位，所以保持 `debug`。
- **崩溃、卡顿与退出追踪**，来自
  [daily log 崩溃与卡顿追踪](../feature/2026-09-25-daily-log-crash-and-stall-tracing.zh.md)——
  Electron 主进程镜像、`[process-exit]`/`[process-fatal]`，以及 `[event-loop]`/
  `[event-loop-stall]` 记录。它们是为事故诊断专门加的。Electron 镜像以及退出、卡顿的追加器
  直接写 daily 文件而不经过这个 logger，CLI 侧的卡顿记录使用 `debug`/`warn`，因此本次改动
  触及不到其中任何一条；回放也确认没有任何这类行命中降级规则。

`[pr-poller] Bucket empty` 在此有意不动，它由另一项工作按 scope 节流。

## 更正

本 Note 早先版本中有两处陈述有误，已在上文更正：

- 它把 `history.turn_gate_wait` 列为已降级并计入回放，但当时实际只有
  `acp.flush_updates_batch` 被标为 `hot`。现在 gate 等待的 span 也已标记。
- 它降级了 presence 心跳。本分支写成之后，心跳行被扩展为上文所述的 presence 投递诊断，此时
  再降级就会违反本 Note 自己的判据；rebase 时已撤回该降级。

早先基于 2026-09-16 日志得出的 60.6% 包含了以上两项，已被下面的回放取代。

## 备选方案

曾考虑用按分钟采样（每分钟一条 span）代替引入级别。采样能在默认日志里保留一些稳态信号，但会
让某一轮对话的 span 取决于它发生的时刻而时有时无，对需要看*这一轮*的排查反而更糟。级别加上
慢/错误的逃生口给出了确定的规则：健康且快速则静默，其余都不静默。

也曾考虑让文件 transport 保持 `debug`、改为在各调用点加环境变量开关，但被否决：每条新的热路径
都会自造一个开关，而「日志里到底有什么」将不再有唯一答案。

## 验证与局限

用新的路由规则回放 `~/.lody/logs/2026-09-26.log.gz`——一个完整的本地日，12.88 MB、109,864
行，由已包含崩溃与卡顿追踪的构建写出——移除 3.91 MB（30.4%），剩余 8.96 MB：Loro flush 成对
记录 1.78 MB、hot span 1.14 MB、session-started dump 0.89 MB、local control 0.09 MB。随后的
不完整日（截至本地 16:33，10.61 MB）移除 4.49 MB（42.3%），主要是 hot span（2.51 MB），其量随
流式输出的多少而变化。两个文件中共 142 条崩溃、卡顿、退出及桌面镜像记录，没有一条命中降级
规则；恰有一个 hot span 因超过慢阈值而升回 `debug`——逃生口按设计生效。

测试覆盖文件 sink 的级别策略（默认 `debug`，仅在显式 `LODY_LOG_TRACE` 开启时为 `trace`，无法
识别的取值被忽略）、span 的路由规则（含慢与失败两个逃生口），以及会话摘要在所声明目录增大时
仍保持单行且有上限。没有任何测试断言产品日志的文本内容。

给 `Logger` 接口加上 `trace` 牵动了 `apps/cli` 里的每一个 test double。它们大多用
`as unknown as Logger` 强转，缺少新方法照样能通过类型检查，只会在运行时失败；因此证明没有遗漏
的是完整的 CLI 测试套件，而不是类型检查。

回放是基于一台机器若干天数据的估算：session-started 的节省按固定摘要长度估计而非真实长度；
Loro 的节省假设阈值能把健康 flush 挡在外面（实测每次 flush 都低于 40 ms，但高负载下并无保证）；
hot span 的节省随用户流式输出的多少而变化。本次不改变 20 MB 轮转大小、7 天保留期，也不改变
`[pr-poller]` 的体积。`apps/cli/AGENTS.md` 仍链接 `context/cli-startup.md`，此前还链接
`context/cli-logs.md`，两者在本仓库中都不存在；失效的日志链接已被规则本身取代，启动那条保持
原样。
