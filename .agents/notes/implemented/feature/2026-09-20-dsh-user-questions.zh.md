# 通过 ACP 桥接 Harness 用户提问

Status: implemented
Translation: current

[English](2026-09-20-dsh-user-questions.md)

PR: [Lody #840](https://github.com/LodyAI/Lody/pull/840)

Provider PR: [acp-extension-dsh #21](https://github.com/LodyAI/acp-extension-dsh/pull/21)

## 摘要

Harness preset 已提供 `ask_user_question`，但 ACP adapter 没有 answerer，调用会以
`NO_PROVIDER` 失败。adapter 现注册 Agent 作用域的 answerer，通过标准 ACP 表单
复用 Lody 已有 Ask Question 流程。Core answer notes 保留多选与 custom 文本，无需
修改 host 生产代码或共享契约。取消会释放工具等待，但 SDK 1.3 无法单独撤回已发送
的表单。

## 决策

[Core 契约](../../../../packages/acp-extension-core/README.md) 将提问归于
`elicitation/create`。Codex 的 `CodexElicitationHandler` 提供了能力协商、显式字段
关联和原生答案转换的参考；其传输实现不同，因此 DSH 使用已固定 SDK 的
`AgentSideConnection.unstable_createElicitation`。

```text
Harness 工具 → userQuestions.ask（live/root 校验）
             → Agent 作用域 answerer → session 独立队列
             → ACP 表单 → 现有 Lody 问题卡片
             ← 原生答案 ← 校验后的 ACP content
```

生成的位置 key 避免与原生 id 冲突。单选 Other 使用 `customAnswerFor`；多选仅在
协商 Core answer notes 后使用 `noteFor`。显式且无冲突的 Other 选项允许仅输入
custom。没有 notes 能力时保留替换式 Other。adapter 恢复原生 id，且仅从答案中
移除自己生成的选项。Plan-review 详情并入问题正文，批准仍由显式标签表达，不自动
切换 Plan 或权限。

原生 `userQuestions.ask` 继续负责 `CALLER_NOT_LIVE` 和 `DELEGATED_CALLER`。
作用域注册加精确 ACP 所有权校验防止问题串 session。取消排队项不会越过当前请求；
abort、session cancel/close 和连接断开均释放工具等待。非法回复、拒绝和传输失败
不会被转换成成功的空答案。

Core 0.1.6 已发布，因此仅提升 DSH 的依赖。根 lockfile 已将 Core 覆盖为
`workspace:*`，解析后的 importer 无变化。Profile revision v13 使生成配置和探测
缓存身份失效。新增子模块自身的 Prettier 配置，保留现有风格，不依赖上层仓库配置。
删除了仅断言 revision 字面量、无法检验行为的旧测试。

## 验证与限制

- DSH build 与 34 个单元测试通过，覆盖真实 SDK 传输、多问题、custom、非法答案、
  队列取消和失败恢复。
- 可选原生 smoke 使用固定版本的真实 Harness 工具、service 和 Cordis 作用域分发，
  Agent/catalog 边界为合成测试实现。无需模型或网络调用即可验证答案返回、双 session
  路由、live/root 拒绝、取消、拒绝和已有 approval waterfall。
- 直接验证实际生成的表单经过 Lody 共享 parser、permission outcome builder 和
  response builder 后仍保留多选/custom。
- 现有完整 profile settings smoke 四项在 Node 24.15 下通过；Node 22.20 下 launcher
  在 ACP 初始化前退出。尚未诊断该启动差异，本次未包含运行时修复。
- DSH `format:check` 通过。已尝试根 `pnpm check`、`pnpm format`，当前 checkout
  缺少 `esbuild`、`oxfmt` 等依赖，无法完成。
- 初始化检查所引用的子模块后，根文档检查与公开边界检查通过；没有已注册的
  SHA 保护文档主题。

SDK 1.3 的旧连接 API 不提供单请求取消。迟到回复会被忽略，但独立工具 abort 后
卡片可能保留到 host 关闭或整轮取消。未执行真实桌面/模型交互。参见
[draft Spec](../../../../specs/deepseek-harness-user-questions.zh.md) 和既有
[答案备注决策](2026-09-20-ask-question-answer-notes.zh.md)。
