# 同进程 E2EE 客户端失权观测端口

Status: implemented
Translation: current

[English](2026-10-30-e2ee-client-loss-probe.md)

## 摘要

桌面旅程 J07/client 和 J08/client 需要证明：成员被移除或设备被撤销后，同一桌面进程会停止读取、发送和启动 turn。此前产品没有可用的只读观测手段。现在，未打包且 `LODY_E2E=1` 的构建会暴露 `e2ee.inspectClientLoss(workspaceId)`，返回 version 1 快照，内容包括原生 E2EE 处理器计数、拒绝记录、reader 数量和渲染进程的传输效果。打包构建既不计数，也不注册该通道，preload 也不放行。

## 决策

**注册方式。** 这对通道直接在 `registerIpcServices` 中注册，而不是作为 `@IpcMethod`，因为服务类的方法总会被注册。是否启用只由 main 判断（`!app.isPackaged && LODY_E2E === '1'`）。main 通过窗口参数把判断结果传给每个窗口，preload 根据这个参数决定是否放行通道、是否设置渲染进程标志。如果让 preload 自己检查环境变量，结果可能与 main 的 `isPackaged` 不一致。

**原生计数。** 计数包装的是以下处理器的真实 promise：`openContent`（`read`）、`seal`、`prepareDispatch`、`acceptDispatchResponse`（`dispatchResponse`）、`open`、`refresh`、`contentStreamsToken`（`token`）和 `close`。计数按缓存账号、工作区和渲染进程 sender 分行，整个进程共用一个单调序号。拒绝消息恰好为 `e2ee_member_removed`、`e2ee_device_revoked` 或 `e2ee_not_open` 时记为一条拒绝；前两种还会记一条权威切点，复制当时的计数和最新效果，之后的活动不能改写这个切点。未知错误只计入 rejected，内容丢弃。数据在 owner 退役后仍保留，并有上限：64 个作用域，每个列表最多 128 行。`readers` 是对账号 owner reader 表的同步读取，不等待账号锁，也不创建 owner。

**传输效果。** 内容 SDK（`StreamsTransportAdapter`）不接受 fetch 注入，不改 SDK 就无法观测 HTTP 追加。因此效果在产品自己拥有的最近边界上计数：
- `contentWrites`、`contentReadEvents`：实时传输对每个受保护帧调用 provider `seal`/`open` 并成功完成的次数。
- `turnStarts`：流客户端实际追加了帧的加密派发请求数。已结束的 `send()` 不计入，因为通道会把追加失败变成 `null` 回执。
- `activeContentStreams`：已挂载、且尚未确认移除的云端传输数。移除失败的仍然计入。
- `transportOwnerClosed`：只有运行时关闭成功完成，并且没有残留的流、待写入或待派发时才为真。关闭过程中销毁了 Repo 但随后抛错的，不会报告为已关闭。

渲染进程在每次变化后推送一个固定 7 个字段的 DTO。main 严格校验，并用 sender 和缓存账号补上作用域。

## 限制与产品缺口

- 桌面端把服务端的 `e2ee_device_revoked` 映射为通用的 `unauthorized` 后端错误，也没有针对设备撤销的门禁。因此 J08/client 找不到权威的 `e2ee_device_revoked` 记录，会一直停在 `removal_not_authoritatively_confirmed`，直到产品为该错误码定类型并加上门禁。CLI 已有对应类型（`CloudE2eeDeviceRevoked`）。
- `turnStarts` 统计的是客户端实际追加的 turn 派发，不是 daemon 进程里的 ACP 启动；daemon 侧的执行由 CLI 自行防护和测试。
- 打包运行（私有 harness 的 `LODY_ACCEPT_CLIENT_LOSS=1`）无法使用该端口。
- 单元和组件测试覆盖了计数、作用域、上限、provider、派发追加和运行时关闭路径。尚未在真实 Electron 旅程中运行。
