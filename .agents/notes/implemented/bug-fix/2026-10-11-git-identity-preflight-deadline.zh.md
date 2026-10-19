# 限制 Agent 启动前的 Git 身份预检等待

Status: implemented
Translation: current

[English](2026-10-11-git-identity-preflight-deadline.md)

## 摘要

Session 启动等待可选的 Git 身份策略 Promise，却没有完整操作级期限。即便底层已有 fetch
中断，查询持续 pending 仍可能阻止 Agent 启动，直到恢复看门狗令回合失败。现在每次查询限制为
3 秒，重试一次后保守关闭个人身份，让启动继续。取消会结束等待，并阻止迟到结果应用身份或启动
Agent；事故中底层 fetch 中断未结束等待的原因仍未证实。

## 决策与取舍

3 秒期限在现有 2.5 秒 fetch 中断之上留少量余量，两次挂起的调度等待约为 6 秒。Effect 负责
期限、重试和中断，临时 Promise facade 衔接 SessionManager。每次启动的 AbortController
属于现有 Promise 启动边界，沿调用传递，不按 Session ID 重新读取，避免被放弃的尝试借用
新尝试的生命周期。它并不承诺取消所有 worktree 或运行时准备工作。

本修复补充[有序凭证回退](../architecture/2026-10-03-github-identity-fallback.zh.md)，不改变
网络凭证链。提交身份查询是独立预检，仅重试这个只读查询，不重放不确定的 GitHub 写入，也不
重启整个 daemon。直接降级虽更快，但会错过短暂故障后的恢复；仅限制 fetch 无法提供调用方
需要的完整等待期限。

沿用 initializing 详情显示 `Resolving Git identity`；日志区分尝试次数、超时/拒绝、成功/降级、
取消及耗时，无需新增协议阶段。[初始化契约](../../../../specs/session-initialization-deadline.zh.md)
保持草案状态。

## 验证与限制

可控 Promise 和虚拟时钟覆盖挂起、拒绝、一次重试恢复、取消及迟到结果。SessionManager 测试
经过实际冷启动路径，验证降级能进入 Agent 创建和持久化，而已退役尝试不能启动。
四个相关测试套件共 314 项测试通过。移除继承的会话 Git shim 环境变量和 PATH 项后，完整 OSS
`pnpm check` 通过；CLI 套件 3718 项通过、4 项跳过。CLI 生产构建在 2 GiB Node 堆限制下
通过，文档和格式检查通过。独立安全、竞态、范围及简化审查未发现阻断问题。
不声称已复现线上事故或部署 daemon。
