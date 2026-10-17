# Provider 接管 Session 标题后的兜底生成

Status: implemented
Translation: current

[English](2026-10-03-provider-owned-title-fallback.md)

## 摘要

把标题生成交给 ACP 适配器（2026-09-08）后，适配器静默失败会让 Session 永远停在
创建时的草稿标题：适配器内部的生成是尽力而为，失败不发任何信号，而 Lody 当时
有意不设兜底。实际观测到的案例：经网关转发的 Claude Code 因上游拒绝其标题调用，
所有 Session 都无法命名——每个被派发的子 Session 一直挂着 Role 提示词的首行当
标题。现在回合收尾时会为「Provider 接管标题、但标题仍缺失或仍是可替换草稿」的
Session 安排一次延迟检查（90 秒）；Lody 的独立生成器随后作为兜底运行，沿用同一
「仅草稿可写」守卫，Provider 标题晚到仍可覆盖本地生成的标题。残余代价是：对
回合结束 90 秒后才交付标题的 Provider 会多跑一次独立生成，写守卫保证其无害。

## 证据与决策

2026-09-08 的决策明确记录了接受的取舍："a failed generation now leaves the draft
title rather than falling back to Lody's generator"。改变判断的是这条路径触发
频率的证据。促成本笔记的案例中，Claude Code 2.1.284（经 acp-extension-claude
适配器）在 Session 自己的模型上请求标题且关闭思维；网关（DashScope 的 qwen-cn，
glm-5.3）以 `enable_thinking parameter is restricted to True` 拒绝关思维请求，
于是每次标题调用都失败，适配器吞掉错误，该 Provider 上的每个 Session——典型场景
是一个 Agent Role 派发另一个——终其一生停在草稿标题上。同一失败类别还会阻断
Claude Code 自身的 auto-mode 分类器请求，症状面比标题更宽。适配器无法上报失败
（其标题模块设计上就是尽力而为），标题的状态因此成为 Lody 唯一可观测的信号。

兜底因此从回合收尾武装，而不是靠推送检测：回合完成后，若归属判定仍是 Provider
生成标题（身份名单或持久化的 `sessionTitle` 能力，运行时覆盖照旧撤销身份路径），
且标题仍缺失或 `titleSource: 'draft'`，安排一次延迟检查。检查在触发时重读标题
状态，窗口内已落地的标题——Provider 推送、用户手动命名或本地已生成——都会让
检查无副作用地空转。判定谓词在共享层 `ai.ts` 的
`shouldFallbackGenerateSessionTitle`；调度在 `provider-title-fallback.ts`，
端口与时钟均可注入；`message-handler` 把生成核心
（`generateSessionTitleIfMissing`）从受归属门控的创建期路径中拆出，两个调用方
共享去重与条件写。

90 秒窗口是为真正会交付的 Provider 留的：Claude 适配器在回合结束时用小模型调用
生成（秒级），Codex 在第一个回合后立即生成（观测过从创建起 21 分钟，但那是回合
本身耗的——窗口从回合结束起算），Grok 在首个 prompt 之后立即生成。一个完成的
回合之后 90 秒仍缺席的标题不会来自该回合。若后续回合的 Provider 推送晚于本地
兜底标题到达，`maybeStoreAgentSessionTitle` 既有的 `['draft', 'generated']`
写守卫允许 Provider 标题覆盖它。

## 权衡过的替代方案

按 Provider 失败重试被否决，因为在 Lody 侧做不到：适配器失败时不发信号，没有
可挂靠的失败事件，只有标题缺席可观测。回合结束立即检查（无宽限窗口）被否决，
因为它与所有秒级交付的 Provider 竞争——正是原决策要避免的重复生成；窗口把这个
竞争变成一次延迟且有守卫的检查。只在第二个回合起检查被否决，因为被派发的子
Session 通常只跑一个长回合，而这恰恰是促成兜底的场景。

## 限度

检查存在于 daemon 进程内：窗口内 daemon 重启会丢失计时器，直到下一回合收尾
重新武装（可接受——下一回合会重新武装；不再有后续回合的 Session 保持草稿，
与之前一致）。标题晚于 90 秒到达的 Provider 会先得到本地兜底标题，随后被晚到的
Provider 标题覆盖。兜底以 Session 的首条用户 prompt 作为生成输入，与创建期生成
本会使用的完全一致。

## 验证

`shouldFallbackGenerateSessionTitle` 覆盖接管/非接管、缺失/草稿/用户/已生成
标题状态与 Session 不存在的情形。`provider-title-fallback.test.ts` 以手动时钟
驱动调度器：仅对接管的 Session 武装、窗口后以首条用户 prompt 生成、Provider
标题或用户命名在窗口内落地则跳过、跨回合重叠时保留最早截止时间、运行时覆盖
视为非接管、空 prompt 跳过、dispose 取消。未用真实 Claude/Codex/Grok 会话端到端
驱动兜底路径；促成本笔记的网关失败是直接对其上游验证的（原网关无标题、修补后
网关正常命名），但那项验证属于网关自身的修复。
