# 内部 MCP 命令按需加载

Status: implemented
Type: architecture
PR: [#2099](https://github.com/LodyAI/Lody/pull/2099)
Translation: current

[English](2026-10-30-internal-mcp-command-loading.md)

## 摘要

内部 MCP 进程原先会在解析参数前加载整个 CLI 命令注册表，包括 daemon 和交互命令的实现。
现在首个参数为 `__internal` 时只注册已有的 MCP 辅助命令，普通调用仍使用完整注册表。
两条路径继续共享原有的应用运行时、清理规则、MCP 传输实现和子进程隔离方式。
生产构建实验中，HTTP MCP 完成初始化和工具发现后的 RSS 从约 310 MiB 降至 236 MiB；
改动针对固定加载成本，历史保留、缓存上限和并发设置保持原样。

## 决策

`apps/cli/src/index.ts` 保持运行时检查为首个 import，并保留原有的埋点初始化、应用 Layers、
环境设置、错误处理和释放逻辑。只有首个参数不是 `__internal` 时，才导入
`commands/register.ts`。注册模块按原顺序注册同一批 Command 对象，包括仅限 cloud 的迁移命令
和隐藏的 E2EE 命令。公开帮助、版本、别名和选项仍由完整的 Commander 命令树处理，
没有另建一份命令描述表。

两种内部 MCP 命令都沿用原有实现。HTTP host 仍是 daemon 拥有的独立子进程，
使用原来的 token、fd 3 就绪握手和 stdin 关闭机制；stdio 回退保留现有的 Effect 连接生命周期。
此次只调整模块加载边界，原生生命周期的所有权和迁移台账均未改变。

第一次开发构建暴露了一个打包约束：拆分注册表后，共用应用代码会被放入 chunk，
但 worker 和 adapter 的拥有者根据自身的 `import.meta.url` 查找同目录文件。
因此 esbuild 和 Vite 的应用 chunk 都保留在输出根目录；Vite 依赖和 CommonJS helper chunk
仍可放在 `chunks/` 下。现有开发构建的路径检查继续保留，sourcemap 和扁平 worker 入口不变。

## 备选方案与相关决策

- 把 HTTP host 合并到 daemon 可以减少一个进程，但同步 SQLite 和工具工作会占用 daemon
  的事件循环。因此保留现有进程边界；[daemon 承载工作区命令](2026-10-16-daemon-hosted-mcp-workspace-commands.zh.md)
  说明了工作区副本和授权的另一层所有权。
- 对所有公开命令都延迟加载，需要在实现尚未加载时维持 Commander 的发现、帮助和解析行为。
  此次只收窄内部路径，在减少实测重复加载的同时，保留公开命令的现有兼容边界。
  公开帮助和版本命令仍加载完整注册表。
- 应用 chunk 继续放在 `chunks/` 下会触发现有 worker 路径检查。
  将这些 chunk 放在入口旁边，可保留当前按文件名定位的方式，无需扩展到其他模块的 worker 所有者重构。

## 测量

基线是 `dddbe5873444941f60623569931d2ba9413ba3e8`。在一台 Apple Silicon Mac 上，
使用固定的 Electron 44.9.3 Node 运行时，对比该提交未修改的生产 CLI 和此次改动。
每个独立样本都启动新进程，使用隔离且较短的 `LODY_DATA_DIR`，阻断出站网络，
等待 HTTP 监听握手后强制 GC。合成的回环请求执行初始化、列出全部工具、错误 bearer token
拒绝和无效工具参数拒绝；不涉及 Agent、用户工作区或托管服务。每个版本各测两个新进程。

| 独立 HTTP MCP 指标 | 基线 | 改动后 |
| --- | ---: | ---: |
| 请求及 GC 后 RSS | 309.59–309.88 MiB | 235.38–236.36 MiB |
| 请求及 GC 后已用 JS 堆 | 96.59–96.61 MiB | 69.61–69.62 MiB |
| 初始化请求 | 35.1–35.5 ms | 26.8–27.9 ms |
| 首次工具列表请求 | 16.3–18.7 ms | 12.3–13.1 ms |

36 个工具的定义和完整 schema、初始化结果、无效工具响应、鉴权拒绝、GET 拒绝和 EOF 退出码
均与基线一致。耗时数据仅是上述条件下的探索性观察，不能视为延迟预算。

另一个桌面实验构建 OSS 应用，完成引导后关闭，再次启动同一个隔离 profile。
在本地启动、输入框和 HTTP MCP 监听均就绪后采样，不配置 Agent，也没有工作区内容。
每次启动在主进程和渲染进程 GC 后各取三个样本。

| 桌面启动指标 | 基线 | 改动后 |
| --- | ---: | ---: |
| 各进程 RSS 之和 | 1533.38–1534.30 MiB | 1441.94–1442.58 MiB |
| HTTP MCP 进程 RSS | 305.31 MiB | 228.56 MiB |
| HTTP MCP physical footprint（`vmmap`） | 211.5M | 152.6M |
| 渲染进程已用 JS 堆 | 76.22 MiB | 76.18–76.22 MiB |

RSS 求和会重复计算共享页，不能据此得到应用独占内存。Physical footprint 是每个进程的
操作系统记账指标，也不能跨进程相加来表示独占内存。`vmmap` 无法检查 Electron 的
PartitionAlloc zone，因此分配器明细并不完整。桌面对比只观察启动阶段，
尚未测量持续的真实工作负载，也没有与已安装的云产品作同场景对比。

## 验证与限制

[发布包检查](../../../../apps/cli/scripts/check-published-bundle-imports.js)
对比完整路径和内部路径的内部命令帮助，检查缺少 token 时的退出和 stdio EOF，
并保留原生依赖及 worker 检查。
[HTTP host 测试](../../../../apps/cli/src/mcp/lody-mcp-http-host.test.ts)
约束协议版本、鉴权和响应结束；
[stdio 生命周期测试](../../../../apps/cli/src/mcp/stdio-lifecycle.test.ts)
约束连接关闭。已有的 daemon 启动、MCP 解析、遥测和
[daemon Session 工具测试](../../../../apps/cli/src/mcp/daemon-session-tools.test.ts)
覆盖各自未改变的边界。

外部诊断还将 28 组普通及内部 CLI 调用的 stdout、stderr 和退出码与基线进行了对比。
真实 Agent 执行、长时间会话负载、其他操作系统、签名安装包和私有 cloud 组合仍需分别验收。
