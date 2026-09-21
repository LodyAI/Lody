# 登录期间保持认证输入可执行

Status: implemented
Translation: current

[English](2026-09-17-authentication-control-lanes.md)

## 摘要

本地 ACP 登录等待用户输入时，占用了该输入请求也需要的串行队列。选择 Google Antigravity 登录方法后，输入提交因此超时，认证无法前进。现在按机器和认证请求划分执行通道，让登录开始与输入、取消分别执行。确定性的队列测试证实登录尚未完成时后续操作可以执行，但不代表已完成 Google 授权。

## 决策和证据

[Issue #505](https://github.com/LodyAI/Lody/issues/505) 描述已经显示登录方式，但提交选择后报错。这与 [#208](https://github.com/LodyAI/Lody/pull/208) 修复的缺少认证支持不同，本地路径已经支持这些协议操作。

`MachineRuntime.dispatchLocalMessageForResponse` 将登录与后续操作交给 `MessageProcessor`。此前它们均使用 null key，`ConcurrentQueue` 把它映射到同一默认串行链。登录处理器等待输入，该链就无法执行提供输入的处理器；授权码和取消也存在相同依赖。

保留队列原有默认语义和会话顺序，为每次认证建立开始通道和后续操作通道。同一认证的输入与取消仍按顺序执行。如果把所有 null key 操作都改为并行，会影响其他机器操作；延长界面超时也无法解除循环依赖。

## 验证

现有消息处理器测试加入 `submit-input`、`submit-code` 和 `cancel` 的虚拟时钟用例。三项在旧代码均失败，分离通道后与原有会话顺序检查一起通过。未使用真实 Google 账号或浏览器授权；全局并发工作上限不变。
