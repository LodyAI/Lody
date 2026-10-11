# GitHub 命令凭据

Status: draft
Translation: current

[English](github-command-credentials.md)

当前网络认证契约见[简化身份降级](github-identity-fallback.zh.md)，替代旧实现中的
实时策略门禁、requester 网络身份、REST 权限预检和同来源重试。

本地项目及其 worktree 保留原生认证，即使 remote 是 GitHub，也不注入托管包装器、
broker 上下文或 token。托管会话解析实际命令目标，按对话 owner 个人、匹配 owner
机器、仓库 App 的顺序，每个来源尝试一次。

commit 作者独立于网络凭据。requester 开启个人身份时使用其 Lody 账户身份；
否则机器 owner 可以使用机器全局 Git 作者配置。不能读取托管 bare 仓库的 user._，
因为所有 worktree 共享它，会污染其他会话。作者通过进程的 GIT_AUTHOR\__ 和
GIT_COMMITTER_* 注入，避免共享机器上的 requester 相互继承身份。

宿主 worktree 操作在 clone/fetch 和 checkout 全程传递准备好的 PATH、GIT_EXEC_PATH、
本地配置及不可变 owner 快照。调用方上下文缺失属于配置错误，不能从环境 broker
变量推断所属工作区。

## 证据

runtime、原生 transport、broker、gh 和 worktree 测试覆盖本地客户端边界。
执行限制及验证范围见[降级契约](github-identity-fallback.zh.md)；生产托管后端授权
不属于公开客户端实现。
