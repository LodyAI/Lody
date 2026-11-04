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

原生 provider 在 Scope 下拥有共享刷新。一个等待者取消或超时不取消其他租约。
最后租约释放、凭据替换和关闭在交接前取消并等待真实 I/O。Raw 工作不配合 abort 时，
有界清理失败保留旧拥有者和完整 Cause；成功显式恢复后才允许替换。并发 close 共享
完成/失败结果。Timeout、取消不能投影为 undefined auth 成功。
Native getToken/auth 保留 terminal auth typed failure；只有显式 Legacy 旧协议 callback
将非空、全 auth Cause 投影为 undefined，混合 Cause 保留所有其他失败原因。
诊断快照不含凭据、JWT、URL、原始错误内容或 owner；恢复仍保留原始完整 Cause。
Promise 调用方在拥有者迁移前保留唯一显式 Legacy 门面。

实现：`packages/shared/src/loro-streams-auth.ts` 和[原生 provider](../packages/shared/src/loro-streams-token/README.md)；回归测试：
`packages/shared/tests/loro-streams-auth.test.ts`。不承诺跨标签页协调。
