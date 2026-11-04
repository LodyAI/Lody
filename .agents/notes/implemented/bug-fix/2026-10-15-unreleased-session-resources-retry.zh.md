# 重试未释放的 Session 资源

Status: implemented
Translation: current

[English](2026-10-15-unreleased-session-resources-retry.md)

## 摘要

根进程已经结束或进程组只剩僵尸时，终止仍可能报告失败。进程树验证接受这些情况，保留真实存活者的失败信息。 [Inbox 可用性决定](2026-10-29-inbox-no-durable-block.zh.md) 取代原有后继阻塞：移除失败的 Agent 实例，清理不再阻塞后续输入。

## 保留的进程决定

SIGKILL 发送失败后仍等待有上限的终止预算。POSIX 只有可见成员全部为僵尸才视为消失；内核仍报告组存在时，扫描不可用或空结果仍不确定。精确扫描只用于存活超过 250 ms 的进程组及信号预算到期时；macOS ps 最多耗时两秒，健康退出不会支付这项成本。Windows 即使 taskkill 部分失败，根已退出也可成功。Session 并行等待进程树与 sandbox，避免等待翻倍。 拒绝自行成为 subreaper，因为会抢走 Node 拥有的子进程。hidepid 下可见组只有僵尸，仍可能漏掉无法发送信号的外部成员。

旧的 preparation pool 已删除。其重试／阻塞规则及当时被否决的“记日志后继续”方案由上述可用性决定取代；保留进程失败证据，但不复用失败 Agent。

## 验证限制

`packages/shared/tests/process.test.ts` 使用注入进程表与时钟； `apps/cli/src/session/session-terminate-cleanup.test.ts` 覆盖并行终止。 真实 Windows taskkill 和各主机 ps 解析仍需独立验收。
