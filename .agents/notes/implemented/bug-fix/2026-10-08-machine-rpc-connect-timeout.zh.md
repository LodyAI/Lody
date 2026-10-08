# Machine RPC Streams 连接超时默认改为 30 秒

Status: implemented
Translation: current

[English](2026-10-08-machine-rpc-connect-timeout.md)

## 摘要

桌面端 Machine RPC 没有传超时，`@loro-dev/streams-client` 0.8.0 就给令牌获取和 append POST
各 10 秒，而 CLI 会等 30 秒（[#1311](https://github.com/LodyAI/Lody/issues/1311)）。现在
`createLoroStreamsJsonStreamClient` 把 `connectTimeoutMs` 默认设为 30 秒，调用方不自己传值时都用
CLI 的这个值。所有调用方都是 Machine RPC。只修桌面端也能解决问题，但以后新增的调用方若不传超时，
又会回到 10 秒。CLI 与工厂共用 `DEFAULT_LORO_STREAMS_RPC_CONNECT_TIMEOUT_MS`，作为 `LODY_LORO_RPC_CONNECT_TIMEOUT_MS` 的回退值。桌面端不读
这个变量，因为没有机制把它传到渲染进程。

## 限制

桌面端响应读取现在和 CLI 一致：首个 SSE 请求最多等 30 秒，long-poll 请求从 40 秒变为最多 60 秒，
SDK 在 SSE 流空闲 60 秒（原为 45 秒）后重连。还没人在卡住的 Streams 网关上试过桌面菜单。
