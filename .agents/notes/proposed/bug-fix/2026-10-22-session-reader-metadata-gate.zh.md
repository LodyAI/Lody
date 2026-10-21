# 为会话读取器元数据门限加上边界

Status: proposed
Type: bug-fix
Translation: current
Issue: [#1796](https://github.com/LodyAI/Lody/issues/1796)

[English](2026-10-22-session-reader-metadata-gate.md)

## 摘要

打开一个没有可用本地状态的会话——典型场景是在其他设备（如手机端）创建的会话——
当工作区 Meta 绑定始终无法恢复时，打开过程会永久挂起：渲染端读取器身份门限没有
超时，而 store 缓存会复用挂起中的创建 Promise，即使离开再重新进入会话也无法重试。
门限现在以 Meta 首次同步预算为界，超时后以带描述的 `TimeoutError` 拒绝；失败的创建
会被逐出缓存，重新进入即可重试。同时修复了同一门限中的两个较小的活性缺陷：被拆除
的绑定其等待拒绝后不再搁置已记录的绑定变更；缺少所属机器的 Roost 身份现在会注册
绑定等待，而不是不注册任何等待就直接返回。

## 缺陷与修改

`awaitSessionReaderMetadata`(`create-workspace-runtime.ts`）只有在会话所在平面的
Meta 绑定达到 `restored` 且目录身份（`historyBackend`、`machineId`）已知时才兑现；
此前它只在运行时销毁或会话被删除时拒绝。Meta 房间停滞（同步卡死、登出、离线）因此
会造成无错误提示的永久骨架屏。

- **有界等待。** 新增 120 秒计时器（沿用现有 Meta 首次同步预算，正常的冷恢复不会在
  竞赛中落败），超时以 `TimeoutError` 结束门限。`createSessionStore` 本就会卸载文档，
  受管 store 缓存本就会逐出失败的创建，因此重新进入会话时会基于 Meta 房间当时的
  状态重试——没有引入新的所有权。
- **绑定等待被拒绝后重新评估。** 当绑定被拆除（传输重新挂接）时，
  `waitFor({ phase: 'restored' })` 会拒绝。状态变更在等待仍注册时已记录到
  `bindingChanges`，而拒绝处理此前只是移除监听，把这次变更搁置到某个无关的外部
  唤醒为止。拒绝路径现在与成功路径一致：有记录变更时重新评估，让替代绑定获得新的
  等待。完成时的 abort 仍然先行结算，门限结束后不会再注册。
- **不完整的 Roost 身份改为继续向下执行。** 此前 `historyBackend: 'roost'` 但缺少
  `machineId` 时在注册任何绑定等待之前就直接返回。现在它进入共享的等待/恢复流程：
  恢复完成时重新检查身份，真正缺失的元数据由超时兜底。

## 验证与限制

两个回归测试加入 `create-workspace-runtime-meta-recovery.test.ts`，基于真实
`LoroRepo` 与可控门闸的传输同步：

- Meta 绑定始终不恢复的冷打开在预算耗尽后（假时钟）以 `TimeoutError` 拒绝，取消其
  观察订阅，失败的创建被逐出，恢复后重新获取成功；
- 已记录状态变更后其 restored 阶段等待被拒绝的绑定会注册第二次等待，并在同步恢复后
  完成打开，全程没有新的元数据事件。两个测试在没有源码修改时都会失败（第一个会一直
  挂到测试超时）。

`packages/components` 全量套件：596 个文件 / 5912 个测试通过；`tsc --noEmit` 通过。
未覆盖：渲染端仍然只把打开失败打到 console（重新进入会话前仍显示骨架屏）；提供显式
错误态与重试入口是刻意留待后续的 UI 工作。Meta 停滞的触发源本身不在本次范围内，其
上游修复见 streams 读循环笔记。
