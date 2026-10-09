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

## 历史修改与命令路由

状态修正不能重置 active view 或重新创建 sealed primary。可修改的状态记录绑定到
对应 primary，读取时投影为同一业务 turn。权限回应使用 SDK 的独立 response 记录，
reader 将结果合并到对应工具，不封存仍在输出的 assistant。普通变更只刷新受影响的正文。

结构复制、编辑和导入通过公开 SDK 操作，在独立 generation 中准备完整历史；再以一次
原生 event-cursor CAS，在旧流中发布应用自有的签名激活记录。准备失败或旧流并发写入
都会保留旧分支。不复制 SDK envelope/index 格式，也不重写 sealed 数据。
串行 generation 解析及旧 handle 写入保护，避免并发读写使用被替换的视图。
激活确认丢失后，数量/位置读取先刷新到已提交视图；本地写入屏障补发该投影，
RPC 再绑定其持久控制版本。恢复不会重放 indeterminate 操作。
旧 generation 保留归档；本次修复不建立回收机制或任意旧适配器降级兼容。

ACP 输出与稳定的逐项 receipt 一起提交，包括分块批次；重试可在旧 generation 中查找
receipt。导入基线和源 cursor 与激活记录同时提交；Loro cursor 写入失败返回 indeterminate，
重开读取已提交的原生基线。条件式尾部回滚保留后续追加，拒绝覆盖并发编辑。
Fork 使用共享 writer 唯一的来源校验表，整批检查冲突后再整体前插。

Cloud 的两个 one-shot manager 入口注入相同 owner RPC 组合，覆盖会话命令、导出和 MCP
历史查询。原生执行仍由 daemon 负责；仅本地 MCP 复用其 manager，访问检查拒绝其他机器。
RPC directory 读取按 owner count 截断，每次最多 500 行；revision 变化时重读。
Fork/Edit & Resend 保留 owner saga，不跨 RPC 传递进程内快照和补偿 handle。
新会话偏好在任何持久写入前检查目标能力。

## 验证

### 生产适配器修复（2026-10-09）

最终窄化测试 27 项通过：23 项使用真实 SessionDocument、LoroRepo 和已发布原生
SQLite 的生产历史契约，加上 4 项 RPC/后端测试。覆盖队列七个持久阶段失败、sealed
状态修正、权限后工具稀疏更新及文字输出、源关闭后跨会话 Fork、不透明已存值、私有
准备失败、并发 generation 解析、stale 激活/旧 handle、逐项 receipt 重试、条件回滚、
导入 cursor 失败后重开，以及激活确认丢失后的数量/位置读取。恢复屏障补发已提交
投影，不重放原操作。

传输测试使用实际 RPC range schema 和 revision 重试。真实 owner SQLite 组合测试
覆盖共享 Cloud 工厂及 owner 失败传播；renderer 测试验证不支持的显式 Roost 请求
在创建副作用前失败。完整 `pnpm check` 通过：CLI 3604 项、4 项既有跳过，shared
1302 项、共享组件 4892 项、Electron 214 项通过。格式、文档、公开仓库/平台检查
及重新构建的 CLI 发布产物 smoke 也通过。

合成生产基准使用 100/1000 条历史和 4 KiB 正文，预热一次后各测两次。
Roost 首屏及向前翻页各读取一个 40-turn page；十次流式更新不读取完整历史或
branch page。基准不覆盖 RPC、renderer 绘制、IndexedDB、真实 Provider 执行及频繁
切换 generation。日志：`/private/tmp/lody-roost-repair-bench.json`、
`/private/tmp/lody-roost-native-contract.log`、`/private/tmp/lody-roost-repair-check.log`
及 `/private/tmp/lody-roost-repair-published-bundle.log`。
本次继续使用现有 0.1.1 运行时，不需要重新 npm 发布。

### 已发布运行时与打包检查点

用户已发布全部六个平台包和 0.1.1 主包。主包 tarball 校验值与准备好的发行产物一致；
已安装主包不含绑定，仅解析当前平台。六个目标的实际发布包都通过暂存，分别使用
已安装的本机包或生产公开 npm 下载路径。夹具覆盖相邻/拆包布局、精确版本不匹配
及下载失败时保留可用运行时。本机签名 SQLite 重开通过；其他平台的二进制在本机
仅检查选择结果，上游六平台发行
[CI](https://github.com/loro-dev/roost/actions/runs/37877651895) 提供相应执行验证。

本次历史修复之前，源码 `8b1073e0ceef32829b0230ab64801f6a34e36c01` 已通过
[CI](https://github.com/LodyAI/Lody/actions/runs/37889429418)及
[桌面 E2E](https://github.com/LodyAI/Lody/actions/runs/37889429365)。
正常 CLI 构建使用 2 GiB 堆限制；renderer 使用其正常配置，产物不含原生 Roost 导入。
正常 macOS arm64 OSS 0.104.0 目录打包通过实际 CLI 启动、原生绑定及 Worker 的
签名 SQLite 写入/重开探针。应用包含原生运行时 0.1.1 和唯一一份 8,021,248 字节
本机绑定，其 SHA-256 为
`1d0e23d144491d5e566de679a6a9e2477332027a98e86af74849a4c60a983d93`，与发布产物一致。
此打包检查点早于适配器修复，不代表发布了新的签名应用。
日志：`/private/tmp/lody-roost-011-check-merged.log`、
`/private/tmp/lody-roost-011-package.log` 和 `/private/tmp/lody-roost-011-platforms.log`。

私有 Web/移动应用构建、远程部署、浏览器本地离线副本、其他平台完整桌面包、
发行签名/公证及旧 generation 回收不属于本次验证。
测试数据库均为隔离的合成数据，没有使用用户历史。
