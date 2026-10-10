# 扩展工作区 Streams 工厂的内容保护接口

Status: implemented
Translation: current

[English](2026-10-10-workspace-streams-content.md)

## 摘要

渲染端工厂已有认证入口，但内容和快照配置原先固定。现在直接接收已发布 SDK 的房间保护
解析器、快照编解码器和发布准入，普通调用保留原字节格式与持久化屏障。明确要求保护时
拒绝缺配置和房间明文选择。测试使用合成保护器，产品 E2EE 和服务端准入仍需单独接入；
验证失败要停止多大范围仍未定稿。

## 决定

直接使用 `loro-repo` 0.21.1、`streams-crdt` 0.16.1 及其 `streams-client` 0.8.0，
不升级依赖、不复制同步机制。
`content` 是工厂配置，不是服务端工作区 DTO；普通 runtime 调用不变。受保护调用方提供
可信 namespace、覆盖所有房间的解析器及明确的 `snapshotUpload.canUpload`。SDK 负责
只接受受保护读取、保护写入、逻辑房间 AAD、导入和进度；调用方负责保护器与密钥。
编解码器负责压缩，不能代替验证。

万能插件注册表或未使用的能力类型没有实际必要。保留原持久化构造，延续之前的
[Streams 升级](../bug-fix/2026-09-27-streams-crdt-0.16-upgrade.zh.md) 的兼容边界。
[契约草案](../../../../specs/workspace-streams-content.zh.md) 记录此接口。

## 验证与限制

已有测试套件使用真实 Loro/Flock、IndexedDB 存储（fake-indexeddb）、只保存字节的 HTTP
测试服务器和信号/假时钟。覆盖独立副本离线编辑后收敛、原更新帧、快照导入与发布、
Meta/Flock 进度、真实存储保存失败、验证拒绝时不推进游标、重试及无本地写入的读端重连。
可逆测试保护器只验证 SDK 的 AAD 接线，明确不属于密码学实现。

局部验证：工厂 24 项和相邻游标/runtime/router 56 项测试通过。components 源码及本测试文件
类型检查、局部类型感知 lint、格式与 `pnpm run docs check` 通过（原有文档警告仍在）。
components 全量 5032 项通过；根目录 `pnpm format`、类型、lint 和边界检查通过。
全仓 `pnpm check` 未全绿：未修改的 CLI 原生 SSH 子模块测试遇到当前 Git helper 的
`context_unreadable`，单独复跑仍为 5 过、1 败。IPC 的沙箱失败在允许 socket 后消失
（9 项通过）；没有修改无关 Git 代码。

SDK 的发布准入没有房间参数，也不是服务端准入。Repo 0.21.1 保留清洗后的
`payload_protection_error` 消息，但错误码归入 `internal`。
已从源码核对上游 `encodeStreamsRoomAdditionalData` helper 和只读
`payloadProtectionReason` 字段，本次尚未消费，正式发布和依赖接入另行跟进。
可信宿主的快照准入必须通过上游 helper 绑定相同 namespace 和逻辑房间 AAD，
不能在本工厂复制编码，也不能信任上传数据自报的身份字段。核心的
`bindAdditionalData` 接入不属于本工厂的测试验收。
本次不新增故障范围政策、
密钥服务、持久化模式、生产创建入口、服务端存储变更或整个 runtime 重写。
真实加密核心接入、在线和打包后平台验收仍需单独完成。
