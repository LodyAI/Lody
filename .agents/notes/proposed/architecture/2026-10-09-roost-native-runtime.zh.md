# Roost 原生运行时与共享客户端

Status: proposed
Type: architecture
Translation: current
PR: [#1329](https://github.com/LodyAI/Lody/pull/1329)

[English](2026-10-09-roost-native-runtime.md)

## 摘要

此前 npm 历史适配器依赖另行构建的 Roost 可执行文件，公开 Lody 仓库无法独立构建和打包实验性后端。
CLI 现在接入已发布的 Node-API 包，在 Worker 内运行 SQLite 实现；Electron 随包携带目标平台的原生产物。
共享 Web 和移动客户端沿用现有历史 RPC 接口。这次接入不建立浏览器本地 IndexedDB 副本或离线 Streams 同步。

## 决策与边界

CLI 运行依赖固定为 `@loro-dev/roost-node@0.1.0`，发布冷却期仅豁免该版本。
保留 `@loro-dev/roost@0.1.2` 的身份、应用 JSON 和 `NodeLodyHistory` 适配器。
安装、构建和打包 Lody 无须 Rust 源码或旁边的 Roost 仓库。

直接使用 `RoostNativeClient`，保留数据库位置、系统凭据存储中的种子、允许的签名身份、
有界队列、共享流租约及最终关闭等待。Worker 初始化失败时先关闭该客户端。
移除子进程可执行文件和客户端路径的发现逻辑；历史方案见
[迁移提案](2026-09-30-roost-transition-delivery-lifecycle.zh.md)。

原生 npm 包保持外置，客户端、Worker 和绑定保留相对路径。
Electron 将其放在 `resources/cli/node_modules`，签名前复制到 `app.asar.unpacked`。
每份桌面产物只携带已发布的 macOS、Windows MSVC、Linux GNU 的 arm64/x64 六种绑定中的一种。
不支持的目标在打包时失败。Linux musl 不受支持，已发布的 Linux 构建要求 glibc 2.35 或更新版本。

复用共享组件的 Web/iOS 不导入 Node 原生包。现有远程历史桥通过所属电脑公布的
`sessionHistory: 2` RPC 契约读写，因此电脑必须在线。浏览器包提供 Roost 存储实现，
但本仓库没有组装 IndexedDB 副本，也不因此新增同步调度器。
Web/移动应用源码不属于本公开仓库范围。

[功能开关](../feature/2026-10-08-roost-history-feature-gate.zh.md) 继续决定新会话选择。
Loro 仍是默认后端；既有会话的后端标识、历史、Loro 控制元数据及传输授权保持原契约。

## 验证

实际发布 tarball 的完整性与准备好的发行产物一致。独立消费者在 Node 24.14 和
Electron 43.7.6 下通过签名历史批次、SQLite 重开及加密 Streams 回环验证。
这验证已发布原生包，不代表 Lody 远程部署或移动应用完成验证。

三个已有原生历史适配器测试不依赖旁边的仓库，不再跳过。生产后端的合成基准打开真实
`SessionDocument`，通过共享视图读取 80 条历史、向前分页并更新助手输出。
合成的已封存历史数据库从旧可执行版切到原生绑定、再切回旧版后仍可读取；
对照使用 macOS arm64 debug 构建，没有把另一检出中存放的 Linux 产物当成本机程序。

`pnpm install --frozen-lockfile`、`pnpm check`、`pnpm format`、文档检查及公开仓库/平台边界检查均通过。
CLI 有 3530 项通过、4 项既有跳过；共享组件有 4885 项通过；Electron 有 212 项通过。
此前四个 CLI 失败来自过期测试契约：runtime-config 写入需要等待，机器能力包含 `sessionHistory: 2`。

`pnpm --dir apps/electron build` 在 CLI 的 2 GiB 构建堆限制下通过，renderer 产物没有原生 Roost 导入。
经 `package-electron.mjs` 禁止发布生成的 macOS arm64 目录包通过实际应用内 CLI 启动、
原生 Worker、SQLite 写入/重开及已有原生依赖探针。这是本地打包验证，不是签名、公证发行。

打包测试选择六份已发布绑定，在本机目标下通过暂存后的 Worker 写入及重开 SQLite，
并确认拒绝不支持的目标后此前运行时仍可用。本地仅选择、检查其他平台绑定文件，不执行它们。
原生包上游六种 runner 的 CI 提供对应平台运行证据；Lody 远程部署、私有 Web/移动应用构建、
浏览器离线副本及非本机目标的完整桌面包不属于本次验证。
