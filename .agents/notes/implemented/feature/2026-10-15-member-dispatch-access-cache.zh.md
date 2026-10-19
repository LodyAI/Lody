# 派发时缓存成员的已确认访问权限一小时

Status: implemented
Translation: current
PR: not created

[English](2026-10-15-member-dispatch-access-cache.md)

## 摘要

workspace 成员的消息发到别人的机器上时，每次派发都要阻塞等待控制面的实时访问查询。即使同一成员
几分钟前刚被放行，一次短暂断网也会让这一轮停在待处理状态。现在派发会在本地按请求者和本地项目
缓存成员的放行结果，自控制面最后一次确认起一小时内有效。命中缓存时立即派发，同一个后端查询在
后台运行，用来刷新或清除该条目。代价是撤销延迟：控制面不可达时，被撤销的成员最多还能继续派发
一小时。

## 问题

`decideSessionAccessFromCatalog` 只能放行 owner 缓存。只要请求者不是机器当前登录的账号，就会落到
`canUseMachine`，而对成员来说那总是真实的后端调用。2026-10-15，一台 CLI 账号与发消息账号不同的
机器在几分钟内多次遇到 `fetch failed` / `ETIMEDOUT`，受影响的每一轮都变成了 `indeterminate`。

## 决定

- catalog 的 workspace 条目新增可选的 `memberAccessSnapshots`：
  `{ requesterUserId, localProjectId?, ownerUserId, machineId, verifiedAt }`。本地项目属于 key 的
  一部分，因为项目共享本身就是后端判定的一部分。`ownerUserId` 和 `machineId` 记录产生这次放行的
  CLI 账号和机器。一条放行只回答"这个成员能否使用这个 owner 的机器"，所以策略要求两者都与当前
  派发一致；在不同账号或机器下刷新 workspace 列表时会丢弃全部成员条目。评审发现了早先版本的问题：
  workspace 刷新会在账号切换后保留放行，两个账号共享同一 workspace 时，在 A 的机器上被放行的
  成员会在 B 登录后继续被信任。
- 满足 `0 <= now - verifiedAt < 1 小时` 时条目有效。未来时间戳（例如时钟回拨后）不被信任。
- 有效条目返回 `{ outcome: 'allow', source: 'member-cached' }`，派发不等待。这次派发已经发起的
  后端查询就是复核：确认放行会重写 `verifiedAt`，明确拒绝会删除条目，`indeterminate` 什么都不写。
- 未命中缓存的成员派发同样记录确认过的结果；后台重试 fiber 得到明确结论时也会记录。
- 写入时清理过期条目，每个 workspace 最多保留 64 条。workspace 列表刷新会像 owner snapshot
  一样保留这些条目。
- owner snapshot 不变，仍然不过期。

## 考虑过的方案

- **只在离线时把缓存当兜底。** 在线撤销会立即生效，但每次成员派发仍要等后端，请求挂起时这一轮
  要等到失败才继续。owner 路径本来就接受在线撤销后再派发一轮，成员路径与之保持一致。
- **更短或更长的有效期。** 需求方要求 30 到 60 分钟。一小时限定了离线时的撤销延迟，而在线机器
  每次派发都会刷新条目。

## 验证与限制

`apps/cli/tests/session-access-policy.test.ts` 使用真实 catalog 文件和注入时钟，覆盖恰好一小时
过期、按项目和请求者区分、workspace 刷新保留、拒绝清除以及清理过期条目。
`apps/cli/tests/session-dispatch-watcher.test.ts` 让 watcher 使用真实 catalog：没有缓存时离线的
成员消息保持待处理；在线放行写入缓存后，离线也能派发；拒绝之后回到远端校验。没有 watcher 改动时
该测试失败。

只有消息派发使用缓存。Session 准备、取消以及本地项目 RPC 的访问检查仍然直接查询控制面。相关缺陷
（`indeterminate` 访问结果会把 Operation Inbox 输入标为已结束）记录在
[保持访问待定的 Inbox 输入可被重新接纳](../bug-fix/2026-10-15-access-pending-inbox-withdraw.zh.md)。
