# 客户端插件读取

[English](README.md)

`lody plugin pack ./my-plugin -o release.tgz > release.json` 生成归档和 npm 安装记录。发布到 npm 时请使用**这份归档**；重新打包会改变完整性摘要。在**设置 → 插件**导入 `release.json` 后，工作区成员就能查看插件声明的权限。导入不等于批准执行。本地目录或归档安装仍绑定原机器。

要在所属机器上安装并将校验后的记录写入加密工作区，请运行 `lody plugin install-npm <name> <exact-version> --integrity <sha512-SRI> --encrypted-workspace <id>`，并确认守护进程的授权提示。

在**设置 → 插件**为固定版本勾选“在我的机器上安装”，即签署仅对自己机器生效的授权。新安装默认禁用，不复制密钥，也不创建工作流授权。同步不会自动升级已有安装；取消勾选仅停止后续安装，不会卸载已有副本。批准同步的个人设备需要在线并打开该工作区，无需停留在设置页。它仅为本机已记住的确切版本自动签署目标机器的新挑战；其他个人设备不继承此授权。

同一插件安装在多台机器上时，只有一个客户端实例注册工作区界面。查询和修改按目标机器选择已启用安装的传输方式与 digest，不会因为界面注册在另一台机器就改发给它。目标离线返回 `machine_offline`，在线但未安装或未启用返回 `not_found`。

插件 screen 使用 `/$workspaceName/p/$pluginId/$screenId`。`nav: "sidebar"` 同时提供侧栏和命令面板入口；`lody.screens.setParams` 更新当前地址的查询参数。项目页有独立地址和页面选择器；Session 面板通过 `?panel=<pluginId>:<panelId>` 打开，宽屏与会话并排显示，窄屏使用抽屉。若本地插件的来源机器离线，已见过该安装的设备保留地址并显示离线状态，不会执行缓存的本地插件。

项目配置按机器、插件和项目存在工作区 Flock 文档中。机器离线时仍可读缓存；加密工作区写入要求工作区写权限，以及机主或当前项目共享授权。完整配置的 UTF-8 JSON 不得超过 16 KiB。

离线界面优先使用 `lodyQueries`。`sessionSetAnnotation` 和 `projectSetAnnotation` 接受 `{ value }`（JSON，UTF-8 序列化后不超过 4 KiB）。命名空间由宿主根据插件身份确定；同步后的摘要通过 `annotations[pluginId]` 暴露该值。

machine 侧调用 `ctx.invalidate` 会增加该安装的 catalog 修订号。下一次 catalog 轮询会刷新该插件的查询缓存，但不会重新求值模块；客户端不比对失效目标，因此该插件的全部查询会在轮询间隔内重新取数。

显式声明 `unstable.rawState` 后，可通过 `lody.unstable.readSnapshot` 或 `useUnstableLodySnapshot` 读取白名单投影。结果是脱离原文档的深冻结 JSON，包括外壳在内最多 512 KiB；字段不受 SemVer 稳定性保证。未订阅时不会打开数据源，最后一个订阅者离开时释放它。

- `workspace-state`：用 `path: [collection, key, ...fields]` 选取一个可见实体。集合包括 `sessions`、`projects`、`machines`、`roles`、`schedules` 和 `rateLimits`。本地项目和额度键分别是 `machineId:localProjectId` 和 `machineId:rateLimitEntryKey`。
- `project-state`：指定可见项目和非空字段路径。`session-meta` 选取单个可见 Session；只有创建它的插件能读到 `businessKey`。
- `session-transcript`：指定 1–100 个 `turnIds`，或用 1–100 的 `limit` 读取最近窗口，不能同时指定。宿主只读取对应历史记录。
