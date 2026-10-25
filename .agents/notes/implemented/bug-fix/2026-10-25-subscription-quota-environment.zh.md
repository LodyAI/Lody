# 普通环境变量下的订阅额度

Status: implemented
Translation: current

[English](2026-10-25-subscription-quota-environment.md)

## 摘要

内置 Codex、Claude、Grok Provider 只要配置了任何环境变量，就会失去订阅额度展示和主动刷新，
即使该变量只是与模型账号无关的工具凭据。共享纯函数现在允许普通环境设置，继续排除认证、
配置和 Provider 路由覆盖。前端和 daemon 使用同一个独立模块。账号隔离和刷新生命周期不变；
验证没有使用真实订阅账号。

## 策略与证据

`packages/shared/src/subscription-quota.ts` 负责账号资格判断。能力声明仍是独立条件：
展示要求 version 1，刷新要求 `query: true`。读取仍精确匹配 Provider id。
本次替换[额度刷新决策](../architecture/2026-10-13-provider-quota-refresh.zh.md)中的 env 全量排除，
保持 [Provider 隔离](2026-09-30-provider-rate-limit-isolation.zh.md)。

- Claude adapter `c06641c` 调用 `getUsage()`，从 Keychain 或 home 凭据文件读取原生 OAuth，
  独立于 SDK 的认证配置。复用共享 Claude 认证／路由键，并排除锁定 SDK 中的其他 OAuth／配置
  入口。工具变量和模型调优变量本身不代表另一个账号。
- Codex adapter `df464ab` 委托原生 `account/rateLimits/read`。入口接受 `CODEX_CONFIG`、
  `MODEL_PROVIDER`、`DEFAULT_AUTH_REQUEST`；API 凭据、home 和身份覆盖仍被排除。
  托管 ChatGPT profile 可以携带普通工具变量，已有 profile 校验继续拒绝身份覆盖。
  API-key profile 仍不适用。
- Grok adapter `2fc653b` 委托原生 `x.ai/billing`。官方包 `@xai-official/grok@1.0.46`
  记录了 `XAI_API_KEY`；Lody 的 Magpie 启动器通过 `GROK_HOME`、`GROK_CONFIG` 和模型选择
  变量切换自定义路由。这些入口仍被排除，显式品牌和 Magpie gateway 同样排除。

规则只检查配置键名，不记录值，并为 Windows 做大小写不敏感匹配。空账号覆盖仍排除，
因为清空继承凭据也可能改变账号选择。通用 home／配置发现及代码加载覆盖仍被排除。
这是一项配置策略，不是运行时账号证明：不检查继承的进程环境或原生配置文件。
自定义／registry adapter 保留原有按能力声明处理的语义；其他内置 agent 在各自源码核对前
保留原有 env 策略。

## 范围与验证

纯函数无需 Effect service 或迁移。查询合并、配置／revision 检查、进程清理和缓存保留
仍由已有刷新流程负责。不改变 adapter 版本、协议／存储格式、凭据或用户数据。

测试覆盖普通变量、账号／路由覆盖、空值和 Windows 大小写、托管 profile 校验、渲染出的
Provider 专属百分比，以及 daemon 查询发布。既有失败／推送／删除用例和新增配置变化用例
验证旧额度保留。shared 定向套件通过 41 项，组件套件通过 33 项，完整 execution-service
套件通过 315 项。shared、components、CLI 类型检查及公共边界检查通过。文档检查仍报告
未初始化 Kimi/Pi 子模块中的六处既有链接缺失，修改的文档无错误。真实账号及平台验收仍未验证。

完整 `pnpm check` 通过全仓类型检查、lint 和 Effect lint，随后停在未改动的 CLI Git/worktree
套件（5 项失败、4621 项通过、4 项跳过）：涉及 macOS 临时路径拼写、固定 submodule 身份、
超时和宿主 Git 凭据上下文。组件全部 6069 项通过。后续根检查未执行；`pnpm format` 通过。
本次额度修复未处理这些失败。
