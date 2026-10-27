# DSH Provider 插件管理

Status: implemented
Translation: current

[English](2026-10-26-dsh-plugin-management.md)

## 摘要

Lody 之前在启动时覆盖 DSH profile 清单，丢失原生 CLI 安装的依赖，后续包管理操作
可能进一步删除这些包。启动现在保留用户依赖和配置。插件管理改为本机终端命令
`lody dsh plugin … --agent-config <id>`，绑定 Provider 的 home 和原生 profile。
不提供插件列表或管理 UI，也不通过工作区 RPC 开放安装能力。

## 决策与边界

[PR #1932](https://github.com/LodyAI/Lody/pull/1932) 的最终范围以原生 CLI 薄封装
替代尚未合入的 UI/RPC 实现。用户选择沿用原生包管理行为，不维护另一套 Lody
插件目录。Skill 不在本次范围内。

- 本机 daemon 只返回当前机器内置 DeepSeek Provider 的 id/name，跨活跃工作区去重。
  不查询云目录，不返回保存的 Provider 环境变量。未传 id 时在交互终端询问；
  非交互环境必须指定 `--agent-config`。未知或非本机 id 直接失败。
- CLI 使用固定版本 DSH 和 pnpm，设置 Provider 的 `DSH_HOME`，执行
  `plugin --profile lody-acp`。保留原生参数顺序、调用目录和终端输入输出。
  Registry、本地路径及 Git 来源由 DSH/包管理器解释；禁止覆盖已绑定的 profile。
- 子进程继承调用终端环境，支持包 registry 和 Git 认证配置，但不读取保存的
  Provider 凭证。这是显式本地执行，不是远程可调用的安装服务。
- 启动只协调生成的 base/host bundle 和启动时 patch 加载方式。保留用户依赖、
  未知清单字段、用户 bundle、pnpm workspace 配置、锁文件和 YAML patch。
  最终 host guard 继续保证 ACP、历史目录及禁用遥测。

## 所有权与失败恢复

命令使用共享 Effect 进程 Scope 管理安装进程，持有与启动相同的 Provider-home
文件锁，直到子进程结束或取消清理确认完成。SIGINT/SIGTERM 取消该操作，正常
完成保留原生退出码。不同 Provider 之间独立。继续使用现有 Promise launcher
与 file-lock Legacy 应用边界，不声称迁移 daemon/session 编排。

包操作失败由 DSH 恢复。Lody 不会仅回滚清单和锁文件，却保留已经变更的
`node_modules`，以免制造不一致。原生日志和退出状态可见。现有会话需重新连接
才能加载变更；UI 不扫描或显示已安装插件。直接调用外部 `dsh plugin` 不持有
Lody 的锁，应在 Lody 停止后执行。

## 验证范围

行为测试覆盖参数转交、Provider 选择、本机协议校验、机器/类型过滤与不含凭证的
查询、原生子进程目录/环境/home/退出码，以及启动时的配置保留。
测试不下载或执行第三方插件。Windows 打包安装及真实 registry/Git 认证不在
本次验证范围内。

仓库完整检查未全绿：未修改的 `github-git-transport.test.ts` 递归 SSH 子模块测试
遇到本机 Git shim 的 `context_unreadable`。CLI 与组件类型检查通过。
