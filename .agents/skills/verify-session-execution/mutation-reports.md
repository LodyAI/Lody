# Broken-boundary model reports

These configs deliberately restore old failure paths. Their violations are required negative controls, not failures of the current corrected baseline. The default checker also verifies five original safety mutations and source variants.

## legacy-progress

# Model

TLC reached 375 states and 981 steps. The chart draws 375 states and 981 arrows.

## HealthySessionProgress breaks
TLC's counterexample is in tlc-HealthySessionProgress.out. It has 9 steps:
0. 本轮已读到B 否 / 调度器阶段 等待唤醒 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 否 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 否 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 否 / B批次阶段 无 / A已尝试写入 否 / 发生停止后提交 否 / A保留重试 否 / B待执行意图 否
1. 开始一轮扫描: 本轮已读到B 否 / 调度器阶段 重试旧记录 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 否 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 否 / B持有执行权 否 / 排队唤醒 否 / 已收到Stop 否 / A已归还执行权 否 / B批次阶段 无 / A已尝试写入 否 / 发生停止后提交 否 / A保留重试 否 / B待执行意图 否
2. B 收到可自动处理的结果: 本轮已读到B 否 / 调度器阶段 重试旧记录 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 否 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 否 / 已收到Stop 否 / A已归还执行权 否 / B批次阶段 无 / A已尝试写入 否 / 发生停止后提交 否 / A保留重试 否 / B待执行意图 是
3. A 的提交状态写入失败: 本轮已读到B 否 / 调度器阶段 重试旧记录 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 否 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 否 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
4. A 归还执行权: 本轮已读到B 否 / 调度器阶段 重试旧记录 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 否 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
5. A 的写入仍失败，跳过本轮其余工作: 本轮已读到B 否 / 调度器阶段 本轮重试失败 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
6. 报告错误，等待下一次唤醒: 本轮已读到B 否 / 调度器阶段 等待唤醒 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
7. 开始一轮扫描: 本轮已读到B 否 / 调度器阶段 重试旧记录 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 否 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
8. A 的写入仍失败，跳过本轮其余工作: 本轮已读到B 否 / 调度器阶段 本轮重试失败 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 否 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
9. 收到新的调度唤醒: 本轮已读到B 否 / 调度器阶段 本轮重试失败 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是
The run loops through "本轮已读到B 否 / 调度器阶段 本轮重试失败 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是", "本轮已读到B 否 / 调度器阶段 等待唤醒 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 是 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是", "本轮已读到B 否 / 调度器阶段 重试旧记录 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 否 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是" and "本轮已读到B 否 / 调度器阶段 本轮重试失败 / B启动任务存活 否 / B结果已消费 否 / B已暂停 否 / B提交次数 0 / 已观察到A重试失败 是 / B启动任务待接纳 否 / B已归还执行权 否 / B结果已到达 是 / B持有执行权 否 / 排队唤醒 否 / 已收到Stop 否 / A已归还执行权 是 / B批次阶段 无 / A已尝试写入 是 / 发生停止后提交 否 / A保留重试 是 / B待执行意图 是" forever.

## Rules that hold
TypeOK, AtMostOnce, NoStartAfterStop, ConsumedOnlyAfterStart, RetryEvidenceRetained, OldReleaseCannotFreeSuccessor, NoDeadlock

## delivery-legacy-negative-ack

# Model

TLC reached 1,768 states, more than the chart budget of 500, so the chart draws only the bug paths: 9 states and 8 arrows.

## NoFailedReplay breaks
The shortest path has 8 steps:
0. 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 0 / 当前输入 0 / 已收到激活 [] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [] / 已同步正文 [] / 最新激活 0 / 已完成 [] / 已报告失败的输入 []
1. 用户凭据到达: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 0 / 当前输入 0 / 已收到激活 [] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [] / 最新激活 0 / 已完成 [] / 已报告失败的输入 []
2. 激活信息到达: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 0 / 当前输入 0 / 已收到激活 [1] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [] / 最新激活 1 / 已完成 [] / 已报告失败的输入 []
3. 等待正文超时并报告失败: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 1 / 当前输入 0 / 已收到激活 [1] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [] / 最新激活 1 / 已完成 [] / 已报告失败的输入 [1]
4. 正文同步到执行机器: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 1 / 当前输入 0 / 已收到激活 [1] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [1] / 最新激活 1 / 已完成 [] / 已报告失败的输入 [1]
5. 激活信息到达: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 1 / 当前输入 0 / 已收到激活 [1,2] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [1] / 最新激活 2 / 已完成 [] / 已报告失败的输入 [1]
6. 等待正文超时并报告失败: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 2 / 当前输入 0 / 已收到激活 [1,2] / 已接纳 [] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [1] / 最新激活 2 / 已完成 [] / 已报告失败的输入 [1,2]
7. 接纳当前可见输入: 已收到请求正文 [] / 已启动 [] / 当前投递失败标记 2 / 当前输入 0 / 已收到激活 [1,2] / 已接纳 [1] / 失败输入被再次启动 false / 已收到用户凭据 [1] / 已同步正文 [1] / 最新激活 2 / 已完成 [] / 已报告失败的输入 [1,2]
8. 开始执行输入: 已收到请求正文 [] / 已启动 [1] / 当前投递失败标记 2 / 当前输入 1 / 已收到激活 [1,2] / 已接纳 [1] / 失败输入被再次启动 true / 已收到用户凭据 [1] / 已同步正文 [1] / 最新激活 2 / 已完成 [] / 已报告失败的输入 [1,2]

