# 挂载 DSH 文件设置 provider

Status: implemented
Translation: current

[English](2026-09-08-dsh-settings-provider.md)

## 摘要

Lody 的 DeepSeek ACP composition 安装了抽象的 settings 接口，却从未挂载文件 provider，因此对
Harness 用户设置的修改不会影响其本地模型目录。该扩展现在挂载上游的 `dsh-settings-file`，并把它
固定到与运行时闭包其余部分相同的 Harness 版本。profile 修订变化会使旧的能力快照与生成的 composition
身份失效。ACP 入口声明依赖 `settings`，从而避免其首个请求在 provider 读完文件之前就缓存了默认值。
由 endpoint 驱动的目录发现保持不变；本地设置不会往显式 endpoint 的 `/models` 列表中添加模型。

## 决策与归属

采用上游的文件 provider，而不是在 Lody 中实现第二套设置解析器或硬编码一份临时模型目录。provider
拥有路径解析、校验、监听与持久化；LLM 插件拥有命名空间语义。扩展拥有 composition 及其精确的包闭包，
Lody 则保留启动监管、隔离的 npx 缓存与能力刷新。

provider 读取 `$DSH_HOME/settings.yaml`，默认为 `~/.dsh/settings.yaml`。文件缺失时保留默认值；
文档格式错误会导致启动失败。用户的模型数组会整体替换本地目录。provider 会监听变更，但 ACP 的模型
选择按连接缓存，因此用户需要刷新能力并重新连接。任何用户设置或凭据都不会被复制进生成的 Cordis 文件。

## 范围与替代方案

本次只实现「provider 缺失」这一修复。把显式配置的模型 ID 与 endpoint 发现结合起来的工作被推迟：
不加区分地把本地默认值并集进去，会在任意兼容 endpoint 上广播不合适的模型。对生成配置的手工编辑不
具持久性，因为宿主会重新生成它。自定义 ACP composition 仍是一个独立的绕行方案。

## 证据与验证

- [设置契约草案](../../../../specs/deepseek-harness-settings.md)
- [扩展 profile](../../../../packages/acp-extension-dsh/src/profile.ts)
- [profile 回归测试](../../../../packages/acp-extension-dsh/src/profile.test.ts)
- [宿主启动文档](../../../../apps/cli/src/agent/README.md)

扩展构建与 11 个单元测试通过。一次真实运行时的 ACP 冒烟测试检查了首个请求的自定义目录可见性、
设置缺失、YAML 格式错误、非映射文档，以及设置文件的字节保真。其预装运行时包含 107 个 DSH 包，
全部为 `0.1.1-rc.2`。初始化所需 submodule 之后，公开边界校验通过。

运行时探测还暴露了一个本次修复之外的上游限制：一份合法的 YAML 文档若其 `llm-deepseek` 段落不符合
schema，可能保留 composition 默认值而非终止。本次改动把命名空间校验委托给上游；文档解析失败另行
测试。请勿把该 provider 集成描述为修复了每个插件的非法配置行为。

提交前曾尝试 `pnpm check` 与 `pnpm format` 但无法完成：该 checkout 缺少完整的工作区依赖（Claude
adapter 类型检查与工作区 Prettier 解析失败）。扩展构建、单元/运行时测试、格式化、文档检查与公开
边界检查均通过。

## 集成

- [Lody 集成 PR](https://github.com/LodyAI/Lody/pull/515)

DSH 的修复基于其当前 main，保留了已合入的独立 Plan Mode 支持。因此 Lody 也把 `acp-extension-core`
推进到 DSH 0.1.2 所要求的、已合入的 0.1.1 契约。既有的工作区 override 让 Core 保持本地链接，因此
这不改变任何 lockfile 解析结果。

- [已合入的 DSH 设置 PR](https://github.com/LodyAI/acp-extension-dsh/pull/13)
- [DSH 设置提交](https://github.com/LodyAI/acp-extension-dsh/commit/5d79d5b7c16c14d5ae9b69c69bf3b57c21d0610c)
- [上游 DSH Plan Mode](https://github.com/LodyAI/acp-extension-dsh/pull/12)
- [上游 Core Plan Mode](https://github.com/LodyAI/acp-extension-core/pull/5)

源码集成不会升级已在运行的桌面端或 daemon。

DSH #13 合入后，宿主的固定版本更新到其 squash 提交 `5d79d5b`，其代码树与此前测试过的实现提交一致。
与 Lody main 的同步无需解决冲突，因为 main 本就是其祖先。

PR #515 的完整 Static checks 日志与检查注解指出了一个 lint 错误：设置冒烟脚本没有 await `test()`
返回的 Promise。[DSH CI 修复](https://github.com/LodyAI/acp-extension-dsh/pull/14) 补上了该 await；
宿主现在固定到 `38e7ee2`。构建、11 个单元测试、四个运行时冒烟测试与扩展格式化均通过。本地完整的
`pnpm check` 与 `pnpm format` 仍因缺少工作区依赖而受阻；在该不完整 checkout 中，限定范围的 lint
无法复现原始的类型感知诊断。GitHub CI 负责在完整依赖环境中验证。
