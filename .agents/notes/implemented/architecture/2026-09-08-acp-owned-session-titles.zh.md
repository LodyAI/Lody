# 让 Codex 与 Grok 拥有各自的会话标题，并拆分 ACP 标题谓词

Status: implemented
Translation: current

[English](2026-09-08-acp-owned-session-titles.md)

## 摘要

Lody 希望每个内置 agent 都不再携带自己的 `titleGeneration` 会话配置，转而从其 ACP adapter 取得会话
标题。对全部五个内置 adapter 的审计发现有三个已经能产出可用标题——Claude、Codex，以及与最初仅检查我们
代理层所得结论相反的 Grok（其官方运行时会生成标题并推送，已由实时探测确认）——因此这三者现在采用 ACP
标题，而 Kimi 与 DeepSeek Harness 继续使用隔离生成器。Codex 与 Grok 此前都在重复劳动：各自生成一个标题，
而 Lody 要么重复生成、要么直接丢弃。要落地这一点，必须把单一的 `usesAcpProvidedSessionTitle()` 谓词拆成
「归属」与「信任」两个问题，因为 Codex 会给标题打标签并先发出一个 prompt 预览式的 `fallback`，而 Claude
与 Grok 只推送一个裸的权威标题；把两者混为一谈会把 Codex 的预览提升为会话标题。代价是标题措辞现在归
adapter 所有。分支命名是最后一个仍能启动隔离会话的调用方，它被彻底移除而非本地重新实现：从 prompt 文本
派生 git ref 等于发布该 prompt，而任何基于 prompt 的过滤都无法证明密钥不存在。worktree 会话保留其
`session/<id>` 分支。

## 审计

每个 adapter 都按本仓库固定的提交阅读；下表版本在合并 main 之后重新确认过——合并移动了 Codex、Grok 与
Harness 的固定版本，但这些结论均未改变。

| Adapter | 版本 | 是否发布标题 | `_meta.lody.titleSource` | 是否真实生成 |
| --- | --- | --- | --- | --- |
| `acp-extension-claude` | 0.70.0 | 是 | 完全没有 `_meta` | 是——SDK `generate_session_title` 控制请求 |
| `acp-extension-codex` | 1.10.1（自 1.8.0 起） | 是 | 是，生成的标题标为 `explicit` | 是——在临时线程上用廉价模型跑一轮 |
| `acp-extension-grok` | 0.1.3（运行时 1.0.13） | 是——运行时推送、代理转发 | 完全没有 `_meta` | 是——上游 `title_refresh.rs` |
| `acp-extension-kimi` | acp-server 0.0.1 | 是，但标题是首个 prompt 截断到 200 字符 | 完全没有 `_meta` | 否 |
| `acp-extension-dsh` | 0.1.2 | 否 | 否 | 否 |

有两处「差一点」值得记录，因为它们会改变日后「加上标题支持」的成本。Kimi 的引擎已经跟踪
`SessionTitleKind = 'replaceable' | 'generated' | 'custom'`，并且拥有真实生成器（`SessionTitleService`，
背后是 Moonshot 托管的 `chat_title` 端点）——但该生成器只能从 kap-server 的 HTTP 路由与 node SDK 触达，
而该 kind 在 `packages/acp-server/src/events-map.ts` 的 ACP 边界处被丢弃。DeepSeek Harness 在其依赖闭包中
固定了 `@deepseek-ai/dsh-session-title`，却从未在 `createDeepSeekHarnessCordisConfig` 中挂载它，因此该插件
处于惰性状态。

Grok 是对本次审计早期结论最尖锐的更正。该 adapter 是纯 stdio 代理、没有任何标题代码，很容易被误读为
「Grok 没有标题」。而 `runtime-manifest.json` 固定的官方 `@xai-official/grok` 1.0.13 运行时其实自带完整的
自动标题生成器：其二进制中的字符串包含 `session_title` 工具调用 prompt（"Final session title, just 5-10
word descriptive title for the session"）、失败路径 "session title generation failed, falling back to
truncated user text"，以及用户文档说明标题在首个 prompt 之后立即生成、在最初几轮中重新生成、随后冻结，
并以 `/rename` 与 `/rename --auto` 作为手动覆盖。决定性的是，该逻辑位于
`crates/codegen/xai-grok-shell/src/session/acp_session_impl/title_refresh.rs`——就在 ACP 会话实现内部，与
`goal.rs`、`mcp.rs` 和 `prompt_build.rs` 并列——因此它并非仅限 TUI，而运行时的 ACP `SessionUpdate` 枚举
也包含带 `title` 与 `updatedAt` 的 `session_info_update`。

该标题确实以推送通知的形式抵达 ACP 线路。在一台已配置凭据的机器上针对运行时 1.0.13 进行的探测——一轮
短对话，然后等待 25 秒——每次运行恰好产生一次推送，直连 `grok agent stdio` 与经由
`acp-extension-grok` 两条路径皆然：

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"01a08127-...",
 "update":{"sessionUpdate":"session_info_update","title":"Reply with single word ok"}}}
