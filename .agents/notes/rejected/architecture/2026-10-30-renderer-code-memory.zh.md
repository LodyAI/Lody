# 代码高亮节点的原生内存

Status: rejected
Type: architecture
Translation: current

[English](2026-10-30-renderer-code-memory.md)

## 摘要

共享样式优化候选已撤回：实测 20–28M 收益相对整应用内存问题较小，当前调查应定位最大的内存归属。此前约 180M 的诊断移除了用户可见的语法颜色，不能证明兼容优化收益。下文测量仅作为归因证据保留，防止再次把移除功能当作内存修复。本次没有修改产品代码；临时共享样式实现和构建已移除。

## 条件与证据

源码为 main `dc44d50a05f8c22842dd5e8ec65703036498b4da`，未包含前面的内存 PR [#2099](https://github.com/LodyAI/Lody/pull/2099)、[#2100](https://github.com/LodyAI/Lody/pull/2100)、[#2104](https://github.com/LodyAI/Lody/pull/2104)，尚未测量合并收益。[数值证据](assets/2026-10-30-renderer-code-memory.json)不包含会话内容、trace、profile 或用户数据。

在 macOS 27.2 arm64 上运行真实 OSS Electron 44.9.3（Node 24.22.0）、preload、renderer、IPC 和 bundled CLI，只有外部 ACP provider 是合成的。每轮使用独立临时目录和端点；隐藏视口为 1280×1409、DPR 2，关闭后台节流。预热 4 KiB 后，新会话以 8 KiB 分块接收一条 512 KiB 代码回复，含 178 个 TypeScript 围栏块。检查点等待响应、文字和 frame 信号，主动 GC 后读取 `vmmap`。配对实验没有开启 Playwright tracing 或分配采样；下表 `M` 保留原生 footprint 标签，与 RSS 分开。

| 离开到主页后重开已完成回复 | 原有高亮        | 已移除语法颜色，仅供诊断 |
| -------------------------- | --------------- | ------------------------ |
| 第一组 renderer footprint  | 541.3M          | 361.9M                   |
| 第二组 renderer footprint  | 538.5M          | 358.9M                   |
| renderer 存活 JS 堆        | 117.6–118.7 MiB | 101.9 MiB                |
| DOM 节点                   | 156,380–156,423 | 5,403                    |
| document 内元素            | 80,661–80,662   | 3,765                    |

已完成回复的重新挂载排除了“仅由 streaming→static 交接产生”的解释。此前两轮在回复刚完成时采样，原实现 footprint 为 543.5/541.0M，对照为 401.8/401.6M，降低约 139–142M。不同阶段的数据不能合并成普适精确节省量。RSS 波动明显：一组活跃视图仅差约 13 MiB RSS，但 footprint 相差 142M。原生 DOM/layout 存储与 React 表示都占内存，只看 JS 堆会低估这个热点。

`markdown-code-block.tsx` 的 `MarkdownCodeBody` 将每行、每个 token 全部映射为 span。回合级窗口化不能限制已挂载回合内部的节点数。对照只把该 body 改为拼接后的 token 文本，保留高亮 hook、token cache、围栏容器和源内容；用户可见的语法颜色被移除。这是移除功能的反事实对照，不是兼容优化；将其称作“简化高亮”，或把 180M 当作保留功能可取得的节省量，都是不正确的。

连续六次 512 KiB 回复的侦察中，活跃 renderer 堆在 121–122 MiB 附近进入平台，离开到主页后约为 100 MiB、2,588 个 DOM 节点。现有高亮 cache 已限制条目数、总字符数和单次输入准入。因此证据指向较大的活跃表示成本及部分高水位残留，不能称作无界 cache 增长。最初的分配 profile 包含 Playwright 注入的全文查询，不能作为产品分配量；后续配对探针改用原生选择器和显式响应信号。

## 其他候选与边界

- 已撤回的共享样式诊断保留全部 72,624 个 token span 和文字，仅将各自的内联声明换为共享 CSS 规则。重开已完成回复的 footprint 两轮分别为 540.4M → 512.3M、545.1M → 525.3M，降低 20–28M。两轮全部 token 的计算后颜色、font-style、font-weight、text-decoration 分布完全一致，测试主题有六组样式；它没有消除大量节点。渲染时 CSS 注入和无界 Map 只是诊断实现细节，该原型及构建已删除，不再提出共享样式的产品改动。
- 临时移除 Monaco 及模型注册桥后，两轮空首页存活堆从 80.2–80.3 降至 70.6 MiB。原生 footprint 没有稳定的大幅下降：原实现 291.8/308.2M，对照 295.7/287.5M。兼容的懒加载需要同时延后编辑器及 URI/LSP 桥；删除模块只用于诊断，优先级低于高亮节点。
- 合并相邻同样式 token，理论上可让一个样本的 72,624 个 span 变成 59,808 段，减少 17.6%。这是更窄的备选方案，尚未测量内存收益，不能把节点比例当作字节收益。
- 独立对照创建 20 个小会话，每次结束后回到主页，仍保留 20 个合成 Agent 进程。当前 `SessionGCManager` 默认空闲 20 分钟回收、每分钟扫描；回合完成有意保留 Agent 以供复用。合成进程 RSS 合计约 1,949 MiB，不代表真实 provider 成本，也不是可回收的 Lody cache。产品自身统计排除它们，测试关闭后全部退出。调整保留策略属于另一个生命周期/策略决策，需要保护活动回合、目标、待办及原生后台工作，并验证恢复。已撤回的 Session residency 提案不是当前权威。

## 处理结果

共享样式候选及其产品实现计划已撤回。token 标记合并和可见区域渲染均没有在此证明保留行为的内存收益，不作为下一项工作。现有高亮、选区、复制和滚动体验保持。接下来先测整应用进程归属、真实 provider runtime，以及空闲会话数增长，再选择修复对象。本记录不替代活跃决策，[无头 Markdown 决策](../../implemented/feature/2026-09-26-lobehub-streamdown.zh.md)保持有效。
