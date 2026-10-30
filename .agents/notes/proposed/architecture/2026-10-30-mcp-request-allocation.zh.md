# MCP HTTP 请求初始化内存

Status: proposed
Type: architecture
Translation: current

[English](2026-10-30-mcp-request-allocation.md)

## 摘要

共享 MCP HTTP 宿主同时存在较大的空闲加载成本和重复请求初始化成本。在隔离生产构建中，2,000 次连续只读工具列表请求使宿主 RSS 从约 315 增至 626 MiB，而 GC 后存活 JS 堆仍约为 96 MiB。分配采样中约 66% 的字节来自 JSON-schema 转换。临时预构造目录、每请求仍使用新 server/transport 的对照最终 RSS 为 349 MiB。该实验通过 SDK 私有字段提取定义，仍不是产品实现；建议仅共享不可变工具定义/schema 构建，保留各请求独立的协议、transport、取消和调用上下文。

## 条件与范围

源码为 `fc385258174e577aafcf7ce4c43511574e9de987`，即 main
`39c252437a9b265d43df364baa5752ba657cac19` 加[消息基础规则复用](../../implemented/architecture/2026-10-30-desktop-schema-initialization.zh.md)。
环境是 macOS 27.2 arm64、Electron 44.9.3 / Node 24.22.0 / V8 15.2.124.43-electron.0、MCP server SDK 2.0.0、Zod 4.3.6。Python/Node 驱动使用可丢弃的数据目录、临时回环端口和合成上下文 header，没有真实模型或会话。空闲桌面对照从不启动 Playwright tracing。[数值样本](assets/2026-10-30-mcp-request-memory.json)不包含请求内容、日志、trace 或堆内容。

请求实验使用 MCP `2025-06-18`：初始化并发现 36 个工具，再让一个合成客户端连续请求 2,000 次 `tools/list`。计数在明确响应及各检查点强制 GC 之后采集。目录与发布基线完全一致，每个宿主都在 stdin EOF 后正常退出。这是突发负载资源侦察，不是生产请求频率估计，也不是阻断式性能断言。

## 空闲内存归属

最新本地桌面没有配置任何 Agent，启动稳定后的各进程 RSS 合计约为 1,750 MiB；macOS `footprint` 对这组受控 PID 统计的总 footprint 约为 1,030.8 MiB。HTTP MCP 宿主单独占 303.4 MiB RSS、`vmmap` footprint 209.6M。隔离设置 `LODY_MCP_HTTP_DISABLED=1` 后，该进程消失，RSS 合计约为 1,462 MiB、进程组 footprint 为 822.6 MiB。这个诊断开关会退回 stdio，永久关闭 HTTP 不是建议的产品改动。

`LodyFleet` 在 daemon 启动时就启动宿主，即使尚无 Agent 使用。进程隔离有明确用途：宿主可能执行同步 SQLite 和一次性 workspace-manager 工作，不能阻塞 daemon 的调度、心跳和 IPC，因此应保留隔离。[PR #2099](https://github.com/LodyAI/Lody/pull/2099)独立处理部分冷启动导入成本，本研究构建未包含它，两者合并后的收益没有测量。

这些全新配置中，GPU footprint 最初约为 749–933M，但在随后 frame/idle 检查点降至约 112–113M，没有发送压力通知或做内存 dump。视口为 1280×1409、DPR 2。独立 Chromium dump 发现较大的 IOSurface/共享图像分配，包括 2560×2818 BGRA scanout 缓冲。不能把这个瞬时高峰当成剩余常驻 RSS 的原因，也不能据此建议用强制压力通知作为修复。

## 请求分配边界

`mcp/lody-mcp-http-host.ts` 为每个 legacy HTTP 请求创建新的工具服务；modern 路径同样以该工厂创建请求级 handler。`buildSessionToolServer` 重新构造工具配置/schema 图并注册全部工具，SDK 在注册和列出工具时都会转换 schema。

| 2,000 次请求实验 | 最终 RSS，MiB | GC 后堆，MiB | Footprint 标签 |
| --- | --- | --- | --- |
| 原实现，第一轮 | 625.61 | 95.72 | 未采集 |
| 原实现，独立重复 | 625.86 | 95.74 | 514.0M |
| 注册参数构造完毕后复用 prepared schema | 625.59 | 96.06 | 513.4M |
| 在该较晚边界再缓存 schema JSON | 628.03 | 95.99 | 511.7M |
| 复用单个服务，仅用于串行诊断 | 332.23 | 95.56 | 224.5M |
| 复用单个服务并缓存 schema JSON | 357.11 | 95.81 | 230.7M |
| 预构造目录，每请求仍创建新 server/transport | 348.94 | 95.73 | 242.6M |
| 新 server/静态目录，独立重复 | 348.08 | 95.74 | 242.4M |

注册阶段的缓存仍会先执行工厂里的 schema 参数构造，这些无收益的实验很重要。需要移出请求的是重复的工厂构建边界，不能只复用返回 schema 的身份。整服务共享仅是收益上界的反事实实验，真实独立调用方不能共享它的协议/客户端及 transport 状态。更接近目标的实验先构造一个目录模板，再为每个请求创建新的 server 并注册已有定义，保留全部 36 个目录条目，两次独立进程运行相对生产基线减少约 277–278 MiB RSS。这个实验尚未验证工具执行和回调归属，使用 SDK 私有字段只是测量手段，不是受支持的产品 API。

另一个独立的 500 次请求采样以 32 KiB 为间隔，包含随后被 minor/major GC 回收的对象，估算累计分配约 1,427 MiB，其中 936 MiB（65.6%）的栈包含 `standardSchemaToJsonSchema`。这是分配量估计，不是同时保留的字节数。原宿主在 2,000 次请求后，old space 预留约 222.5 MiB、只使用约 69.5 MiB；复用服务的反事实实验预留 76.5 MiB、使用 69.9 MiB。这支持重复分配与驻留高水位的归因，尚不能证明无界的活对象泄漏。`vmmap` 无法检查 Electron PartitionAlloc zone，分配器归因仍不完整。

## 建议的实现边界

在进程范围内、请求之前构造不可变输入/输出 schema 和静态工具定义。每个请求创建新的 SDK server/transport，并绑定现有请求上下文。需要请求/transport 的 handler 继续绑定实际实例，缓存闭包不能把首个 server 固定住。纯 JSON 转换可以按明确的转换 target 和输入/输出方向缓存，但这里只缓存 JSON 并未证明内存下降。

保留 bearer/peer 鉴权、ALS session/workspace/machine 范围、活动回合检查、工具参数校验以及独立 raw-work owner。SDK close 或请求取消不代表被委派工具的实际工作已经结束。进程级目录不能捕获用户数据、凭证或首个调用方能力。不得将实验中的 SDK 私有字段访问或 prototype 覆盖直接放入产品。本候选针对纯构造，不需要重写 Effect/stdio 生命周期。

## 必需验证与限制

产品验收需要比较完整工具定义与无效输入行为，覆盖两个受支持 HTTP 协议路径、不同会话/workspace 的并发请求、取消/响应关闭以及独立 handler/transport 状态。需要针对受支持的实现，在 server 仍按请求创建时重复分配负载，证明不共享协议状态也能降低驻留成本。SDK 工具更新或条件目录变体必须具有明确失效与归属，不能使用隐藏的 name-only 缓存。打包版本、其他系统、真实 provider 请求频率、长时间空闲恢复和内存增长上界仍未验证。

本提案尚未修改产品实现，也不替代活跃决策；启动命令加载和消息基础规则复用属于不同归属与时间边界。
