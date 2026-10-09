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
普通末尾编辑在同一 Session 内复用签名前缀，共享 reader 避免在流式更新时重建未变的业务事实。
完整历史覆盖和设备级响应速度仍是验收边界。

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

一般结构复制和导入编辑通过公开 SDK 操作，在独立 generation 中准备完整历史；再以一次
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

## 保持同一对话的性能优化

对 `d074e53` 的扩展基线测试表明，整体长对话目标尚未达成：最新窗口读取有界，但
末尾用户消息的编辑仍复制保留前缀，reader 在普通文字增量时重建全量目录和事实数组。
单次结构探测测得 1000 行编辑耗时 7881 ms，6000 行耗时 53823 ms（约 3000 组
合成用户/助手往返）。可重复的打开基线使用七次测量、两次预热；6000 行的 Roost
最新 40 条打开中位数为 69 ms，Loro 为 531 ms。这些结果不证明绘制、输入延迟或
完整历史覆盖的性能。

普通尾部编辑现在在同一原生 stream 和 view 中调用公开 SDK 的 fork/restore 操作，
复用保留前缀的 Turn id 和 sealed 字节；不创建或跳转 Lody Session。封存的应用 epoch
与激活原子写入。原生 cursor CAS 防止并发写入改变已校验的资格，绑定 epoch 的旧
handle 不能继续向失效 suffix 写入。若编辑后没有追加，条件回滚恢复原 head；有后续
追加时沿用整代补偿以保留这些数据。同 id 替换、任意结构编辑及导入/复制仍使用全量暂存。
重新追加已移除的业务身份时，若旧 SDK binding 仍存在，也暂存新 generation；这样保留
共享 append 契约，并避免旧内容重新激活。

精确匹配 cursor 的本地目标 projection 避免 active-goal 校验反复物化前缀。它来自
从尾部连续读取的分页，或一次完整权威读取。writer 记录本次原生 update receipt 和
可能的 index event，仅当观察到的事件全部有相应证据时推进 projection。其他 writer
的变更、损坏的缓存、不完整的覆盖或过大的事件范围都会放弃复用并刷新权威状态。
该索引是可丢弃的派生数据，不是命令 receipt 或同步权威。旧历史可能需先执行一次完整
目标校验以建立覆盖，不强制迁移。

相邻反向页只替换 sentinel slot。状态/权限 projection 使用八条有界并行通道，目录
响应复用已投影的页面。共享目录 hook 只更新显式报告的 metadata 身份；业务消费方
不包含文字摘要，大纲仍读取实时摘要。已 hydration 的事实仅在重新派生并比较语义值
后复用旧的小对象；被 evict 的修改仍先丢弃旧事实，再后台派生。可见文字、目标/权限
结果、草稿焦点、选区和顺序继续按原契约更新。

取舍仍需说明：完整事实/搜索覆盖会在有界后台块中读取未见历史，大段可编辑 suffix
仍有工作量，归档分支尚无回收，保留后续追加的回滚可能复制 generation。浏览器/移动
部署及设备级帧耗时、输入延迟和内存验收，需要独立证据。

## 验证

### 同一会话性能检查点（2026-10-09）

原生历史窄化测试现在通过 27 项契约，完整检查另包含 4 项 RPC/后端测试。新增用例
验证物理前缀 Turn id 保留、同一 Session 重开、激活方和其他实例的旧 handle 隔离、
回滚、重新追加已移除的身份、窗口外 active goal 校验、损坏缓存恢复、其他 writer
写入，以及 fork 确认丢失。reader/React/derivation 窄化测试通过 52 项。另将现有
React 流式契约夹具扩展到 6,000 条：业务事实、草稿值、焦点及选区保持稳定，可见
正文和大纲摘要正常更新，一次文字增量只观察到 25 次索引访问，没有遍历整个目录。
这是功能证据，不是帧耗时或输入延迟测量。

完整 `pnpm check` 通过：CLI 3608 项、4 项既有跳过，shared 1302 项、共享组件
4894 项、Electron 214 项通过。`pnpm build` 通过。本机原样桌面 smoke 按系统选择
中文，英文 Settings 选择器失败。使用隔离英文 profile 重跑后完成四条 P0 旅程，
随后因 macOS 请求 Safe Storage 钥匙串授权而停止；本机完整桌面 smoke 不记作通过。
两次运行均不修改产品语言行为，也不构成 Roost 桌面性能验收。

最终生产基准使用已发布的真实 SQLite、每次新建 backend/view、已预热的 OS page
cache，机器为 Apple M4 / macOS arm64 / Node 24.14.0；正文 4 KiB，预热一次，
正式测量五次。以下是中位数，单位毫秒：

| 历史条数 | Roost 最新 40 条 | Loro 最新 40 条 | Roost 向前 40 条 | Roost 最后用户回合编辑 | Roost 完整目录 |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 49.7 | 79.4 | 32.1 | 36.9 | 725.2 |
| 6,000 | 55.5 | 431.2 | 36.9 | 48.4 | 5,543.1 |
| 10,000 | 58.1 | 722.1 | 38.4 | 54.1 | 9,931.6 |

6,000 条（约 3,000 轮）的最新窗口 P95 为 57.3 ms，编辑 P95 为 49.4 ms；
10,000 条分别为 65.6 ms 和 57.0 ms。全部 15 次正式 Roost 编辑都只读取一页
40 条，没有完整历史读取。此前 53,823 ms 的编辑仅为单次基线探针，不是基线
分布。本次编辑在完整目录覆盖建立可选 goal projection 后测量；新写会话增量维护
该缓存，旧会话或失效缓存仍可能先读取完整权威历史执行目标校验。完整后台覆盖
在 6,000 条时仍约需 5.5 秒，10,000 条约需 9.9 秒。

在 `apps/cli` 内复现：

```sh
BENCH_STRUCTURAL=1 BENCH_SIZES=1000,6000,10000 BENCH_SAMPLES=5 BENCH_WARMUPS=1 \
  BENCH_BODY_BYTES=4096 TSX_TSCONFIG_PATH=tsconfig.json \
  node --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-history.mts
```

基准不覆盖 IPC/RPC、React/绘制、完整事实/搜索、IndexedDB、真实 Provider 和设备
内存验收。Roost 流式写入包含 SQLite 持久化；本基准的 Loro 控制 Repo 无磁盘
存储，不能把两者写入耗时视作等价持久化比较。结果和验证日志：
`/private/tmp/lody-roost-performance-optimized.json`、
`/private/tmp/lody-roost-performance-ui-6000-final.log`、
`/private/tmp/lody-roost-performance-check-final.log` 及
`/private/tmp/lody-roost-performance-desktop-build.log`。

### 生产适配器修复检查点（`d074e53`，2026-10-09）

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
