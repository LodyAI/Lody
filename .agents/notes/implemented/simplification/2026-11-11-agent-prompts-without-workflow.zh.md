# Agent 提示词只带请求和事实，不带工作流程

Status: implemented
Translation: current

[English](2026-11-11-agent-prompts-without-workflow.md)

## 摘要

Lody 自带的提示词曾规定 Agent 该怎么干活：每批委派结果都以 “Review the completed
results…” 开头；Fix CI 先在客户端拉取失败检查，再规定读日志、找根因、本地跑检查的流程。
有用户反馈花费是另一款工具的五倍以上，自动链最深到八层；每条复审指令都会再开一轮委派。
现在 Lody 只提供工具，提示词只带用户的请求和 Agent 无法自行发现的事实。唯一保留的常驻
指令是 Create PR 的分支 upkeep：回合结束不会自动提交，而用户要的是一个跟上工作的 PR
（[upkeep 决策](../architecture/2026-09-12-pr-branch-upkeep-without-auto-commit.zh.md)）。

## 决策

- Inbox 续跑提示词只说明下面是委派结果；`batchPreview` 开头只给批次标识、说明结果是
  参考数据而非用户指令，以及被省略的结果在哪里读取。
- Create PR 与 Create Draft PR 只写请求和一条事实：`gh` 使用机器上保存的登录，沙箱内的
  命令通常读不到。缺了这句，沙箱里的 Agent 会认证失败并要求用户重新登录。
- 每轮 upkeep 保留，缩短为一句。Commit & Push 只写请求。
- Fix CI 和 Resolve Conflicts 只写仓库和 PR。CI 结论已来自 Session 元数据，客户端不再
  先拉取检查结果。
- Project group 只追加事实：组目录不是 Git 仓库，成员列在对话里。
- 约束规则在根 `AGENTS.md`；Inbox 专属规则在 `apps/cli/src/orchestration/AGENTS.md`。

## 备选方案

- 删除每轮 upkeep：被否决，没有它时 PR head 会落后，直到用户按下 `Commit & Push`。
- 把 “review” 换成 “不要再 review”：被否决，否定式指令同样会影响每一批。
- Fix CI 提示词保留失败检查列表：被否决，Agent 用同样的 `gh` 权限就能读到，客户端
  预取还拖慢发送。

## 影响

`lody_session_create` 的说明只陈述委派提示词相关的事实（历史不会被复制），不再规定其
内容。原生 iOS 与 Android 客户端各自保存更长的快捷操作文案，不在本次范围内。

## 验证

`apps/cli/tests/session-execution-service.test.ts` 与 `apps/cli/src/orchestration`
覆盖 Inbox 路径。快捷操作提示词是纯字符串，没有行为测试。对 token 花费的影响未测量。
