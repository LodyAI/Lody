# Windows Host 拒绝访问

Status: implemented
Translation: current

[English](2026-10-20-windows-host-access-denied.md)

## 摘要

在 Windows 上，如果有一个 Lody 运行时在另一个登录会话中以提升权限启动（会话 0、完整管理员令牌），桌面端可能会永远停在"连接中"。这个运行时创建的命名管道使用提升令牌的默认 DACL，只给 SYSTEM 和管理员组写权限。同一用户的非提升桌面端每次探测都会收到 Win32 错误 5，并且每 60 秒重试一次，没有尽头。现在 Host 宿主锁会把这种端点报告为 `accessDenied`，supervisor 不再重试而是进入 fatal 状态，设置 → 守护进程会说明如何处理。这让故障变得可见，但并不让两种权限级别共享同一个运行时。

## 决策与证据

Electron 通过绑定按用户命名的 Host 管道来占用运行时（`local-cli-host-lease.ts`）。libuv 会把创建首个管道实例（`CreateNamedPipeW`）时的 `ERROR_ACCESS_DENIED` 转成 `EADDRINUSE`，所以这次绑定看起来和普通的"Host 已被占用"一样。随后的身份探测在 connect 时失败，得到 `EPERM`（libuv 对同一个 Win32 错误在 connect 时的映射）。修改前，探测吞掉了这个错误，宿主锁返回不带记录的 `occupied`，supervisor 安排一次不计入失败次数的重试，因此永远不会进入 fatal。

- 宿主锁的探测保留错误类别：connect 返回 `EPERM` 或 `EACCES` 时，结果为 `{ status: 'occupied', record: null, accessDenied: true }`。其他调用方仍把它当作 occupied 处理；TS 与 CJS 两个模块保持一致。
- `SupervisorOwnership.acquire` 新增 `inaccessible`。supervisor 遇到它会标记为 fatal；显式启动或重启会清除这个结论并重新获取，所以结束外部进程后点"重启"即可恢复，不必重开应用。
- `ElectronCliState.hostAccessDenied` 以数据形式携带原因，由渲染端显示翻译后的文案。Nightly 启动对话框使用同一段说明。

选择 fatal 而不是带说明的重试循环，是因为这项访问检查是确定性的，每次重试结果都一样；[故障隔离指南](../../../docs/failure-containment.md) 也指出，对持久性故障无限重试，效果上和一道永久的阻隔一样不可用。

## 未采用的方案

- `listen({ readableAll, writableAll })` 会调用 libuv 的 `uv_pipe_chmod`，给 `Everyone` 加读写权限。管道创建时也没有设置 `PIPE_REJECT_REMOTE_CLIENTS`，这样会把控制通道的访问范围远远扩大到用户之外。
- 用显式的用户 SID DACL 创建管道，可以让两种权限级别共享运行时，但 Node 不提供设置安全属性的接口，需要为每个本地通道实现原生管道服务器。等这种共享成为受支持的配置时再做。

## 验证与局限

一个权限为 `000` 的 Unix socket 测试通过真实的 connect 路径复现了这种拒绝（得到 `EACCES`），覆盖两种模块格式；该测试在旧代码上失败。另有一个 supervisor 测试覆盖"进入 fatal 后不再重试、重启后恢复"。Windows 上的 `EPERM` 映射依据的是 libuv 源码（`src/win/error.c`、`src/win/pipe.c`），没有在 Windows 上实际运行验证。受影响机器上那个会话 0 的提升权限运行时是如何启动的仍然未知，本次修改并不阻止它出现。
