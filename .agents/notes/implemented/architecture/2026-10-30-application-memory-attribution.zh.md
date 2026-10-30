# 应用内存：Loro 与 Roost 目标查询

Status: implemented
Type: architecture
Translation: current

[English](2026-10-30-application-memory-attribution.md)

## 摘要

GC 的目标保护只需要最新有效 goal，原先却整读并复制会话历史。现在 Loro 同步浅读目标字段，Native Roost 复用已有目标投影，未知时反向分页且不缓存扫描正文；目标判定、旧 metadata fallback 和用户操作保持一致。128MiB 合成 Roost 历史的目标检查原来额外保留约 128MiB JS 堆，新查询及缺投影回查都不再保留整段历史副本。Loro 的同规模实验中，约 119MiB 的检查后 footprint 增长也随全量转换消失。

## 决策与范围

`MessageHandler.hasActiveGoal` 使用本地 backend 的 `readLatestGoal`。Loro 在既有 adapter 中同步查找，只把完整命中的 goal 转为独立对象；Native Roost 查询当前目标投影或遍历逻辑历史页。RPC/非 owner 服务没有本地查询能力，继续使用原全读路径，不增加远端协议操作。

GC 的活动回合、原生工作、待处理输入/更新、归档判断、真正清理前的再次检查，以及读取失败保留会话的行为沿用原实现。目标控制与更新/清除命令、回收超时和 Agent 进程保留均不改写。显式导出、重放、哈希和 fork 仍使用原有完整、独立快照；前台展示和读取缓存保持原样。改动沿用现有 SDK 读取边界，没有新增生命周期 owner 或 Effect 迁移单元。

## 判定为何等价

现解析器从最新消息开始，逆序访问每条消息的 items，取第一条 `type === 'goal'` 且 `threadId`、`objective`、`status` 都是字符串的 item。新的读取执行同样的查找，不按消息角色或时间戳筛选，也不强化旧数据校验。空字符串、Loro Text、旧 JSON 和完整目标的扩展字段保持原语义。

命中非 active 目标也立即结束；只有确认整个当前历史无 goal，才使用旧 metadata fallback。活动判断仍为 `status === 'active'`。因此较新的暂停/完成/清除状态会覆盖旧 active，普通消息也不会让很旧的活动目标失效。固定只读最早或最新 N 条存在实际反例；从最新处开始并在命中时停止才与原解析器相同。

## Roost 投影与回查

继续使用 #1329 引入的目标投影，保留“已知目标 / 已证明不存在 / 未知”三态。只在 owner 空闲、已知 cursor 与新鲜 Native event cursor 相同时复用已有内存投影；否则读取与新鲜 cursor 匹配的持久化投影，避开写入过程中暂存的 goal。整次读取核对 host、generation 和 cursor；条数或分支 revision 不能单独证明原地内容没有改变。

投影未知时，SDK 从当前 active branch 的最新页开始，每页 40 条，按原逻辑投影处理 state overlay、分段和 sealed 记录。确认页面连续，遇到第一个有效 goal 就停止；到起点仍未命中才返回 `null`。跨页期间改变内容或 generation 时，原有 stale 读取机制重试；不能建立一致结果时走原 GC 读取失败路径。

扫描不占用整次写入串行队列，不填充 `fullEntriesCache`、`pageEntries`、state/permission 正文缓存，也不写入目标派生索引。核对完版本后，若仍是相同的空闲 owner 和已知 cursor，就把结果放回原有内存目标投影；后续查询复用同一份证据。既有持久化维护和 UI/编辑读取的缓存默认行为不变。只分离返回的 goal，私有扫描页用完即释放。该选择源于实际测量：直接循环现有 `readRange(40)` 仍留下约 88MiB 旧正文，因此仅改分页不能完成这项优化。无目标或很旧目标的首次回查仍需遍历历史，工作内存按页和单条记录大小分配。

没有另建 goal cache。早期纯只读草案在缺投影样本中，第二次仍扫描约 5.69 秒，而原全量正文缓存的第二次检查约 57–65ms。将已经证明的结果回填既有目标投影，消除了这项实际的重复读取成本，同时保留不缓存正文、不写派生索引的边界。

