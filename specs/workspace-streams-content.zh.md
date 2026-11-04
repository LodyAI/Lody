# 工作区 Streams 内容接口

Status: draft
Translation: current

[English](workspace-streams-content.md)

普通工作区继续使用现有 transport 工厂，后续需要保护内容的调用方可以注入处理实现。
此接口不开放 E2EE，不判断持久化的工作区模式，也不证明设备具有权限。

## 契约

- 省略内容配置或明确选择 `plaintext` 时，保留流名称、认证、带长度更新格式、共享快照
  编解码器、默认发布与 Repo 持久化。先保存数据再推进游标；Meta/Flock 进度仍绑定到
  实际载入数据的副本。
- `protected` 必须提供可信逻辑 namespace、SDK 房间解析器和明确的快照发布准入。
  Meta、Loro 文档与命名 Flock 都必须选择保护。未知模式、缺少配置和明文选择均拒绝。
- SDK 将 namespace 和逻辑房间绑定到保护器 AAD。调用方从可信应用状态提供身份，不能
  从数据包或路由 URL 推导，并负责保护器/密钥生命周期。工厂不取钥匙、不解释权限账本。
- 同一个保护器处理更新和快照。可选编解码器只负责保护前压缩、验证后解压，默认仍用
  共享编解码器。SDK 的 `canUpload` 控制尽力发布，没有房间参数，也不是服务端准入。
- 验证、导入或保存失败时保留 SDK 错误和进度行为。不跳过被拒绝的字节、不越过尚未保存
  的数据、不改走明文。此接口不新增工作区级停止或恢复政策。

## 未定事项与边界

单文档验证失败要停该文档还是整个工作区，仍待决定。持久化模式发现、旧版隔离、真实缺钥
状态、密码学实现与服务端快照准入属于后续工作。当前 SDK 清洗保护器错误，Repo 错误消息
保留 `payload_protection_error`，但错误码归入 `internal`。

## 证据

- [工厂](../packages/components/src/providers/workspace-streams-transport.ts)
- [行为测试](../packages/components/tests/workspace-streams-transport.test.ts)
- [决定](../.agents/notes/implemented/architecture/2026-10-10-workspace-streams-content.zh.md)
