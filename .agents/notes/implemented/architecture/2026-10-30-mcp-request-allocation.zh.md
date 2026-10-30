# MCP HTTP 请求初始化内存

Status: implemented
Type: architecture
Translation: current
PR: [#2104](https://github.com/LodyAI/Lody/pull/2104)

[English](2026-10-30-mcp-request-allocation.md)

## 摘要

HTTP MCP 请求初始化曾为八个工具重复构造输入 schema，在 SDK 转换前就分配新的 schema 图。现在这些 schema 在模块级只构造一次，每个请求仍创建独立的 server、transport 和 handler。两轮独立的产品构建对照在 2,000 次请求后，宿主 RSS 从约 640 MiB 降至 355–401 MiB（37–45%），存活堆均约为 99 MiB。本修复针对重复分配与驻留高水位，不消除宿主冷启动导入成本，也不证明存在活对象泄漏。

## 条件与范围

早期归因实验源码为 `fc385258174e577aafcf7ce4c43511574e9de987`，即 main
`39c252437a9b265d43df364baa5752ba657cac19` 加[消息基础规则复用](https://github.com/LodyAI/Lody/pull/2100)。
环境是 macOS 27.2 arm64、Electron 44.9.3 / Node 24.22.0 / V8 15.2.124.43-electron.0、MCP server SDK 2.0.0、Zod 4.3.6。Python/Node 驱动使用可丢弃的数据目录、临时回环端口和合成上下文 header，没有真实模型或会话。空闲桌面对照从不启动 Playwright tracing。[数值样本](assets/2026-10-30-mcp-request-memory.json)不包含请求内容、日志、trace 或堆内容。

请求实验使用 MCP `2025-06-18`：初始化并发现 36 个工具，再让一个合成客户端连续请求 2,000 次 `tools/list`。计数在明确响应及各检查点强制 GC 之后采集。目录与发布基线完全一致，每个宿主都在 stdin EOF 后正常退出。这是突发负载资源侦察，不是生产请求频率估计，也不是阻断式性能断言。

## 空闲内存归属

最新本地桌面没有配置任何 Agent，启动稳定后的各进程 RSS 合计约为 1,750 MiB；macOS `footprint` 对这组受控 PID 统计的总 footprint 约为 1,030.8 MiB。HTTP MCP 宿主单独占 303.4 MiB RSS、`vmmap` footprint 209.6M。隔离设置 `LODY_MCP_HTTP_DISABLED=1` 后，该进程消失，RSS 合计约为 1,462 MiB、进程组 footprint 为 822.6 MiB。这个诊断开关会退回 stdio，永久关闭 HTTP 不是建议的产品改动。

`LodyFleet` 在 daemon 启动时就启动宿主，即使尚无 Agent 使用。进程隔离有明确用途：宿主可能执行同步 SQLite 和一次性 workspace-manager 工作，不能阻塞 daemon 的调度、心跳和 IPC，因此应保留隔离。[PR #2099](https://github.com/LodyAI/Lody/pull/2099)独立处理部分冷启动导入成本，本研究构建未包含它，两者合并后的收益没有测量。

这些全新配置中，GPU footprint 最初约为 749–933M，但在随后 frame/idle 检查点降至约 112–113M，没有发送压力通知或做内存 dump。视口为 1280×1409、DPR 2。独立 Chromium dump 发现较大的 IOSurface/共享图像分配，包括 2560×2818 BGRA scanout 缓冲。不能把这个瞬时高峰当成剩余常驻 RSS 的原因，也不能据此建议用强制压力通知作为修复。

## 请求分配边界

`mcp/lody-mcp-http-host.ts` 仍为每个 legacy HTTP 请求创建新的工具服务，modern 路径同样以该工厂创建请求级 handler。修复前，`buildSessionToolServer` 在注册全部工具时，还会重新构造剩余请求级输入 schema 图；SDK 在注册和列出工具时都会转换 schema。

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

## 决策

静态输入 schema 在模块级只构造一次。此前仍在请求内构造的部分属于四个日程工具、两个资源 get 工具、会话分享和 Operation 批次读取，现在与其他工具 schema 保持相同生命周期。工具名称、元数据、JSON 输出、strict/refinement、trim、默认值及 daemon 侧校验均不变。产品实现没有按名称缓存，也不读取 SDK 私有字段。

每个请求继续创建新的 SDK server/transport 并绑定新回调。schema 不包含凭证、调用上下文、注入依赖或客户端能力；注册与 JSON 转换仍使用 SDK 的受支持 API。bearer/peer 鉴权、ALS 范围和活动回合检查保留原有归属。SDK close 或请求取消不代表被委派的实际工作已经完成。这属于纯构造，无需迁移 Effect 或 stdio 生命周期；保留子进程及请求隔离，避免整服务共享实验的协议与回调归属风险。

## 产品实现测量

产品对照基于 main `d86674c6901a028e8266117af65df261374dd851`，不包含前两个内存 PR。两侧都是 OSS 产品 bundle，使用相同 Electron 可执行文件和上述探针流程。在全仓构建/检查停止时，顺序运行两组全新 before/after 进程；正式修复仅使用模块级 schema 和 SDK 的受支持注册 API。

| 2,000 次请求 | 修复前 → 后 RSS，MiB | 修复前 → 后存活堆，MiB | 修复前 → 后 footprint |
| --- | --- | --- | --- |
| 第一组 | 641.55 → 354.64 | 99.21 → 99.23 | 529.3M → 247.2M |
| 第二组 | 639.63 → 401.17 | 99.21 → 99.31 | 527.0M → 294.1M |

RSS 降低 238–287 MiB（37–45%），`vmmap` footprint 降低 233–282M（44–53%）。每次请求的全部 36 个工具定义完全一致，所有宿主均在 stdin EOF 后以状态码零退出。V8 old space 预留从 215–217 MiB 降至 88–93 MiB，存活堆基本不变。第二个修复后进程仍比第一个具有更高的原生驻留成本，不能用早期实验的最佳值替代这个范围，也不能据此承诺未来增长上界。

此前与全仓构建/检查重叠的侦察波动较大：原实现最终 RSS 为 359–563 MiB，修复后为 371 MiB；这些受扰动样本保留在数值证据中，不作为匹配的产品对照。原实现 footprint 为 398–529M，修复后为 266M。构建负载、GC 和原生分配意味着不能只看 RSS 就宣称一个普适精确收益。

另一次正式 bundle wire 对照确认两个协议的完整工具目录及 16 个无效输入响应完全一致。真实 OSS Electron 会话使用合成的外部 ACP provider，完成预热及两次 128 KiB 回复、离开/重新打开会话，并拒绝无效 IPC。这是行为验收，不是桌面空闲节省量估计。

## 验证与限制

归属的 [HTTP wire 测试](../../../../apps/cli/src/mcp/lody-mcp-http-host.test.ts)通过真实 HTTP transport 覆盖 MCP 2025-06-18 与 2026-07-28。不同 session/workspace/machine 的两个请求同时执行，中断第一个后，第二个的响应和 ALS 上下文仍正确；后续日程提案继续使用自己的上下文和 trim 后的标题。显式就绪/完成信号让不配合取消的实际工作一直保留到结束。八个受影响工具仍拒绝无效输入，包括 strict 未知字段和范围限制。现有 daemon Session 工具测试覆盖活动回合/访问控制及 daemon 自有 replica 上的 discovery 执行。

打包版本、其他系统、真实 provider 请求频率、长时间空闲恢复和内存增长上界仍未验证。本记录不替代活跃决策：[启动命令加载](https://github.com/LodyAI/Lody/pull/2099)和[消息基础规则复用](https://github.com/LodyAI/Lody/pull/2100)属于不同归属与时间边界，尚未测量合并收益。
