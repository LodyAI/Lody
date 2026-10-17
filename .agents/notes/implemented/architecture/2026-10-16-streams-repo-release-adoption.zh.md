# 接入正式发布的 Streams 与 Repo 依赖

Status: implemented
Translation: current
PR: [#1607](https://github.com/LodyAI/Lody/pull/1607)

[English](2026-10-16-streams-repo-release-adoption.md)

## 摘要

迁移 WorkspaceData 所有权前，Lody 需要正式发布的原生 Repo 与纯上传合同。
共享 catalog 现已消费 Client 0.12.0、CRDT 0.19.0 和 Repo 0.23.0，保留 Effect 4.0.2
及现有产品所有权。这三个受控包的精确发布时间例外已获得明确授权；默认七天
隔离保持不变。现有真实 SDK 消费套件在实际安装图上通过，产品 durable 消费者
仍使用 Promise API。

## 依赖边界

SDK 整合见 [loro-streams #425](https://github.com/loro-dev/loro-streams/pull/425)。
正式 [Client 0.12.0](https://github.com/loro-dev/loro-streams/releases/tag/streams-client-v0.12.0)
先于 [CRDT 0.19.0](https://github.com/loro-dev/loro-streams/releases/tag/streams-crdt-v0.19.0)
发布；后者精确依赖 Client 0.12.0。
[Repo 0.23.0](https://github.com/loro-dev/loro-repo/releases/tag/loro-repo-v0.23.0)
包含 #150–#153，并以可选 peer 范围支持该 SDK。已核对三个版本的 registry
完整性与 peer 元数据。

lock 差异仅替换这三个包族及其 peer 引用。Effect 4.0.2、Loro 1.16.3、Flock WASM
0.4.4、已有的两个 SQLite 版本、认证、托管运行时及独立消费者所需的旧 SDK
继续锁定；没有本地源码或 tarball override。
[前次 Repo 接入](../bug-fix/2026-10-10-loro-repo-0.22-upgrade.zh.md) 保留旧图历史；
[presence 所有权](2026-10-12-effect-workspace-presence.zh.md) 保留已有 native／Legacy 边界。

## 发布时间与解析决策

保留 `minimumReleaseAge: 10080`。仅把 Client 0.12.0、CRDT 0.19.0 和 Repo 0.23.0
加入已有逐包精确例外，保留已允许的旧版本。另一选项是等待七天；所有者已于
2026-10-16 明确授权接入这些受控版本。后续版本仍须隔离。

全 workspace 重新解析也会尝试解析已经锁定的 ACP SDK 1.8.0，被其独立的发布时间
检查拦住。因此使用 pnpm 10.20.0 在小 workspace 中按同一年龄规则及既有 peer
版本解析本次包族，再把生成的 package／snapshot 记录和对应消费者引用应用到
主 lockfile。语义比对确认无关包记录和 importer 依赖未变；随后冻结安装验证了
完整 workspace 图。

## 消费者兼容性

Repo 0.23.0 的 Streams 上下文类型间接使用未导出的 SDK 类型，导致共享错误工具的
推导返回类型触发 TS4023。现在给投影结果显式标注基于公开 `RepoTransportError`
属性的类型；字段白名单、错误识别、重试和日志行为不变。共享包声明检查已通过。

Client 0.12.0 把上传与连接期限分开，bulk 上传默认 60 秒。Machine RPC append 原先
使用 10 秒连接／请求期限，因此 JSON RPC 适配器对 append 显式保留
`uploadTimeoutMs ?? connectTimeoutMs ?? 10000`，保持产品行为并允许显式上传覆盖。
持久文档上传继续使用 SDK 策略。真实 SDK 的 Roost bridge 测试复现了旧期限回归，
以 fake timer 和实际 fetch 开始信号覆盖默认、自定义连接期限及显式上传覆盖；
替换原有仅比较构造参数的 timeout 测试。RPC 所有权仍为 Promise，本次配置边界
不迁移它的生命周期。

## 验证与限制

实际升级安装图上的消费套件通过：RPC 133 项、3 项配置的集成跳过；renderer
Streams／presence 49 项；shared auth／Streams／snapshot codec 75 项；CLI 检查点／
SQLite／恢复／presence 55 项；Roost backend bridge 17 项，共 329 项通过。消费者实际解析到 Repo 0.23.0、
CRDT 0.19.0、Client 0.12.0，并共享同一个 Effect 4.0.2 包身份。

workspace 冻结安装、全包类型检查、lint、Effect lint、i18n 及全部仓库边界检查通过。
格式化、2048 MiB 堆预算内的 CLI 生产 bundle、发布导入检查、CLI `--version` 冒烟，
以及 Electron OSS main／preload／renderer 构建通过。文档检查为零错误、68 个既有
警告。回归使用 `NODE_ENV=test`，生产 React 不导出 `act`。完整回归及浏览器结果
记录在所链接 PR 的检查中。

原生 WorkspaceData 所有权、renderer 迁移、存储搬迁及浏览器真实服务验收仍是
独立工作。上游间歇性的 SQLite 析构断言尚未定位；本次依赖升级不声称修复它，
也不替换 Lody 现有 SQLite 版本。

同一个 #1607 随后的消费者迁移记录在[原生 workspace 所有权](../../proposed/architecture/2026-10-16-native-workspace-repo.zh.md)；上面的依赖接入验证早于该实现。
