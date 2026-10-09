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

CLI 运行依赖固定为 `@loro-dev/roost-node@0.1.1`，发布冷却期仅豁免该版本及
六个精确匹配的平台包版本。
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

### 接入已发布的 0.1.1（2026-10-09）

用户已发布完整拆包发行版。公开 registry 可查询六个平台包和 0.1.1 主包，
`latest` 已指向 0.1.1；主包 tarball 校验值与准备好的发行产物一致。
同步升级 CLI 的固定版本和锁文件，沿用既有 Worker 与历史契约。
逐项豁免平台包的精确版本，使 pnpm 的七天发布冷却期不会在新解析时丢掉
其他系统所需的 optional 依赖。

调整已有暂存测试夹具以适配已安装的拆包布局：本机执行使用实际发布的绑定，
其他平台的选择使用各自不同的合成字节。继续覆盖相邻绑定兼容、精确版本检查及
下载失败时保留运行时，不让测试依赖网络，也不新增旧版全平台包的开发依赖。

冻结安装和完整 `pnpm check` 通过：CLI 3530 项通过、4 项既有跳过，共享组件
4885 项通过，Electron 214 项通过。开启原生版本检查后，16 项 Roost 历史及
后端回归也通过。已安装主包不含绑定，仅解析到 darwin-arm64 平台包。
六个目标的实际发布包均通过暂存：本机使用已安装包，其他目标使用生产公开 npm
下载路径；本机签名 SQLite 重开通过。其他平台的二进制仅检查选择结果，不执行。

首次桌面构建发现 CLI 发布校验还固定为 0.1.0，现已同步到 manifest 和锁文件
使用的 0.1.1，实际 bundle 的运行时 smoke 通过。
已将 main `5fc401b5ca46eb62d85449b1d8ea19308d58eadf` 合并到功能分支，唯一冲突
是相邻的 Session 命令 import，已保留 Roost 后端安装和新增只读观察命令。
Codex 子模块已检出 main 记录的提交。合并后的冻结安装、完整 `pnpm check`、
格式和文档检查通过：CLI 3590 项通过、4 项既有跳过，共享组件 4890 项通过，
Electron 214 项通过，公开仓库/平台边界检查通过。桌面构建和正常 macOS arm64
目录包探针仍需完成，交接前在此补充结果。

### 平台包兼容（2026-10-09）

本节记录此前使用 0.1.0 的兼容检查；上方已发布版本接入取代此阶段的暂缓升级步骤。

Roost 正在准备小主包和六个 optional 平台包形式的 0.1.1。Electron 暂存同时支持
0.1.0 的相邻绑定和已安装的匹配平台包；异平台打包沿用公开 npm 下载路径，只下载
主包声明的精确版本。选中的绑定复制到暂存 loader 旁，应用内仍只保留一份二进制，
并维持 Worker 的相对路径。

暂存验证已通过：覆盖六个目标、真实本机 SQLite 重开、版本不匹配及下载失败时
保留此前运行时。已有测试新增两项行为用例，使用真实已发布绑定验证安装及下载后的
拆包布局；Electron 共 214 项通过。用户发布完整 0.1.1 之前，CLI
继续固定已发布的 0.1.0，避免公开 CI 依赖尚未发布的版本。

格式、文档、类型检查、lint 和公开仓库/平台边界检查通过。正常 wrapper 生成的新
macOS arm64 目录包通过 CLI 启动、原生 Worker 和 SQLite 重开探针，Roost 只保留
一份 8,021,248 字节绑定。该应用仍使用固定的 0.1.0。上游最终 0.1.1 产物也已通过
六个真实平台包的选择，以及 Node 24.14 和实际打包 Lody Electron 可执行文件下的
签名 SQLite 重开验证，使用临时 unpacked 运行目录与合成数据库。正式依赖升级
等待用户发布完整发行版。

本机完整 `pnpm check` 在另一项 CLI 测试失败：模拟器 guest-buttons 后代进程
关闭测试在 macOS 报 `kill EPERM`（CLI 3529 项通过、4 项既有跳过）。从未改动的
HEAD `6f5332f` 导出的独立基线也复现相同失败，其余四个用例通过；未修改模拟器源码。
日志：`/private/tmp/lody-roost-split-check.log` 和
`/private/tmp/lody-roost-split-baseline-test.log`。

源码提交 `8e6cf25de374b50dbaa6b3582710d0a17b265f0c` 的全部
[CI 检查](https://github.com/LodyAI/Lody/actions/runs/37878236234)和
[桌面 E2E smoke](https://github.com/LodyAI/Lody/actions/runs/37878236205)均已通过。
上游六平台构建与完整 0.1.1 发行准备也
[通过](https://github.com/loro-dev/roost/actions/runs/37877651895)。本次没有上传 npm
或升级依赖；下方旧证据对应原接入提交。

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
