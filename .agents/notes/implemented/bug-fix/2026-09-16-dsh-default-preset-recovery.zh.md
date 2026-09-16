# 恢复失效的 DSH 默认 preset

Status: implemented
Translation: current

[English](2026-09-16-dsh-default-preset-recovery.md)

## 摘要

Harness 用户设置中的默认 preset 可能不在 Lody 随包提供的目录中，导致发送提示词
前创建 ACP 会话就失败。适配器现在保留可用默认值，将失效默认值恢复为可用的
`standard`，报告实际选择并记录警告。不改写设置，也不任意选择其他组合。
如果标准 preset 自身不可用，仍需要修复；本变更不承诺恢复损坏的运行时安装。

## 决策与证据

本变更扩展了[设置提供者集成](2026-09-08-dsh-settings-provider.zh.md)。Harness
0.1.5-rc.2 优先读取用户设置默认值，其次使用组合默认值；适配器此前会在
`session/new` 拒绝不存在的 `code`。未取得报告故障机器的配置，无法确认该机器
`code` 的确切来源。合成设置复现了这条配置故障路径。

恢复由掌握实际可用目录的 provider 适配器负责，在创建 Agent 和挂载 MCP 服务前
完成。实际选择传入 Agent 元数据及挂载调用，并通过 ACP 配置选项返回。
有效自定义默认值和显式选择校验保持原语义，不改变权限配置。改写用户设置会影响
其他 Harness profile；选择目录首项可能启动无关自定义组合，因此均未采用。

## 验证与限制

扩展构建及全部 25 项单元测试通过。6 项真实 Harness 设置冒烟测试通过，包括
`default: code` 在首次及后续创建会话时的恢复、保留有效 `minimal` 默认值、拒绝
显式无效 preset，以及设置文件字节不变。单元测试还覆盖损坏默认值、有效自定义
默认值，以及恢复目标缺失或损坏时在创建 Agent 前失败。冒烟启动器显式调用
`runCli()`，与宿主在缺少 `import.meta.main` 的 Node 版本上的启动方式一致。
测试没有发送模型请求或使用真实用户会话。

[设置规范](../../../../specs/deepseek-harness-settings.zh.md) 保持草案状态。
宿主固定 DSH 提交 `feb3afe`，已发布于
[DSH PR #20](https://github.com/LodyAI/acp-extension-dsh/pull/20)。应先合并适配器变更，
再合并宿主集成；两个 PR 都不会直接部署到运行中的客户端。
宿主集成：[Lody PR #748](https://github.com/LodyAI/Lody/pull/748)。
根检出缺少工作区依赖及其他子模块，根检查受限；未构建或安装桌面发布版。
根 `pnpm check` 因缺少 `tsgo` 停止，`pnpm format` 因缺少 `oxfmt` 停止，文档
检查报告指向未初始化子模块的断链。子模块默认 Prettier 检查同样不接受未修改
基线的格式；保留了无关格式。两个仓库的 diff 空白检查均通过。
