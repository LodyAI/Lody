# 有上限的云查询恢复

Status: draft
Translation: current

[English](cloud-query-recovery.md)

## 行为

已认证云查询出现不透明的服务端错误时，先进入局部加载状态，最多重试三次，
分别等待 1、2、4 秒。同一个客户端、认证 session、函数和参数的所有消费者
共享一次订阅及预算。每次重试先释放失败的订阅，再等待新的服务端更新；
缓存的旧错误不能消耗下一次机会。服务端错误恢复期间，不返回过期的授权行。

短暂成功及临时认证 skip 不补充重试次数。只有持续观察到成功结果达 30 秒，
才清零预算。调用方显式 skip 或卸载后，不在后台重试。认证 session 或查询
参数变化后，不得采用其他作用域的结果或待执行重试回调。

结构化应用错误不自动重试。认证过期遵循独立的[认证恢复约定](auth-recovery.zh.md)。
公开查询、mutation 和 action 保持原行为；纯本地客户端不会因此启用云请求。

查询重试耗尽后，错误抛给最近的 React 边界。运行时 provider 在 Outlet 边界
上方也有兜底。可复制诊断的错误页持续显示，直到用户明确恢复。持续失败的
运行时查询仍可能让整个应用显示该错误页；本约定不保证不可用的云数据仍能使用，
也无法确定托管查询为何失败。

## 依据

- 查询适配：`packages/components/src/hooks/use-recoverable-convex-query.ts`。
- 运行时兜底：`packages/components/src/routes/__root.tsx`。
- 行为测试：`packages/components/tests/use-recoverable-convex-query.test.tsx`。
