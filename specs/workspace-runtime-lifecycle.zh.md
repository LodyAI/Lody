# 工作区连接的生命周期

Status: draft
Translation: current

[English](workspace-runtime-lifecycle.md)

切换账号或工作区时，旧连接可能仍在获取 token 或房间。旧结果不能进入新工作区。离线文档的本地 commit 在正常关闭后仍需可用。

## 契约

- RuntimeProvider 立即停用旧发布回调，取消未完成的初始化，等待清理后才打开下一个 runtime。
- 连接启动失败时，通过已建立 runtime 的同一关闭路径释放资源。
- 重复关闭共享同一完成结果。关闭取消 token HTTP，禁止新 attach／重连；晚到结果不能发布 client 或订阅。等待所拥有的 attach、Meta 获取和重连结束后，才销毁 Repo。
- 断网暂停可以恢复；永久关闭后不能再次启动。
- Repo 继续负责持久化。已 commit 的离线修改由原关闭路径保留；关闭不要求远端确认上传。
- 普通 stream ID、存储名称、格式和游标顺序不变。本次不增加 E2EE 模式、密钥或密码学行为。

不可取消的 SDK 操作结束前，不销毁其依赖；本次不新增关闭期限。契约仅覆盖选定连接资源，不覆盖全部后台工作流或内存中暂存发送。

## 证据

- [Runtime](../packages/components/src/providers/create-workspace-runtime.ts)
- [测试](../packages/components/tests/create-workspace-runtime-meta-recovery.test.ts)
- [决定](../.agents/notes/implemented/architecture/2026-10-10-workspace-connection-lifetime.zh.md)
