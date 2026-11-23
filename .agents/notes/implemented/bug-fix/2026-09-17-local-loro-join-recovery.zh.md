# 恢复中断的本地 Loro 房间加入

Status: implemented
Translation: current
Related: [English](2026-09-17-local-loro-join-recovery.md)

## 摘要

本地 Loro 房间在加入发送失败或迟迟未收到回复后，可能停留在 `connecting` 或
`reconnecting`，使工作区重试监督器没有可操作的错误。适配器现在拥有每个已连接
加入尝试的 120 秒期限，并把可恢复失败转换为 `error`，从而让既有的有界退避监督器
重试。Flock 协调也属于该尝试边界，因此导入失败不会错误发布就绪；这修复的是已确定的
恢复缺口，而非对既往网络事件原因的断言。

## 决策

Electron relay 仍负责 socket 重连。工作区监督器仍是唯一的房间重试所有者：适配器失败
发布 `error`，普通 `connecting` 和 `reconnecting` 状态仍不触发即时重试。请求 id 与
同步 generation 会保护超时、迟到的加入回复和异步 Flock 完成回调；关闭、断连、终端
失败或替代尝试都会取消待处理的尝试。

## 证据与限制

聚焦适配器测试覆盖了被搁置的回复、同步发送失败、以及被拒绝的 Flock 导入后有效的
替代加入。此工作树缺少 ACP extension 工作区模块，故 shared 包类型检查仍被阻断。
本变更未增加 Electron 重启测试 harness 或 renderer 到 main 的持久化诊断记录。
