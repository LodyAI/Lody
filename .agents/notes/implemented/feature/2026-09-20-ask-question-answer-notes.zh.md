# 将 Ask Question 备注与替代答案分开

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/837

[English](2026-09-20-ask-question-answer-notes.md)

## 摘要

Lody 已将 ACP 表单桥接到持久化的权限问题，但会丢失 Core 回答备注。
现有桥接现在校验显式备注关联，在卡片中保留独立草稿，并通过答案与历史保存两个字段。
沿用现有链路避免引入第二套存储或响应协议，同时保留旧替代答案语义。
客户端仅在会话问题链路协商备注能力；独立运行的旧 renderer 不属于此次升级保证。

## 决策与证据

已锁定的 Core 提交 `bb9632c929dfdbfb650619e3719a11be1808d4d1` 已包含
0.1.6，npm 上也已核实该版本，无需修改依赖或锁文件。
[Codex PR #47](https://github.com/LodyAI/acp-extension-codex/pull/47) 于
2026-09-18 合并，merge commit 为 `a0f1c78f5ca324881805e0c355102952394e9fbc`，
head 为 `214723488b4bd5e9ffcb0c2266fd3c9bfb2434ea`。已锁定的 Codex 子模块
包含该合并。AIR 和 provider 原生答案转换不在本次范围。

通过 schema key 而非后缀约定关联备注。无效引用直接拒绝，不将其当作独立题目，
也不覆盖其他答案。展示前再次校验规范化的历史元数据。逐题显式保存是否允许替代
答案，避免另一道自由文本题让纯选项题意外开启替代答案模式。

现有权限响应与 HistoryWriter 承载 Core 保持不变的 `string | string[]` 答案 map，
备注自身只接受非空字符串。复用链路避免平行持久化；重新解释 `customAnswerFor`
会破坏旧记录，也违反 Core 契约。只读卡片分别遮蔽秘密备注和自由文本答案。
带备注的问题选中后不再自动跳页。

本决策补充[单一历史写入者决策](../architecture/2026-09-07-single-history-writer.zh.md)，
不改变存储所有权。产品意图见 [Spec 草稿](../../../../specs/ask-question-answer-notes.zh.md)。

## 验证与限制

行为测试覆盖共享解析、无效关联、后缀冲突、替代答案、取消、HistoryWriter 快照重开、
真实 React 编辑、只读秘密遮蔽、CLI 桥接和初始化。专属 stories 使用生产组件，
其中只读 fixture 也通过组件测试渲染。`pnpm check`、格式检查和文档检查通过。
专项测试通过共享层 47 项、组件 15 项、CLI 60 项。CLI 在 2 GiB 堆限制下构建通过，
Electron 应用使用默认堆配置构建通过。Storybook 已启动并索引全部 5 个故事。
图形化桌面及移动端验收仍未完成：可用 UI 连接没有浏览器，且无法获取 Chrome 窗口。
不发布 npm 包或合并分支。