## 行为验证的归属

- [Loro 数据边界测试](../../../../packages/shared/tests/session-data-review-boundaries.test.ts) 将 JSON、嵌套容器和 Loro Text 形态与全读解析器对照，覆盖旧/新目标、多目标、非活动状态、畸形 item、扩展字段和逻辑顺序；同时禁止转换普通正文并检查文档及返回值隔离。
- [本地 backend/GC 接入测试](../../../../apps/cli/tests/session-history-targeted-write.test.ts) 经过真实 SessionDocument、Loro adapter 和 MessageHandler，禁止全读后仍能识别旧 active 与原地清除。
- [Native backend 契约](../../../../apps/cli/tests/roost-session-backend-contract.test.ts) 验证持久化投影、未知投影回查、state overlay、更新/清除/删除、复制和重开，以及跨页原地修改与无 event-cursor 变化的 generation 激活。检查扫描后旧正文仍需按需读取、未发布投影，以及 metadata fallback、返回值隔离和错误传播。
- [GC 管理器测试](../../../../apps/cli/src/lib/session-gc-manager.test.ts) 继续定义活动保护、再次检查及失败保留；[目标规则](../../../../packages/shared/tests/goal.test.ts)与[目标命令](../../../../packages/shared/tests/session-history-actions.test.ts)定义现有可见状态和更新规则。

## 应用层 GC 验证

应用验收启动真实 OSS Electron、preload、renderer、IPC 和打包 CLI，只用外部 ACP 合成 Agent 发布目标。Loro 使用正常默认配置，Roost 使用已保存的开发者模式和 Roost 偏好，并从侧栏信息卡确认实际后端。Agent 发布 active 目标后正常结束 prompt，再完成 22 个普通回合，使目标留在最新 40 条消息之外。

仅在隔离进程中将空闲超时设为 1000ms、扫描间隔设为 250ms。目标发布后开始观察：新建一个更晚的无目标对照会话，等待真实 daemon 的回收记录及其 Agent 退出，同时确认原目标 Agent、ACP 会话身份与目标展示仍保留。随后通过界面直接 Clear，等待原 Agent 被回收，并确认已清除横幅及可编辑输入框仍存在。断言跟随实际完成、回收和退出信号，不靠固定等待时间判断保护是否生效。

[目标控制桌面场景](../../../../e2e/src/features/session-goal.feature)另行覆盖暂停、更新、恢复、重开、归档、还原和最终删除。应用进程验证与前述存储/GC 契约测试分别承担界面行为和判断规则的证据；它没有改变产品的默认 GC 时间。

## 修改后的配对测量

源码基于 main `d197e459b9377f7911ec1cf6b21006d8f22fd7c3`，使用同一产品 CLI Vite 配置增加临时诊断入口，并在 Electron 44.9.3 / Node 24.22.0 中运行真实 SessionDocument/backend。每组使用新进程、相同合成内容和原生依赖。旧路径在同一构建中隐藏新增本地查询能力，使 MessageHandler 执行原有全读分支；新路径执行实际实现。没有构造完整 MessageHandler 或等待 GC 定时器，也没有改变功能、超时或进程策略。

Roost 使用相同已持久化数据库的独立副本；缺投影组在打开前破坏派生目标索引；查询不写回该索引。最近目标可由原有最新窗口加载恢复投影，旧目标/无目标则实际进入回查。Loro 在进程内构造相同的已加载 CRDT 历史；其准备时间包含构造，不是磁盘打开时间。准备/打开成本单独记录，下面只列目标检查增量。每组查询两次并在每个检查点主动 GC；128MiB 无目标组另在新进程重复一次。另有 4×1MiB 与 128×32KiB 对照，区分条数和正文字节成本。[数值证据](assets/2026-10-30-application-memory-attribution.json)保留全部配对记录。

128 条各 1MiB 正文、无目标，首次检查的两轮范围：