## Rules that hold
TypeOK, NoDeadlock

## gate-legacy

# Model

TLC reached 5 states and 6 steps. The chart draws 5 states and 4 arrows.
The chart does not draw 1 steps that stay in one chart state.

## NoDeadlock breaks
The shortest path has 2 steps:
0. 发生迟到写入 false / 写入前回调 "idle" / 已取消回调的后续写入 false / 超时仍有效 true / 回复等待阶段 "waiting" / 输出已写入 false / 已结束 false
1. 超时后开始写回复条目: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 false
2. 结束旧输入: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true

## OutputEventuallyUnblocked breaks
TLC's counterexample is in tlc-OutputEventuallyUnblocked.out. It has 2 steps:
0. 发生迟到写入 false / 写入前回调 "idle" / 已取消回调的后续写入 false / 超时仍有效 true / 回复等待阶段 "waiting" / 输出已写入 false / 已结束 false
1. 正文同步后开始写回复条目: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 false
2. 结束旧输入: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true
The run stops in "发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true" forever.

## DisposeUnblocks breaks
TLC's counterexample is in tlc-DisposeUnblocks.out. It has 2 steps:
0. 发生迟到写入 false / 写入前回调 "idle" / 已取消回调的后续写入 false / 超时仍有效 true / 回复等待阶段 "waiting" / 输出已写入 false / 已结束 false
1. 正文同步后开始写回复条目: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 false
2. 结束旧输入: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true
The run stops in "发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true" forever.

## DeadlineUnblocks breaks
TLC's counterexample is in tlc-DeadlineUnblocks.out. It has 2 steps:
0. 发生迟到写入 false / 写入前回调 "idle" / 已取消回调的后续写入 false / 超时仍有效 true / 回复等待阶段 "waiting" / 输出已写入 false / 已结束 false
1. 正文同步后开始写回复条目: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 false
2. 结束旧输入: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true
The run stops in "发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 false / 超时仍有效 false / 回复等待阶段 "opening" / 输出已写入 false / 已结束 true" forever.

## Rules that hold
TypeOK, ReleasedFlagConsistent, NoLateWrites

## gate-late-write-mutant

# Model

TLC reached 16 states and 30 steps. The chart draws 16 states and 23 arrows.
The chart does not draw 7 steps that stay in one chart state.

## NoLateWrites breaks
The shortest path has 2 steps:
0. 发生迟到写入 false / 写入前回调 "idle" / 已取消回调的后续写入 false / 超时仍有效 true / 回复等待阶段 "waiting" / 输出已写入 false / 已结束 false
1. 超时后开始写回复条目: 发生迟到写入 false / 写入前回调 "waiting" / 已取消回调的后续写入 true / 超时仍有效 false / 回复等待阶段 "open" / 输出已写入 false / 已结束 false
2. 回复条目写入返回: 发生迟到写入 true / 写入前回调 "done" / 已取消回调的后续写入 true / 超时仍有效 false / 回复等待阶段 "open" / 输出已写入 false / 已结束 false

## Rules that hold
TypeOK, ReleasedFlagConsistent, NoDeadlock, OutputEventuallyUnblocked, DisposeUnblocks, DeadlineUnblocks

## AtMostOnce

# Model

TLC reached 2,488 states, more than the chart budget of 500, so the chart draws only the bug paths: 10 states and 9 arrows.

## AtMostOnce breaks
The shortest path has 9 steps:
0. B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
1. B 收到可自动处理的结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
2. 开始一轮扫描: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 重试旧记录 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
3. 旧状态记录重试成功: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 读取待执行输入 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
4. 读取待执行输入: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 准备批次 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
5. 冻结这一批结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已准备 / 调度器阶段 派发启动任务 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
6. 派发 B 的启动任务: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 是 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已准备 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
7. B 取得独占执行权: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已准备 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 0
8. 通过最后检查后提交给 Agent: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 1
9. 通过最后检查后提交给 Agent: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 2

