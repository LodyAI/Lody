# 将 GitHub broker 上下文限定于其持有者

Status: implemented
Translation: current

[English](2026-10-08-github-context-lifecycle.md)

## 摘要

被放弃的预准备可能在会话 ID 下留下 GitHub broker 上下文，轮次开始的刷新把这种成员关系当作
托管注册，使之后的本地项目轮次以 `github_context_missing` 失败。broker 上下文现在改为租约，
未被接管的预准备会释放，刷新也像预准备一样跳过本地项目；缺少 policy 的托管会话仍失败关闭。
留下残留上下文的桌面交互属于推断，未复现；测试已编写但作者 Agent 未运行。

## 证据

已确认：同一本地会话首轮刷新成功、Agent 已在运行后，失败轮次记录
`execution.refresh_gh_token status=error durationMs=0`。用已安装 bundle 自带的预准备、成员
判断、刷新与策略方法，无 policy 的本地会话仅在其 ID 存在上下文时失败。源码中成员关系是刷新的
唯一门槛，预准备在最后一次中止检查前注册上下文，清理从不撤销。

推断：取消与认领未命中不等待进行中的凭据设置，被放弃的托管预准备可能在冷启动本地会话首轮刷新
之后才注册。这与日志相符，但触发它的用户交互尚未确认。

## 决策

`GitCredentialBroker.acquireSessionContext` 返回按会话 ID 计数的幂等租约；最后一次释放撤销当前
token 与文件，所有者轮换后亦然。预准备最后才获取，中止、失败或未被接管的清理时释放，接管时
移交租约。持久会话仍保留上下文至关闭，关闭推进代数，旧租约不能释放新上下文。刷新在检查成员
关系前对本地项目返回；无 policy 的托管会话仍失败关闭，所有者变更仍终止旧进程。

未采用：删除缺 policy 检查或给本地会话补 policy 会掩盖托管设置错误或纳入本地会话；每次清理都
撤销会让迟到的清理撤销替代会话共享的 token；只看会话自身 policy 会去掉托管失败关闭检查。

限制：会话终止时仍不释放持久上下文；解析出不同所有者的过期预准备仍会轮换 token。

## 验证

回归测试覆盖 broker 租约（共享持有者、所有者轮换、关闭）与真实预准备运行时：凭据设置期间中止、
未接管与迟到的清理、接管后的多轮刷新、本地会话与他人上下文并存，以及托管会话缺 policy 的失败。
作者环境未执行这些测试。相关：
[本地原生认证](../feature/2026-09-29-local-project-native-github-auth.zh.md)、
[按命令选择凭据](../architecture/2026-09-26-github-command-credentials.zh.md)。
