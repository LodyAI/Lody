# 将 Streams 客户端运行时升级到 0.16.0

Status: implemented
Translation: current

[English](2026-09-27-streams-crdt-0.16-upgrade.md)

PR：[LodyAI/Lody#1044](https://github.com/LodyAI/Lody/pull/1044)

## 摘要

presence 可能在慢请求后积压同 key 的过期状态，卡住的 token 回调也可能让请求无限等待。
本次锁定 streams-crdt 0.16.0 及其 streams-client 0.8.0 依赖，三个构造入口均继续使用
现有的内置 Loro adaptor。测试通过真实前端工厂、真实 Loro store 与可控 HTTP 响应，验证
未发送更新替换、在途保留、同步等待和 token 超时恢复。本次仅升级客户端；服务端房间保留、
缓冲容量和 TTL 部署仍独立，发布方的频率与大小限制继续有效。

## 依赖决策

CLI、components、shared 通过 catalog 使用 `@loro-dev/streams-crdt`。带现有补丁的
`loro-repo@0.20.0` 将它作为 peer 使用，没有内嵌副本。其声明范围为 `^0.15.0`；完成下述
API 比较与运行时检查后，通过仅针对该包的 `peerDependencyRules.allowedVersions` 放行
0.16.0。现有 loro-repo 补丁不变。全局 peer override 或无关的 loro-repo 升级会扩大兼容性
决策范围，本次不需要。

`@lody/loro-streams-rpc` 直接使用 streams-client，因此它的 catalog 同步升级到 0.8.0。
锁文件仅为独立开发工具 `@loro-dev/loro-cli@0.6.0` 保留 streams-client 0.7.0。
七个锁定的 ACP 子模块均已初始化并检查 manifests/lockfiles，没有依赖这些 Streams 包。
未发现 vendored Streams 实现或 Streams 补丁。仅对本次明确要求的两个精确版本添加发版
等待期例外，不放宽未来版本的等待期。

## 兼容性证据

比较了 npm 官方 tarball 中 streams-crdt 0.15.1/0.16.0、streams-client 0.7.0/0.8.0 的
全部公开声明入口与实际运行时代码。发版对应[上游 PR #394](https://github.com/loro-dev/loro-streams/pull/394)，
合并提交为 `ee6d7bcdcd625f85083894d75a2c53f17c139c87`。

- 没有移除 Lody 使用的公开 API。LoroDoc/Flock adaptor 实现与 zstd 入口维持现有契约；
  ephemeral adaptor 新增可选 `localUpdateKey` 与导出的 key 读取函数。client 向后读取接口
  是新增能力，本次没有使用。
- snapshot protection 新增 `continuationOffset` 上下文，bootstrap 校验非空快照位置。
  Lody 没有配置 payload-protection provider。测试使用真实 Loro 快照、现有 shared codec
  与有效的 continuation header，覆盖原始快照和 zstd 压缩快照恢复。
- HTTP client 新增 token/body 等待期限、long-poll 宽限和 SSE 空闲处理；截断 multipart
  会失败，EOF 时未结束的 SSE event 被丢弃。这些确实改变行为，不能称为整包语义完全等价。
  RPC 测试覆盖 Lody 的现有 SSE/long-poll 与请求路径，没有访问托管端点。

## Presence 接入

```text
CLI presence / CLI machine-monitor / 前端 EphemeralRoomTransport
  -> EphemeralStoreAdaptor(真实 EphemeralStore)
    -> localUpdateKey(单 key set/delete)
      -> EphemeralStreamCrdt 0.16.0 串行队列
        -> 首次取 token 与 unauthorized 刷新的超时
```

这些入口直接传入 adaptor，没有需要转发可选能力的自定义包装。稳定 key 下的值表示完整
当前状态，允许新值替代尚未发送的旧值。在途请求、无法识别 key 或多 key 更新不能替换。
没有拼接或重新编码字节。生产工厂回归测试依次产生在途值、100 次同 key 过期值、独立心跳
和最终 set/delete；对端收到三个 POST，并得到预期最终状态。最终替代值确认前，同步等待
不会提前完成。测试显式推进 Loro 时间戳，不依赖真实操作恰好跨越毫秒边界。

`pendingLocalCount` 仍表示尚未确认的逻辑更新数，包括队列中被替代的值，不是 HTTP 请求数。
现有诊断按此含义继续有效。房间 joined 仍不能证明及时送达。本次更新
[presence Spec](../../../../specs/loro-ephemeral-presence-channel.zh.md) 与
[CLI 指南](../../../docs/cli-lib-loro-presence.md) 中的现行队列说明，扩展此前的
[发布预算决策](../architecture/2026-09-20-ephemeral-presence-channel-budget.zh.md)，
不移除频率和大小约束。

## 验证与限制

针对性检查覆盖 components presence/monitor/recovery（25 项）、shared presence、认证与
快照 codec（45 项）、CLI presence/monitor/session/document 与 relay authorship（45 项），
以及 RPC（119 项通过，3 项需显式启用的服务集成测试跳过）。受影响包类型检查、静态边界检查、
格式化、冻结锁文件离线安装、文档检查和最终完整 `pnpm check` 均通过。全仓运行包括
components 4,338 项、CLI 3,097 项、shared 1,214 项、RPC 119 项测试；4 项 CLI 与
3 项服务集成测试保留原有跳过条件。

本次没有部署生产，也没有进行线上 presence 验收。服务端房间保留、缓冲 16、服务端 TTL 90s
需要另行部署。现有客户端 presence 时效和 TTL 常量不变。