## Rules that hold
TypeOK, NoDeadlock

## ConsumedOnlyAfterStart

# Model

TLC reached 3,926 states, more than the chart budget of 500, so the chart draws only the bug paths: 5 states and 4 arrows.

## ConsumedOnlyAfterStart breaks
The shortest path has 4 steps:
0. B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
1. 开始一轮扫描: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 重试旧记录 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
2. 旧状态记录重试成功: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 读取待执行输入 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
3. 读取待执行输入: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 准备批次 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
4. 冻结这一批结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 是 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0

## Rules that hold
TypeOK, NoDeadlock

## NoStartAfterStop

# Model

TLC reached 2,488 states, more than the chart budget of 500, so the chart draws only the bug paths: 11 states and 10 arrows.

## NoStartAfterStop breaks
The shortest path has 10 steps:
0. B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
1. B 收到可自动处理的结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
2. 开始一轮扫描: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 重试旧记录 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
3. 旧状态记录重试成功: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 读取待执行输入 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
4. 读取待执行输入: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 准备批次 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
5. 冻结这一批结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已准备 / 调度器阶段 派发启动任务 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
6. 派发 B 的启动任务: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 是 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已准备 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
7. B 取得独占执行权: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已准备 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 0
8. 通过最后检查后提交给 Agent: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 1
9. 用户按下 Stop: B已归还执行权 否 / 已收到Stop 是 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 是 / B结果已到达 是 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 1
10. 通过最后检查后提交给 Agent: B已归还执行权 否 / 已收到Stop 是 / 发生停止后提交 是 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 是 / B结果已到达 是 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 2

## Rules that hold
TypeOK, NoDeadlock

## OldReleaseCannotFreeSuccessor

# Model

TLC reached 1,252 states, more than the chart budget of 500, so the chart draws only the bug paths: 11 states and 10 arrows.

## OldReleaseCannotFreeSuccessor breaks
The shortest path has 10 steps:
0. B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
1. A 的提交状态写入失败: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
2. B 收到可自动处理的结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
3. 开始一轮扫描: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 重试旧记录 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
4. A 的写入仍失败，保留记录并继续扫描: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 无 / 调度器阶段 读取待执行输入 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
5. 读取待执行输入: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 无 / 调度器阶段 准备批次 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
6. 冻结这一批结果: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 已准备 / 调度器阶段 派发启动任务 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
7. 派发 B 的启动任务: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 是 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 已准备 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 0
8. B 取得独占执行权: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 已准备 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 0
9. 通过最后检查后提交给 Agent: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 是 / B提交次数 1
10. A 归还执行权: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 是 / B已暂停 否 / B结果已到达 是 / B待执行意图 是 / B结果已消费 否 / A保留重试 是 / A已归还执行权 是 / 排队唤醒 是 / 已观察到A重试失败 是 / B批次阶段 已开始提交 / 调度器阶段 等待唤醒 / 本轮已读到B 是 / B持有执行权 否 / B提交次数 1

## Rules that hold
TypeOK, NoDeadlock

## RetryEvidenceRetained

# Model

TLC reached 1,110 states, more than the chart budget of 500, so the chart draws only the bug paths: 4 states and 3 arrows.

## RetryEvidenceRetained breaks
The shortest path has 3 steps:
0. B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 否 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
1. A 的提交状态写入失败: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 是 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 等待唤醒 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
2. 开始一轮扫描: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 是 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 否 / B批次阶段 无 / 调度器阶段 重试旧记录 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0
3. 旧状态记录重试成功: B已归还执行权 否 / 已收到Stop 否 / 发生停止后提交 否 / A已尝试写入 是 / B启动任务待接纳 否 / B启动任务存活 否 / B已暂停 否 / B结果已到达 否 / B待执行意图 否 / B结果已消费 否 / A保留重试 否 / A已归还执行权 否 / 排队唤醒 否 / 已观察到A重试失败 是 / B批次阶段 无 / 调度器阶段 读取待执行输入 / 本轮已读到B 否 / B持有执行权 否 / B提交次数 0

## Rules that hold
TypeOK, NoDeadlock

## Source ablations

The default command catches the old workspace-wide scan abort in both SQL fixtures; missing start/owner fences; dropped settlement retention; mismatched cancel control; missing per-ID acknowledgement; stalled gate disposal/deadline; and the actual assistant-entry writer without its pre-write signal check. The dropped-receipt fixture preserves both its behavioral assertion and any scope-cleanup Cause rather than letting cleanup hide the product failure. Current source witnesses pass.
