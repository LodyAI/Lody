# 把热路径诊断记录与守护进程的默认日志分开

Status: implemented
Translation: current
PR: [#756](https://github.com/LodyAI/Lody/pull/756)

[English](2026-09-16-daemon-log-volume.md)

## 摘要

常驻守护进程每天写出约 12.6 MB、15.4 万行日志，而文件 transport 被硬编码为 `debug`，
与用户是否开启 debug 无关，因此每一条位于逐 token 或逐次心跳路径上的 `logger.debug`
都必然被格式化并落盘。轮转只保留 20 MB 窗口，于是少数几类高频记录把排查真正需要的
历史冲掉了。现在 `debug` 之下新增了 `trace` 级别；文件 sink 仍停在 `debug`，只有在
`LODY_LOG_TRACE=1` 时才下探到 `trace`。用新的路由规则回放实测那一天，可在 15.45 MB
中移除 9.36 MB（60.6%）。这与省电无关——格式化加落盘摊下来约 0.15 KB/s——本次只关心
窗口里能装下多少可诊断的历史。

## 决策

本次每一处降级都遵循同一条判据：**在一条记录离开默认 sink 之前，先问没有它还能不能
定位这个子系统的故障。** 答案是否的就保留该记录，或者收窄降级范围，让异常路径仍然以
`debug` 记录。下面每一项都由这条判据决定，而不是按单项体积排序。

之所以引入真正的 `trace` 级别而不是给每个调用点加环境变量开关，是因为这样
「哪些记录会进文件」只有一个答案，并且可以在一个地方测试。控制台仍然跟随
`config.level`；文件 sink 通过 `resolveFileLogLevel` 解析自己的级别，transport 工厂和
`setLevel` 都调用它，因此让控制台静音永远不会收窄诊断记录。

构成日志体积的有五个来源：

- **`ACP Session started`** 会整对象 pretty-print 出完整的 `NewSessionResponse`——所有
  mode、model、描述以及 `_meta` 扩展——平均每次会话启动超过 120 行，每天 2.67 MB，是
  单项最大的一块。现在改成单行摘要，写出会话 id 以及所声明目录的*形状*（数量、当前
  mode/model、选项 id、`_meta` 键名）。启动排查读的正是这些字段；完整响应仍会 dump，
  只是落在 `trace`。
- **`acp.flush_updates_batch` 与 `history.turn_gate_wait`** 每批流式 token 各执行一次，
  合计每天 3.91 MB，比其余所有 span 加起来还多。`startTraceSpan` 新增了 `hot` 选项，
  把 start/end 路由到 `trace`。关键路径上的可诊断性得以保留：失败的 hot span，或者
  超过 `slowMs`（默认 1 秒）的 hot span，仍然以 `debug` 记录，因此 flush 路径上的卡顿
  或错误无需事后开启 trace 也能看到。
- **`Loro repo flush started`/`completed`** 每次 flush 必定成对出现，每天 1.99 MB，而
  实测 p50 为 2 ms、最大 39 ms。start 记录移到 `trace`，completed 记录只在超过 200 ms
  时才以 `debug` 记录。若 flush 挂住而非返回，现有的 `withSlowOperationWarning` 定时
  提示仍会报告，因此这两行原本要捕捉的故障模式不受影响。
- **Presence machine heartbeat** 是每个 workspace 的稳定心跳（每天 0.48 MB），已移到
  `trace`；join 失败与房间状态变化保持原级别，presence 排查读的正是后者而非健康心跳。
- **Local control** 在完成记录之前还会写出到达、请求体大小和解析三条记录。前三条移出
  默认 sink，完成记录则吸收了 workspace id 与耗时，因此仍有一行描述一次被服务的请求。
  解析失败、machine 不匹配和分发失败分支各自保留原有的 `debug` 记录。

`[pr-poller] Bucket empty`（每天 0.28 MB）在此有意不动，它由另一项工作按 scope 节流。

## 备选方案

曾考虑用按分钟采样（每分钟一条 span）代替引入级别。采样能在默认日志里保留一些稳态
信号，但会让某一轮对话的 span 取决于它发生的时刻而时有时无，对需要看*这一轮*的排查
反而更糟。级别加上慢/错误的逃生口给出了确定的规则：健康且快速则静默，其余都不静默。

也曾考虑让文件 transport 保持 `debug`、改为在各调用点加环境变量开关，但被否决：每条
新的热路径都会自造一个开关，而「日志里到底有什么」将不再有唯一答案。

## 验证与局限

用新的路由规则回放 `~/.lody/logs/2026-09-16.log.1`（15.45 MB、172,799 行、02:11–18:30），
移除 9.36 MB（60.6%），剩余 6.09 MB：hot span 3.91 MB、session-started dump 2.67 MB、
Loro flush 成对记录 1.99 MB、presence heartbeat 0.48 MB、local control 0.32 MB。

测试覆盖文件 sink 的级别策略（默认 `debug`，仅在显式 `LODY_LOG_TRACE` 开启时为
`trace`，无法识别的取值被忽略）、span 的路由规则（含慢与失败两个逃生口），以及会话
摘要在所声明目录增大时仍保持单行且有上限。没有任何测试断言产品日志的文本内容。

回放是基于一台机器一天数据的估算：它假设该日志中每次 Loro flush 都在 200 ms 阈值以下
（所有实测 flush 均如此，但高负载下并无保证），也没有模拟会话启动频率不同的日子。本次
不改变 20 MB 轮转大小、7 天保留期，也不改变 `[pr-poller]` 的体积。`apps/cli/AGENTS.md`
仍链接 `context/cli-startup.md`，此前还链接 `context/cli-logs.md`，两者在本仓库中都不
存在；失效的日志链接已被规则本身取代，启动那条保持原样。
