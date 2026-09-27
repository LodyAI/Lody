# GitHub 命令凭据

Status: draft
Translation: current

[English](github-command-credentials.md)

Agent 切换目录、使用 `gh -R` 指定其他仓库或访问子模块时，凭据应属于本次命令的目标仓库，
而不是会话启动时的项目。Installation token 仍只授权单个仓库。

凭据选择属于当前请求者。开启个人身份时先尝试个人凭据；失效时先刷新，再考虑降级。
机器主人可以接着尝试机器本地凭据，其他成员不可以；最后才使用工作区 GitHub App。
未开启个人身份时跳过第一步。

执行命令前只做只读权限检查。确认没有凭据或没有仓库权限时，可以尝试下一身份；
网络故障、普通 403、限流和分支规则不是切换身份的理由。不重放结果不确定的写操作。
降级时说明使用的身份，但不输出秘密。

Helper 不得把托管 token 存入本地凭据存储。恢复只能使用工作区专属 broker；
broker 上下文绑定当前请求者，不能把继承的环境变量当作机器主人证明。
这不是同一操作系统账号下的进程安全隔离。

GitHub HTTPS 和标准 GitHub SSH 地址统一按实际 remote 选择凭据，包括递归子模块。
保留本地 SSH 命令配置和 443 端口。未知 Git 命令保守地检查写权限。
自定义 SSH 主机别名、URL 内嵌凭据、绕过托管 shell 路径的命令不在此约定内。
网络命令会明确拒绝冲突的 GitHub `insteadOf` / `pushInsteadOf` 配置，不能绕过身份选择。
这不是通用的凭据防火墙。没有适用凭据时，公开仓库可以使用已验证的匿名读取；
写操作绝不会降级为匿名访问。

长期运行的 Agent 每次启动 helper 时读取会话上下文文件；切换请求者会轮换 token，
无需重启 Agent。单个 helper 固定使用一次上下文，不能混合两个请求者的权限。
切换后才启动的后台命令使用当时的请求者，而不是最初安排该命令的 turn 身份。

## 依据与验证

实现位于 CLI 的 `github-credential-runtime.ts`、`gh-shim-script.ts`、
`git-credential-helper-script.ts` 和会话凭据准备逻辑。
确定性测试覆盖优先级、目标仓库、上下文轮换、重定向、继承 HTTP header 和 SSH 参数。
原生 Git fixture 验证 receive-pack advertisement 不修改 refs，以及递归子模块克隆经过生成的 transport。
尚未宣称真实 GitHub 端到端验证；托管端授权和仓库生命周期不属于公开客户端的实现边界。
