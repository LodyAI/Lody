# 项目斜杠命令改为能力缓存旁的差异行

Status: implemented
Translation: current
Language: [English](2026-09-27-acp-command-scope-rows.md)

## 摘要

每个新建 session 都会把 agent 的斜杠命令列表写进该 agent config 在机器上的 capability 行。
而这个列表取决于 session 所在的项目目录，所以每当 session 换一个项目启动，
就会重写整行 25–40 KB，并同步给 workspace 内的所有客户端。
实测 probe 表明，不同目录之间变化的字段只有命令列表。
现在该行对每个 capability 来源版本只保留一份基础列表；session 只把本项目的增删记进一条按项目区分的
小型 `acpCommandScope` 行，composer 读取时再把差异合并到基础列表上。
用真实 probe 输出回放，每次切换项目的同步量从每次 29–42 KB，降为每个项目只写一次的 0–12.5 KB。
本次改动之前构建的 composer 只显示基础列表，在更新之前看不到项目专有命令。

## 问题

`scheduleCreatedSessionCapabilityUpdate` 会把每个新建 session 的 `session/new` 能力，
写回按 config 区分的 `['acpCapability', AgentConfigId]` 机器 Flock 行。
行值是整体写入的，每次变化都会同步给 workspace 内的所有客户端。
在一台开发机上，Claude 和 Codex 的这一行为 4–40 KB（主要是 `availableCommands`），
Devin 为 177 KB，整个 workspace 合计约 700 KB。2026-09-25 的 daemon 日志中有 207 次整行写入，
但日志无法说明是哪个字段变了。PR #760 已经去掉了大部分刷新 probe，剩下的主要写入方就是新建的 session。

为了找出变化的字段，对内置 Claude 和 Codex 在四个目录下运行了真实 probe（`fetchAcpCapabilities`）：
home 目录、本仓库，以及另外两个仓库。除 `availableCommands` 之外，所有字段在四个目录下逐字节一致，
包括每个 `configOptions` 的 `currentValue`：

| Agent | 共同命令 | 项目专有命令 | 行大小 |
| --- | --- | --- | --- |
| Claude | 105 | 0–7 | 36.8–40.0 KB |
| Codex | 75 | 0–32 | 26.2–38.6 KB |

所以抖动来自项目级的命令和 skill，而不是
[按 model 控件提案](../../proposed/architecture/2026-09-27-per-model-acp-controls.zh.md)
怀疑的快照 model 翻转。而且，最后写入者胜出也让斜杠菜单不一致：composer 显示的是最近启动过 session 的那个项目的命令。

## 决定

- **基础列表**：capability 行的 `availableCommands` 归 probe 所有，probe 在 daemon 自己的目录中运行。
  已有同一 `sourceVersion` 的列表时，新建 session 保留它；没有时（首次写入，或 agent 升级），
  沿用旧行为，由 session 的列表作为基础列表。
- **项目差异**：带项目的新建 session 写入 `['acpCommandScope', AgentConfigId, scopeKey]`，
  值为 `{ sourceVersion, added, removed }`。`added` 是基础列表没有、或描述不同的命令；
  `removed` 是项目不提供的基础命令名。差异为空时删除该行；session 没有报告命令时不动该行。
  值中没有时间戳，所以同一项目的后续 session 不产生写入。
- **scope 键**：`getAcpCommandScopeKey` 给出 `local:<localProjectId>` 或 `github:<owner/repo>`（小写）。
  同一项目的多个 worktree 共用一个键；聊天 session 没有键，看到的是基础列表。
- **读取**：`MachineViewMeta.acpCommandScopes` 承载这些行。session composer、草稿标签和 chat landing
  传入所在项目的键，`resolveAvailableCommands` 只在差异的 `sourceVersion` 与基础列表一致时应用它；
  升级之后，项目显示基础列表，直到该项目中有 session 重新计算差异。
- **清理**：在 CLI 或 renderer 中删除 agent config 时，一并删除它的 scope 行。
  已删除 config 的 capability 行在本次之前就会残留，这个缺口保持不变。
- 去重比较现在包含 `goalActions`，只有它变化时不会再被跳过。

## 可观测性

- `[acp-capabilities] write`（debug）记录每次 capability 写入尝试：config、`source=probe|session`、
  结果（`unchanged`、`renewed` 或 `written`）、变化的顶层字段、写入字节数，以及 scope 行的结果。
- 同一行带有 daemon 启动以来的累计写入次数、字节数和跳过次数，capability 与 command scope 两类分别统计，
  一次 grep 就能得到当天的成本。
- `[acp-runtime-config] write`（debug）记录 session runtime 配置快照的每次写入，
  包括 revision、字节数和 `writesThisTurn`，即按 model 控件提案中提到的逐 turn 写入放大。
- `lody machine list --json --include-acp-capabilities` 输出中包含 `acpCommandScopes`。

## 混合版本

- 新 daemon、旧 composer：旧 composer 只读取基础列表，更新之前它的斜杠菜单里没有项目专有命令，
  但直接输入命令仍会送到 agent。接受这一点，而不是继续把每个项目的列表写进基础列表，否则抖动依旧。
- 旧 daemon、新 composer：没有 scope 行，基础列表的行为与之前一致。
- 旧读者会忽略未知的 Flock 行类型；严格的 `machine/acp-capabilities-refresh_response` schema 未改动。

## 备选方案

- **每个项目一整行**：每行都稳定，但每个项目、每个 agent 都要复制一份 25–40 KB 的基础列表，
  每个新客户端都要下载。
- **命令存进 session 文档**：只能修好已有 session；新对话仍然没有项目命令，而且每个 session 文档都要带一份列表。
- **只由 probe 提供命令**：项目 skill 会从菜单中完全消失。
- **model 翻转时冻结 `configOptions`**（提案中的「快照稳定化」）：实测这些字段从未变化，
  只会增加复杂度，没有节省。

## 验证

- 用真实 probe 输出回放 `computeAcpCommandScopeDelta`：一次项目切换从每次 38.3–41.4 KB（Claude）和
  29.4–41.6 KB（Codex），变为每个项目只写一次的 0–3.2 KB 和 0–12.5 KB。
- `apps/cli/src/lib/loro/machine-document-capabilities.test.ts` 在内存 Flock 上驱动真实的
  `MachineDocument`。逐一移除下列机制时，对应测试都会失败：
  - 保留基础列表；
  - 来源版本门控；
  - probe 与 session 的区分。
- shared 测试覆盖行解析、删除 config 时的清理和差异计算；一个组件测试让行经过 machine overlay，
  进入 `resolveAvailableCommands`。
- 真实流量下的字段级写入计数来自新增的日志行，尚未收集。
