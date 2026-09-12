# 优先使用机器 owner 的 Git identity

Status: implemented
Translation: current

[English](2026-09-08-machine-owner-git-identity.md)

## 摘要

Lody 过去每一轮都优先使用请求者的账号邮箱，并在该邮箱不可用时回退到机器 Git
identity。新策略只允许机器 owner 优先使用本地 Git 配置，并禁止其他请求者回退到机器
identity。这样既保留 owner 明确配置的仓库身份，也避免团队成员被错误署名为机器 owner；
剩余权衡是本地配置的邮箱不一定能关联到 owner 的 GitHub 账号。

## 决策

策略边界使用机器所有权。初次创建 session 和后续轮次绑定时都已有该信息；机器在共享与
私密之间切换时，该边界保持稳定，也无需在 prompt 路径增加 workspace 成员数或机器可见性
网络查询。

身份来源顺序为：

- 机器 owner：机器/仓库生效的 Git identity、Lody/GitHub 解析身份、中性 LodyAI 身份；
- 非 owner 请求者：Lody/GitHub 解析身份、中性 LodyAI 身份。

非 owner 路径不会读取机器 Git 配置。GitHub PR、评论、合并和 push 的鉴权仍由独立的、
绑定请求者的 GitHub token 控制。

ACP 子进程会在启动时快照环境，因此只更新 host 侧 Session 配置无法改变后续工具子进程。
Session 会记录启动快照中的 identity；新 turn 解析出不同 identity 时，执行层会在内部终止旧
子进程，再以重新构建的环境恢复同一个 ACP session，之后才发送 prompt。这个内部替换不会发布
SessionManager termination 生命周期，因此当前 turn 的状态、presence 和 ACP 输出路由得以保留。
已 adopt 的 speculative preparation 如果启动快照过期，也使用相同的替换路径。这样无需增加
adapter 特定的可变环境协议，并且只有 identity 变化时才承担重启成本。

## 备选方案

没有采用精确判断“单人 workspace 或私密机器”的方案。CLI 并不持续持有这两个权威状态，
它们也可能在 session 期间变化；机器所有权无需新增网络依赖即可表达隔离边界。

也没有继续让机器 owner 优先使用请求者账号邮箱，因为这会忽略用户明确设置的 Git 配置，
并可能把 Lody 登录邮箱写入公开 commit。

## 证据与验证

行为实现在 `apps/cli/src/session/git-identity.ts`，所有权由
`apps/cli/src/session/session-manager.ts` 与
`apps/cli/src/session/session-execution-service.ts` 传递。单元测试位于
`apps/cli/tests/git-identity.test.ts`，产品意图以 draft 记录在
`specs/git-commit-identity.md`。identity、environment、execution-service 与 session-manager
定向测试共 121 项，均已通过，CLI typecheck 也通过。此前的仓库级检查完成了 typecheck 和
lint（lint 为零错误），随后因无关的 components 测试运行时在 152 个测试文件中将 React
`act` 暴露为非函数而停止。
