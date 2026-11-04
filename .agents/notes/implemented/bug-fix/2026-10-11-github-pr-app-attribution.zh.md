# 创建 PR 时保留 GitHub App 归属

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1475

[English](2026-10-11-github-pr-app-attribution.md)

## 摘要

原生 `gh pr create` 使用 GraphQL；实际对照发现，即使 GitHub App 用户令牌正确地让 PR 归属用户，该路径仍丢失 App 来源。同样的授权和提交通过 REST 创建时保留了 App 来源。受管理的代理现在对显式非交互创建使用 REST，再以同一凭据设置元数据。无法安全转换的原生命令模式仍可使用，并提示其 App 归属限制。

## 决策与边界

`gh-shim-script.ts` 保留原有凭据与目标选择，在解析参数时记录选项，不重新扫描选项值。嵌入的 `gh-pr-create-script.ts` 将标题、正文或正文文件（含标准输入）、head、base、草稿与维护者编辑权限转成原生 `gh api` REST 字段。标签、负责人、审阅者、里程碑和项目随后通过同一环境执行原生 `gh pr edit`。字符串使用 raw field，保留 Markdown 字面值，避免文件及占位符展开。

缺少 head 时，仅在当前分支本地 SHA 与目标仓库远端 ref 一致时推导；缺少 base 时，读取当前分支的 `gh-merge-base` 配置或仓库默认分支。自动推送或 fork、fill、编辑器、浏览器、模板、恢复和附件流程保留原生命令，避免重新实现 GitHub CLI 全部工作流或破坏既有脚本。显式传入标题、正文、base 和已推送的 head 可以确定选用 REST。本机原生凭据与无需凭据的帮助命令不变。

一旦开始创建，任何失败都停止，不回退身份或重放，包括明确拒绝以及成功响应丢失或异常。先输出 PR URL，再设置可选元数据；元数据失败必须提示编辑已经创建的 PR，不能再次创建。这调整了[有序降级](../architecture/2026-10-03-github-identity-fallback.zh.md)的原生执行部分，保留复合写入不重放边界，不改变 commit 作者身份。

GitHub 的 `/pulls/{number}` 响应不含 `performed_via_github_app`，应查询对应 `/issues/{number}`。App 用户令牌保留用户作者身份；installation token 归属 App bot。界面文案仍由 GitHub 决定。

## 验证与限制

生成代理的测试覆盖字面字符串与布尔字段、正文文件和标准输入、继承的仓库参数、默认值、原生兼容、同身份元数据、dry-run/help，以及拒绝、结果不明和部分完成的写入。56 个 shim/runtime/broker 测试、CLI 类型检查、生产打包与格式检查通过。清除继承的托管 Git 环境后，独立的原生 Git transport 测试也通过。更广的预览测试因验证机器无法绑定 IPv6 `::1` 而失败（`EAFNOSUPPORT`），不能据此声称完整测试全绿。最初 REST 与 GraphQL 的实际对照证明接口选择，不代表本补丁已经部署。此变更没有实际验证 Windows 或原生交互流程。

已评估 Effect 迁移：这里是无运行时包依赖的独立 Node 脚本源码。引入 Effect 会改变 helper 打包边界，不能解决接口归属问题，因此保留现有轻量进程边界。