```

同一标题也落在会话磁盘上的 `summary.json` 中（`session_summary` 非空，说明生成确实发生过），且代理没有
过滤任何东西——两条路径只在生成的措辞上不同。关键在于该消息**完全没有 `_meta`**，因此 Grok 与 Claude
形态相同：一个权威推送标题，没有可供判据的 `titleSource`。也就是说 Lody 今天本就收到了 Grok 的标题，
却因为缺少标签而在 `handleAgentSessionTitleUpdate` 中把它丢弃。只观察到一次推送，之前没有 `fallback`
式的预览。

在 Lody 所运行的模式下不存在拉取路径：在 `grok agent stdio` 下，无论直连还是经代理，`x.ai/session/info`
都回答 `-32601 Method not found`。该字面字符串确实存在于二进制中，因此该方法大概注册在其他通道上，但不在
ACP agent 通道上。这带来一个超出标题范围的后果，因为证据已在手边故一并记录：`proxy.js` 在 `model_changed`
之后与会话开始时会发起 `internalRequest('context', ...)`，并在回复为错误时丢弃它，因此内置 Grok 的上下文
窗口用量通知在该运行时上是静默失效的。修复它是独立工作，此处不做尝试。

## 决策

`usesAcpProvidedSessionTitle()` 在三个调用点回答了两个不同的问题，而 Codex 对它们需要相反的答案：

- *Lody 是否可以跳过自己的隔离生成器并隐藏标题配置？* 对 Claude、Codex 与 Grok 是。这现在叫
  `acpOwnsSessionTitleGeneration()`。
- *Lody 是否可以信任一个不带 `titleSource` 的推送标题？* 只有 Claude 与 Grok 可以，它们都发送裸的
  `session_info_update`。这现在叫 `trustsUntaggedAcpSessionTitle()`。

能力协商是另一个方案，它是被推迟而非被忽略。这些 adapter 本就声明了 Lody 会消费的 `_meta.lody` 能力
（`usage`、`rateLimits`、`compaction` 等），Grok 代理甚至会合成一些运行时从不发送的能力，因此
`sessionTitle` 能力正是这条规则最终想要的形态——当 `BuiltinRuntimeOverrides` 指向更旧的二进制时它会正确
降级，也能让 registry 与自定义 provider 自行加入，而这两点身份白名单都做不到。推迟它的原因正是其成本：
`acpOwnsSessionTitleGeneration` 会在 `initialize` 返回之前的会话启动阶段被查询，也会在没有 client 的设置
对话框中被查询，因此它需要该能力**被持久化**——在 `AcpCapabilityCacheEntry` 上新增字段，贯穿能力探测与
两个位置参数的文档签名，外加一次 `ACP_CAPABILITY_CACHE_VERSION` 提升（会让每位用户的缓存失效）以及一条
面向从未探测过的配置的引导路径。那是比本次更大的改动，且横跨三个 adapter submodule。
`BUILTIN_ACP_TITLE_OWNERSHIP` 是过渡替代；它对 `BuiltinAgentType` 是穷尽的，因此新的内置 agent 不会静默
取到默认值。

该表也把原本两份手工同步的列表合并了。被信任的集合是拥有集合的真子集，把这一点表达为每个 agent 一个
`none | untagged | tagged` 取值，使该关系成为结构性的而非一句注释。Codex 正是这两个问题会不同的原因。它在
生成 `explicit` 标题之前会先发出一个 `fallback` prompt 预览标题，而 `apps/cli/src/agent/AGENTS.md` 早已
要求拒绝该预览。保留单一谓词并把它扩展到 Codex，会静默地让原始首个 prompt 成为会话标题——而这正是本次
拆分要防止的主要陷阱。相比之下，Grok 被观察到恰好推送一个标题、之前没有预览，因此它与 Claude 一同进入
「信任未标记」集合。

`titleGeneration` 配置面（schema 字段、设置区块、CLI 参数）被刻意保留。移除它会剥夺 Kimi、DeepSeek
Harness、registry 与自定义 provider 仍然依赖的廉价模型与最小权限模式选择。该配置只是对 Codex 与 Grok 变得
不可达，正如它此前对 Claude 那样。

「不可达」必须在每条路径上都成立，而不只是设置表单。分支命名会为它正在命名分支的那个 agent 解析已持久化的
`titleGeneration`，因此在本次改动之前存储的值，会在配置从 UI 消失之后继续影响 Claude、Codex 与 Grok 的
运行。该查找随分支命名路径本身一起消失（见下）。

## 取舍与限制

Codex 在首轮完成之后才生成标题，并且在被恢复的会话上完全跳过生成（此时其内部来源为 `unknown`），因此被
恢复的 codex 会话不再获得 Lody 生成的标题。生成在 adapter 内部也是尽力而为，并会吞掉失败而不通知 client，
因此一次失败的生成现在会让草稿标题留在原处，而不是回退到 Lody 的生成器。

把标题交给 adapter，也就把措辞交了出去。这三者都看不到 `DEFAULT_TITLE_GENERATION_PROMPT`，因此它所携带的
约束——26 个英文字母的预算、单行规则——对它们不再适用。Grok 还会在最初几轮中持续打磨标题然后才冻结，因此
Grok 的会话标题在首次出现之后仍可能变化。

分支命名也必须改变，否则隔离会话只会从标题路径搬到分支路径。`maybeRenameSessionBranchFromPrompt` 在会话
就绪时运行，早于任何一轮，因此那时 ACP 标题绝不可能已经到达；一旦标题路径被跳过，它就会启动自己的 agent，
让 worktree 会话仍然停留在与从前完全相同的那一个隔离会话上。该改动历经三次尝试才落地，前两次也被记录，
因为每一次在看清失败原因之前都显得合理。

第一个被否决的是把重命名推迟到推送标题到达之后：那会把一个「仅在会话创建时发生一次」的操作挪到进行中的
会话中间，而此时某一轮可能已经推送过分支或开过 PR，而 `renameBranchWithAvailableSuffix` 只是一句没有
upstream 检查的 `git branch -m`。

接下来落地的是从 prompt 本地派生名称，评审发现它会泄露密钥。分支名就是一个 ref：只要会话开了 PR 它就会
到达远端，而让 agent「在周五之前轮换密码」是再平常不过的请求。这条路径在本分支之前也可达——旧的
`generateTitleIsolated` 在每条失败路径上都会返回 `sanitizeGeneratedTitle(taskPrompt)`——但为这三个由 ACP
拥有标题的 agent 跳过标题生成，把一个罕见兜底变成了常见路径。

随后尝试了两种过滤，都因同一原因失败。第一种剥离形似凭据的 token 并用剩余部分命名分支；然而密钥没有可靠
形状——`hunter2` 既是密码也是普通词——因此基于形状的黑名单只会移除「看起来像密钥」的部分而保留其余：
`Fix DB_PASSWORD=hunter2` 与 `Fix https://alice:hunter2@example.com` 都原样存活。第二种对凭据**语法**
fail-closed（对敏感名称的赋值、URL userinfo、已知前缀、PEM 块、高熵串），确实拦住了上面两例，但任何基于
prompt 的检查在漏判时都是 fail-open，因此像「the password is hunter2」这样的平白散文仍会被发布。一个会
fail-open 的边界不是边界。

