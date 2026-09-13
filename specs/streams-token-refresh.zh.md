# Streams token 刷新

Status: draft
Translation: current

[English](streams-token-refresh.md)

多个 stream 因同一工作区 JWT 收到未授权响应时，应复用 token provider 中的一次刷新。
旧 JWT 的响应不能使新 JWT 失效。传输层提供 `previousToken`；未提供该字段的旧回调
只能尽力使用该回调最后一次返回的 token。传输层与 provider 之间的每一跳（包括 Worker
消息边界）都必须传递拒绝原因与被拒 token，并且每个传输层在 provider 生命周期内只持有一个回调：
每次调用重建的回调没有可回退的最后 token，只会把被拒绝的 JWT 原样返回。

Provider 绑定服务端点和工作区，返回缓存前解析当前登录凭证。凭证变化使内存和待发布
结果失效；旧请求必须拒绝，不能返回旧用户的 token。持久缓存使用签发时的凭证加密，
按端点和工作区分区。它是性能优化，不构成 XSS 防护或即时撤销机制。

刷新可在现有请求中携带可选 `rejectedToken`。旧服务端可以忽略它；支持该字段的服务端
只应使匹配的缓存版本失效，并独立执行授权检查和刷新频率限制。请求体已经发出的刷新无法
携带其后到达的拒绝，因此它既不能清除该拒绝标记，也不能持久化仍被标记为拒绝的 JWT；
若持久化开始前已知道该拒绝，且响应返回该 JWT，则再发一次携带拒绝标记的请求，所有汇入的
调用方共享这一次请求。加密期间到达的拒绝会阻止持久化，但可能需要传输层再重试一次。持久化闸门
在写入前同步重新读取该标记，因为加密是异步的，而未授权失效不会改变凭证代次。只跟踪最近
一次被拒绝的 token。临时错误由传输层重试；
凭证遭到 401/403 拒绝后继续抑制请求，直到凭证变化或手动失效。

实现：`packages/shared/src/loro-streams-auth.ts`；回归测试：
`packages/shared/tests/loro-streams-auth.test.ts`。不承诺跨标签页协调。
