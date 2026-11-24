# 客户端插件读取

[English](README.md)

离线界面优先使用 `lodyQueries`。`sessionSetAnnotation` 和 `projectSetAnnotation` 接受 `{ value }`（JSON，UTF-8 序列化后不超过 4 KiB）。命名空间由宿主根据插件身份确定；同步后的摘要通过 `annotations[pluginId]` 暴露该值。

machine 侧调用 `ctx.invalidate` 会增加该安装的 catalog 修订号。下一次 catalog 轮询会刷新该插件的查询缓存，但不会重新求值模块；客户端不比对失效目标，因此该插件的全部查询会在轮询间隔内重新取数。

显式声明 `unstable.rawState` 后，可通过 `lody.unstable.readSnapshot` 或 `useUnstableLodySnapshot` 读取白名单投影。结果是脱离原文档的深冻结 JSON，包括外壳在内最多 512 KiB；字段不受 SemVer 稳定性保证。未订阅时不会打开数据源，最后一个订阅者离开时释放它。

- `workspace-state`：用 `path: [collection, key, ...fields]` 选取一个可见实体。集合包括 `sessions`、`projects`、`machines`、`roles`、`schedules` 和 `rateLimits`。本地项目和额度键分别是 `machineId:localProjectId` 和 `machineId:rateLimitEntryKey`。
- `project-state`：指定可见项目和非空字段路径。`session-meta` 选取单个可见 Session；只有创建它的插件能读到 `businessKey`。
- `session-transcript`：指定 1–100 个 `turnIds`，或用 1–100 的 `limit` 读取最近窗口，不能同时指定。宿主只读取对应历史记录。