于是该路径被移除，而不是第三次去过滤。`maybeRenameSessionBranchFromPrompt`、`deriveWorktreeBranchName`、
`branch-name-generator.ts` 以及此时已不可达的 `renameBranchWithAvailableSuffix` /
`isManagedWorktreeBranchName` 都被删除。worktree 会话保留 `worktree-manager.ts` 给它的 `session/<id>`
分支。没有任何东西被静默丢失：`syncSessionBranchName` 仍会在每轮之后记录会话真实的分支，因此 agent 自己
重命名后也会被采集到，而 GitHub 项目的 prompt 本就带有要求 agent 按任务命名分支的指令
（`GITHUB_WORKTREE_SYSTEM_COMMANDS`）。该指令不是替代品——`buildPrompt` 只在 `startSession` 中运行，且该
指令在存储前被剥离，因此从第二轮起以及在被恢复的会话中都不存在；而且它只在 `project.kind === 'github'`
时注入，但带 `useWorktree` 的本地项目同样会创建 worktree。

要恢复自动命名，需要一个可证明与 prompt 隔离的来源。会话就绪时并不存在这样的来源：ACP 标题尚未到达，而
隔离生成器自身的兜底就是原始 prompt。一个已知由模型生成而非由 prompt 派生的标题可以胜任，但当前代码无法
区分两者。

归属判定还必须考虑 `BuiltinRuntimeOverrides`。上表描述的是每个 agent 通常启动的托管运行时，而 override 可以
把同一个 `agentType` 指向任意可执行文件，包括早于标题行为的版本——Grok 的标题生成就住在运行时里，而 Codex
的生成需要更旧构建所不具备的 `ephemeral` 线程。这样的会话此前根本得不到标题：隔离生成器被跳过、ACP 上什么
也没来，而本可修复它的设置又被隐藏了。现在只要 override 处于活跃状态，`acpOwnsSessionTitleGeneration` 就
返回 false，从而恢复本地生成器及其配置。信任闸门刻意保持不变：确实推送了好标题的 override 依然会被采用，
而 Claude 在本分支之前就是这样的行为。

有一处残留不一致是已知且不予处理的：`acpOwnsSessionTitleGeneration` 只管设置对话框，而 `lody agent-config`
与引导中的 provider 页面仍会为这些 agent 接受并持久化 `titleGeneration` 块。存储的值现在可证明是惰性的——
在任何路径上都没有人为它们读取它——因此这只是外观问题，在配置写入路径上应用该谓词是后续工作。

验证包括类型检查、lint，以及覆盖两个谓词、分支名派生用例，以及标题生成区块被隐藏的对话框用例的共享单元
测试。Grok 的行为依赖上文所述的实时探测；未演练真实的 Codex、Kimi 或 DeepSeek 会话，也没有端到端驱动过
真实的 worktree 重命名。
