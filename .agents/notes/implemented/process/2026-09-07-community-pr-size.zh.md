# 社区 PR 规模与团队身份

Status: implemented
Translation: current

[English](2026-09-07-community-pr-size.md) | 中文

## 摘要

社区贡献者提交的超大 PR 很难安全 review，也容易悄悄破坏既有 invariant。因此，除非维护者在对应 Issue 上 assign 了作者，社区 PR 必须控制在 1000 行改动以内。Agent 用一份很短的 GitHub 登录名名单，或用户的明确声明，一次判定是否为 Lody 团队，避免团队会话把维护者误当成外部贡献者并浪费 token。

## 问题

热心贡献者（不少缺少开源协作经验，且常通过 coding agent 提交）会把大规模改动当作礼物发来。要在不破坏 local/cloud、catalog、协议等 invariant 的前提下 review 这些补丁并不现实；若没有公开规则就拒绝，又显得武断。

同一套 Agent 文档也会被 Lody 团队自己的会话读到。如果只写“社区贡献者必须……”，却没有便宜的身份判定，团队 Agent 会把自己当成外部贡献者，并在身份问题上消耗大量 token。

## 决定

- Agent 约束：根目录 `AGENTS.md`（入口）和 `.github/AGENTS.md`（创建 PR 的路径）。
- 给人类看的惯例说明：`CONTRIBUTING.md`。
- 执行：fork PR 超过 1000 行（新增 + 删除）时，需要维护者在关联 Issue 上 assign 作者；超过 200 行且缺少 Issue 引用的规则保持不变。同仓库分支仍视为 `internal`。

身份判定只做一次：

1. 用户声明自己是 Lody 团队，或
2. GitHub 登录名是 `zxch3n`、`Leeeon233` 或 `wibus-wee`（git `user.name` 为 Zixuan Chen、Leon Zhao 或 Wibus Wu 亦可）。

否则视为社区贡献者。不要再查 remote、组织 API 或 `author_association`。

名单取自 2026-09-07 时 `LodyAI/Lody` 的 write/admin collaborator。未知登录名默认按社区处理，直到名单更新。团队成员应推送同仓库分支；即使作者是团队登录名，fork 仍按外部贡献处理，这与既有 PR 策略一致。

## 未采用的方案

- **不定数字上限、个案 review：** 已经失败；成本发生在维护者说不之前。
- **用 `author_association` 或 origin URL 分类：** owner 的 fork 按设计仍是外部贡献；直接 clone `LodyAI/Lody` 是常见社区起点，只看 origin 会误判。
- **让 Agent 现场查组织成员 API：** 额外请求、消耗 token，且贡献者环境里认证不稳定。
- **把邮箱写进公开名单：** 没有必要的个人数据；GitHub 登录名已经公开。

## 限制

1000 行按 GitHub 的 additions + deletions 计算，包含 lockfile。assign 是维护者的显式动作，类似于 `status:pr-policy-bypass`。成员变动后名单会过时；保守默认仍是社区贡献者。