| 路径             | 返回时 JS 堆增量 |  GC 后 JS 堆增量 | GC 后 footprint 增量 |          查询耗时 |
| ---------------- | ---------------: | ---------------: | -------------------: | ----------------: |
| Roost 原全读     | 640.52–640.54MiB | 128.12–128.13MiB |     136.89–167.16MiB | 7776.00–7827.43ms |
| Roost 有效投影   |     0.11–0.12MiB |          约 0MiB |              约 0MiB |       0.45–0.60ms |
| Roost 缺投影回查 | 167.65–248.83MiB |     0.11–0.13MiB |       17.09–34.02MiB | 5454.33–5465.97ms |
| Loro 原全读      |          0.46MiB |          约 0MiB |     119.03–119.06MiB |     20.43–20.56ms |
| Loro 浅读        |          0.17MiB |          约 0MiB |              约 0MiB |       0.78–0.80ms |

旧目标和最近目标样本返回同一 active 结果。Roost 缺投影时，旧目标需回查到最后一页；最近目标在普通最新窗口加载后已有可用投影。旧目标/无目标首次回查读取四页，之后检查复用内存目标投影，均不再读取正文。重复查询没有累积完整正文副本。缺投影的无目标样本，第二次查询读取零页，耗时 0.28–0.33ms；原全读缓存路径为 54–55ms。

Loro 原路径的主要变化体现在进程 footprint，而非 JS 常驻堆；已加载 CRDT 本体在两组中都存在。Roost 缺投影回查还会产生分页解码的临时分配和分配器保留。返回时快照不是采样峰值，footprint 也不等于存活 JS 对象。这些数字量化的是该目标检查路径，早期整个桌面的归因记录在下文。

## 既有决策

[增量投影调查](../../proposed/architecture/2026-10-22-roost-owner-incremental-projection.zh.md)、[目标/cursor 原生证明工作](../../proposed/architecture/2026-10-23-roost-append-cpu-structure.zh.md)和[调度标量投影](../../proposed/architecture/2026-10-22-roost-dispatch-scalar-projection.zh.md)继续拥有各自决策，本次补充 GC 查询接入。[原生工作 GC 决策](../bug-fix/2026-10-18-gc-respects-native-agent-work.zh.md)继续定义活动保护。Renderer/样式候选保持 rejected；既有整读接口与写入算法保留。

## 测量边界

