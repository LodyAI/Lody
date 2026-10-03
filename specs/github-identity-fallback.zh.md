# 简化 GitHub 身份降级

Status: draft
Translation: current

[English](github-identity-fallback.md)

## 范围与身份

托管 GitHub 会话依次使用对话 owner 的个人凭据、owner 本人机器的原生凭据、
实际目标仓库的 App token。每次操作每个来源只获取一次；凭据缺失、服务故障和
访问通告失败直接进入下一来源，不查询独立身份策略、不重试同一来源、不自动恢复。
本地项目保留原生认证。commit 作者独立处理，继续使用冻结的 turn requester。

宿主从可信会话元数据读取 owner；新会话尚未发布时使用创建者。参与者切换不改变
网络身份。宿主原子写入工作区本地上下文，包含不透明 token 和机器凭据可用资格。
helper 每次捕获一个上下文；宿主 worktree 的 clone/fetch 和 checkout 使用固定快照。
快照缺失或损坏属于配置错误，不能据此借用机器身份。这是进程凭据隔离，并非防御
同一系统账户进程的 OS 沙箱。

## 凭据来源与可用性

本地 HTTP broker 只提供个人与 App token。云请求截止时间为 2.5 秒，helper 请求为
3 秒，包含响应正文。成功凭据可缓存至多 60 秒，按仓库、owner、机器、来源隔离，
且不超过 token 有效期；失败不缓存。配置更新可清空缓存，不承诺离线期间立即撤销。

broker 故障不能阻断具备资格的机器候选。启动失败会报告，但可信本地上下文仍可用；
并发启动共享一次尝试，无定时重启和健康恢复循环。MCP 控制通道不参与凭据选择。

个人/App 尝试隔离机器 credential helper、认证 header、cookie 和 gh 配置。
托管 token 不进入原生凭据存储或全局配置；机器尝试恢复原生设置。
服务是否可用不改变机器资格。App token 按实际仓库隔离；切换目录、显式目标、
子模块分别解析。

## 原生执行

Git 保持标准 URL 和协议，通过工作区 GIT_EXEC_PATH 的 HTTP helper 适配器调用
已安装 Git。标准 GitHub SSH URL 为选择身份转换为 HTTPS；机器候选可使用原生 SSH，
保留显式 443 端口和配置命令。自定义 SSH 别名及冲突的用户 URL 重写不在托管范围内。

选择 Git 凭据前，每个候选执行原生 upload-pack 或 receive-pack 只读通告，
不查询 GitHub REST 权限 API。这样可在 push 开始前降级，实际传输只执行一次。
分支保护和传输阶段错误直接报告，不重放。未知 Git 命令保守使用 receive-pack；
匿名公开读取排在最后，写入不选择匿名。

gh 不做 REST 权限预检，直接执行命令并流式输出。无输出的已知只读仓库命令或 REST 请求失败可降级；
单个非 GraphQL、非分页 REST 请求明确返回 HTTP 401/403/404 且无输出时也可降级。
复合命令、GraphQL、结果未知或部分完成的写入保留原生退出码，不跨身份重放。
无法解析或不支持的目标仅允许具备资格的 owner 使用原生身份，其他情况报告
repository_required。帮助命令无需凭据且隔离机器配置。

## 可观测性与边界

失败候选记录来源、阶段、安全错误码、可得的 HTTP 状态和请求编号；选中来源可见。
全部失败时非零退出，前面的日志保留各候选原因；不记录 token、broker secret 或原始
响应正文。正常原生命令 stderr 保留。下一条独立命令重新开始优先级，不要求 agent 无限重试。

本次不解决其他 Stop hook 完成条件、MCP daemon 可用性或云后端故障。
已有会话需要刷新宿主配置，旧自定义 remote 需要迁移到标准 URL。

## 证据

实现位于 CLI 的 github-credential-runtime.ts、github-git-transport.ts、gh-shim-script.ts、
token broker/manager 与会话准备逻辑。测试覆盖优先级、服务故障、owner 上下文、
gh 写入不重放、checkout 凭据和 broker 失败时的真实 Git 递归克隆。
尚未验证生产 GitHub 和 Windows 端到端链路。
