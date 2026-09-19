# 合并重叠的本地历史刷新

Status: implemented
Translation: current
PR: [#563](https://github.com/LodyAI/Lody/pull/563)

[English](2026-09-10-coalesce-local-history-refresh.md)

## 摘要

在重叠的 renderer 生命周期中打开同一个已导入会话时，可能重复启动相同的本地历史刷新，而
CLI 会把第二个请求作为错误拒绝。本地项目历史操作现在会让等价的进行中请求共享同一结果，
并把同一项目的不同请求串行执行。协调器只存在于单个进程内，因此不声称能协调不同 CLI 进程。

## 决策与范围

协调由 CLI service 负责，因为它是目录同步、选定会话导入与冲突解决的共同边界。请求身份由
provider、workspace、machine、本地项目、操作、根路径和操作目标共同组成。导入目标按集合
处理，因此顺序不同但内容等价的选择会复用同一结果。

不同操作和目标会等待项目当前队尾，以保留既有单写入行为，而不再抛出合成的“already running”
错误。原操作的结果或失败仍会传给所有请求它的调用方。操作结束后会在调用方继续之前
从协调器中移除；失败也不会污染队列，因此之后的刷新仍可正常执行。

本决定补充
[窗口化读取前保持单一历史写入者](../architecture/2026-09-07-single-history-writer.zh.md)
中的已导入历史保证。它不改变 replay 比较、目录持久化、冲突解决策略或该文档记录的跨进程并发
限制。

## 证据与限制

确定性 service 测试使用 deferred promise，证明来自不同 service 消费者的等价导入只执行一次
并返回同一结果、合并请求的失败会到达每个调用方、不同目标按顺序执行，以及失败或成功完成后
可以发起新的请求。CLI 类型检查和定向 service 测试验证了进程内契约。这些测试在共享 service
边界模拟不同 renderer 消费者，但没有复现已安装 renderer 的真实 remount 时序，也没有执行文件
系统或 provider I/O。