源码为 main `dc44d50a05f8c22842dd5e8ec65703036498b4da`，未包含 [#2099](https://github.com/LodyAI/Lody/pull/2099)、[#2100](https://github.com/LodyAI/Lody/pull/2100)、[#2104](https://github.com/LodyAI/Lody/pull/2104)，它们的合并效果尚未测量。[数值证据](assets/2026-10-30-application-memory-attribution.json)只包含合成数据参数及内存、进程数量。

macOS 27.2 arm64 运行 Electron 44.9.3 / Node 24.22.0。桌面使用独立临时 profile 中的真实 main、preload、renderer、IPC、daemon 和 MCP。自定义命令 Provider 启动产品构建的 Codex ACP bundle，以及经过校验和验证的锁定版 Codex 0.164.0；只有模型 Responses API 和外部 provider 链路使用环回地址上的合成服务。不使用用户凭据或数据。每个会话只产生短回复，随后返回主页。关闭 tracing 和分配采样，在原生测量前对 main/renderer 主动 GC。

下表 `footprint -j` 进程组总值以 MiB 表示；RSS 合计包含共享映射，单独列出。进程组分别采样，总值不保证精确相加。系统压缩和分配器高水位意味着，单独的进程树差值不足以证明存活对象泄漏。

| 已完成会话数，随后回到主页 | 整个桌面 footprint | Codex Agent 组 footprint | 整个桌面 RSS 合计 |
| -------------------------- | -----------------: | -----------------------: | ----------------: |
| 0                          |             1098.8 |                        0 |            1413.7 |
| 1                          |             1206.1 |                     87.1 |            1821.4 |
| 3                          |             1276.1 |                    259.6 |            2103.8 |
| 5                          |             1398.6 |                    414.8 |            2562.6 |
| 10                         |             1749.1 |                    778.7 |            3583.9 |

## 每个会话的进程保留

`Session.createAgent` 安装会话独占的 AgentClient，Codex ACP 入口启动自己的原生 app-server。`releaseVisibleTurn` 在回合结束后有意保留 Agent 进程。`SessionGCManager` 默认空闲二十分钟回收，每分钟扫描；活动回合、原生工作、目标和待办还可能延长保护。实验确认，十个会话完成后，十个 ACP adapter 和十个原生进程仍在。关闭隔离应用后，受控进程全部退出。

独立产品 adapter 探针在 adapter 主动 GC 后得到相近的固定成本：十组独立进程 footprint 为 792.2MiB，RSS 合计 2216.2MiB。另一项协议诊断中，一组进程承载十个逻辑 ACP 会话的 footprint 为 101.9MiB。这个差值不能直接当作兼容优化收益：尚未证明产品的账户/环境隔离、每会话 MCP 上下文、取消、关闭、supervisor 恢复和崩溃波及范围等价；提前结束进程也会影响复用及可能存在的后台工作。[原生工作 GC 决策](../../implemented/bug-fix/2026-10-18-gc-respects-native-agent-work.zh.md)继续拥有这些保护约束，已撤回的 residency 实现不是当前权威。

## 原有全历史目标检查

本次改动之前，`MessageHandler.hasActiveGoal` 只返回布尔值，却无条件调用 `backend.readHistory()`。未改动的 Roost `history.readAll()` 调用 `readCompleteEntries`，投影整个分支，将完整副本克隆进 `fullEntriesCache`，再返回另一份克隆；`readAll()` 还会再次克隆。全量 cache 保留到所属 generation 失效或 owner 释放。同一 generation 上重复检查会进入平台，不是每次永久追加一份。

诊断为真实方法直接提供真实、已持久化的 Roost SessionDocument/backend 两个端口；不构造完整 MessageHandler，也不等待 GC 定时器。临时入口与原有 runtime 入口一起使用产品 CLI Vite 配置构建，再在 Electron-as-Node 中运行并使用已打包的原生依赖。合成历史包含 128 条各 1MiB 的低重复 ASCII 正文，没有目标。每个新进程先读历史条数、主动 GC，再执行目标检查，在返回时采集 GC 前内存，随后再次 GC。这是 owner 进程测量，不是另一项完整桌面测量，也不是修复后收益。

| 128MiB 历史                      |             第一轮 |             第二轮 |
| -------------------------------- | -----------------: | -----------------: |
| 打开后、GC 后的 JS 堆            |          161.43MiB |          161.44MiB |
| 首次目标检查返回、主动 GC 前     |          802.03MiB |          802.02MiB |
| 同一时刻的进程 RSS               |         1056.23MiB |         1062.80MiB |
| 主动 GC 后的 JS 堆               |          289.58MiB |          289.59MiB |
| GC 后 footprint，检查前 → 检查后 | 307.39 → 467.72MiB | 308.31 → 474.58MiB |

约 641MiB 的堆增长包含可回收分配；GC 后约 128MiB 的增加才是额外常驻。GC 前快照不是采样峰值。输入有意采用较大的合成历史，因此这证明了随数据量增长的放大，并不证明普通会话有 128MiB 历史，也不证明所有应用内存都来自这个检查。已有分页不能限制这条显式全历史读取。

相同打包入口的 4MiB 小历史对照，在检查时堆增长约 41.28MiB，GC 后只多保留 4.06MiB。这进一步区分了随历史数据增长的成本和探针固定开销。

另一项单轮校准将检查中的全读替换为现有 `readRange` 每次 40 条，仍读取同一份 128MiB 无目标样本的全部 128 条、四页。返回时堆为 622.94MiB，GC 后为 249.73MiB，检查前为 161.43MiB，额外常驻 88.29MiB。现有范围路径会缓存已安装 40 条窗口之外的 88 条旧正文。这只是当前分页保留成本的诊断，不是已实现的目标查询优化，也没有证明并发读取算法；临时 wrapper 使用已知无目标样本，没有验证任意历史的提前停止。另以现解析器做了九组目标/fallback 语义对照，逆序扫描与全读一致，而固定最早/最新 40 条存在反例。实际实现与配对测量见上文；此处保留原分页诊断的边界。

[Renderer/样式候选](../../rejected/architecture/2026-10-30-renderer-code-memory.zh.md)已撤回，临时原型和构建已移除。保留超时、功能、渲染行为、历史内容和进程隔离均未改变。
