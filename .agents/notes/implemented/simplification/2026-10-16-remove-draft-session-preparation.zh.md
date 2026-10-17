# 移除草稿会话预热

Status: implemented
Translation: current

[English](2026-10-16-remove-draft-session-preparation.md)

## 摘要

用户输入第一条消息时，桌面端会请求目标机器提前启动 agent 进程、创建 worktree，
让第一轮直接接管。在一台机器三天的日志里，daemon 预热了 64 个草稿，一次都没有被接管。
其中 27 次在消息到达后被判定不兼容，整套删除后再从零重建；重建比普通冷启动更慢，
有时还会让这一轮直接失败。本次移除预热：会话只在第一轮派发时才启动 agent 和
worktree。daemon 仍会回应旧请求，保证旧版桌面端可用；旧版 daemon 预热的
worktree 要么由对应会话安全地认领，要么被移除。

## 问题

用户反馈：发到远端机器的消息很快显示已读，但会在“启动中…”停留很久。已读标记在
daemon 看到待处理的用户消息时立即写入，所以这段等待完全是 daemon 在 prompt 之前的工作。

一次这样的 turn（2026-10-16）的 daemon 日志给出了代价：预热在发送前 80 秒就已完成；
派发时认领未命中，daemon 杀掉预热的 agent，删除预热的 worktree 和分支（约 8 秒），
然后走冷启动：`git fetch`、创建 worktree、Git 身份、启动 agent、`newSession`（约 16 秒）。
从派发到第一次 prompt 共 33 秒，其中等待会话就绪占 26.4 秒。

这台机器三天的 daemon 日志里，共预热 64 个草稿，新建 54 个会话，没有一次预热被接管。
被丢弃的 27 次，等待会话就绪的中位数是 11.4 秒；没有预热的冷启动中位数是 6.6 秒。
也就是说，只要存在预热，第一轮反而更慢。

认领为何未命中尚未查明。接管要求请求者、项目、启动配置和运行选择（模型、memory、
MCP、选项值）完全一致；该 daemon 早于
[预热清理诊断](../bug-fix/2026-10-16-preparation-cleanup-diagnostics.zh.md)
中新增的未命中原因日志，所以日志里没有记录是哪个字段不同。对本地 worktree 项目，代码里能看到一个原因：预热记录的
是项目的分支选择（`main`），而正式创建比较的是解析后的引用（`refs/heads/main`），这类认领
永远无法匹配。

代价不只是延迟。预热有一套独立的生命周期：TTL 控制、冷启动必须等待的退出屏障、
接管时转移的凭据租约、推测性 worktree 标记，以及 `AgentClient` 启动流程中的认领闸门。
最近的几个修复都只是为了让这套生命周期保持安全：
[退出屏障](../../archived/bug-fix/2026-10-09-session-preparation-retirement.zh.md)、
[未释放资源可重试](../bug-fix/2026-10-15-unreleased-session-resources-retry.zh.md)
以及上面的清理诊断。其中一个记录过一次 turn 在 75 秒后失败，原因是释放未命中的
预热时超时。

## 决定

- 桌面端不再发送 `session/prepare` 或 `session/prepare-cancel`。
- daemon 只在派发时，通过普通的会话创建路径创建 agent 进程、沙箱、凭据和 worktree。
  删除预热服务、TTL 控制、接管、`AgentClient` 启动中的认领闸门，以及推测性 worktree
  的创建/认领/完成步骤。
- 两个 RPC 方法及其 schema 保留：旧版桌面端仍会发送，daemon 立即回应，不做访问检查，
  也不做任何工作。prepare 返回已接受的 `duplicate`，旧版桌面端于是只持有这一个租约，
  直到草稿空闲或发送；若返回拒绝，它会在每次停顿后重新发送 prepare 和 cancel。
  cancel 返回 `not-found`。
- `legacy-speculative-worktrees.ts` 处理旧版 daemon 留下的标记。会话创建在探测目录之前
  先认领该会话的标记，并对 worktree 重新运行 setup，因为预热从未完成过它；setup 成功后才
  删除标记。从未被会话接管的 worktree，若针对其他仓库或基准分支则重建。已被会话接管的
  worktree（`durable-pending-setup`，或创建时带有要还原的分支）绝不会因目标不一致而被销毁；
  认领会在创建记录分支之前把未接管的标记提升为已接管。删除 worktree 会一并删除分支，而恢复
  会话要按名字还原分支；像 `main` 与 `refs/heads/main` 这样的写法差异，否则会让会话永久
  无法恢复，测试已复现这一点。启动和元数据恢复时，
  清理流程移除孤儿：会话既未正式创建、也不在创建中的标记及其创建的 worktree。worktree GC
  做不到这一点，因为它从不处理自己不认识的会话。新 daemon 不再写标记，所以清理无需过期
  窗口；它与认领共用按会话的标记锁，并在锁内重新检查活跃状态，因此不会删除刚被启动中的
  会话接管的 worktree。
- `isSensitiveAcpConfigOptionId` 移到独立的 shared 模块；Role、定时任务和保留的请求
  schema 仍在使用它。

## 备选方案

- **找到并修复认领不一致。** 可行，新的未命中日志也能指出具体字段。但上述生命周期成本
  会全部保留；即使认领正确，也只有在用户停留在输入框足够久、预热完成后才有收益。
  丢弃时会从零重建 worktree，所以只要仍有不一致，“比冷启动更慢”的问题就还在。
- **未命中时保留 worktree，只替换 agent。** 能消除最坏情况，但仍要为一项从未被测量
  的收益保留预热生命周期、凭据转移和退出屏障。

## 取舍与限制

- 新会话的第一轮现在总要付冷启动的代价。在这台机器上中位数为 6.6 秒，大头是
  `git fetch` 及其 GitHub token 请求，那是另一项后续工作。
- 等到没有受支持的 daemon 或桌面端还会产生它们时，删除
  `legacy-speculative-worktrees.ts`、拒绝处理函数和请求 schema。

## 验证

- 类型检查：CLI 源码、`@lody/shared`、`@lody/loro-streams-rpc` 和 `@lody/components`
  通过。对改动文件运行带类型信息的 lint，无错误。
- 已通过的测试：旧标记测试（任意时长的孤儿都会被移除、保留接管而来的目录、保留已正式
  创建/活跃/其他工作区的标记、在清理检查期间启动的会话保留其 worktree、删除失败后保留
  以便重试、目标不匹配时重建、匹配时在 setup 完成前保持待 setup）；完整的 session-manager
  测试，包括真实 Git 场景：旧 worktree 在恢复时被复用并重新运行 setup；基准分支写法不同的已接管
  worktree 在自己的分支上恢复；未接管且不匹配的被重建。按旧规则（任何不一致都销毁），
  这些接管场景会以 `Session restore branch not found` 失败；凭据 broker 的 worktree 测试；AgentClient 会话启动；dispatch watcher；凭据运行实例
  所有权；shared 的 schema 与敏感项测试；Loro Streams RPC 测试；以及 chat-landing、Machine
  RPC facade 和 runtime 测试。
- 真实 Git 测试在干净的进程环境中运行；在当前 agent 沙箱中，继承的环境会让 `git commit`
  卡住。
- 尚未在远端机器上测量移除后的延迟。
