# 官方 Effect 技能与版本一致的参考资料

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1410

[English](2026-10-11-effect-reference-skills.md)

## 摘要

Agent 需要与 Lody 依赖版本一致的 Effect 资料。仓库已安装两个官方技能，并补充保留锁定版本与行为验收的规则。Effect 4.0.2 发布包已有指南、示例与实现源码，因此不建议仅为参考用途引入源码 subtree。本次没有加入 subtree；需要上游测试或迁移指南时，可按明确的发布 tag/commit 临时获取。

## 证据与职责

- `pnpm-workspace.yaml` 将 Effect 与测试辅助包锁定为 4.0.2。本工作区没有安装依赖，因此在临时目录检查公开 npm 发布包，没有修改依赖声明。
- 发布包包含 `AGENTS.md`、`ai-docs` 与 `src`；检查时源码约 20 MiB，示例约 356 KiB。指南链接覆盖服务、Layer、资源、测试和现有应用接入。
- 技能来自[官方仓库的固定提交](https://github.com/Effect-TS/skills/tree/155c50c911f9c99c294ef8a4461981c5bbe6453e)。上游初始化要求 latest，迁移将测试视为可选；本地规则保留 catalog，并要求相关行为测试。
- 根指令要求读取消费包实际依赖的指南。技能正文位于 `.agents/skills`，Claude 入口使用软链接。[技能 README](../../../skills/README.md)记录来源与本地调整；[现有 Effect 指南](../../../docs/cli-effect-ts.md)解释 Lody 的行为要求。

## 方案与建议

Subtree 可在安装依赖前提供资料，也可包含 npm 包没有的上游测试和迁移数据。代价是增加第二份源码版本、第三方跟踪文件，以及手动更新和审核工作。固定 subtree 版本仍要求每次依赖升级同步更新；跟随 main 则容易参考当前依赖没有的 API。本次没有发现必须长期跟踪第二份源码的持续缺口。

日常工作优先使用已安装依赖。排查上游实现或迁移 v3 时，按需在临时、不受版本跟踪的 checkout 获取资料，固定目标发布 tag/commit，并对照实际依赖确认签名。如果后续反复需要上游测试或无需安装即可查阅的资料，且有人负责版本同步，再考虑 subtree。

## 后续引导修订

[纲领修订](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.zh.md#迁移引导与进度)将通用 effect-ts 入口调整为先明确合同的 Lody 生命周期工作流，替换相冲突的上游安装步骤，保留来源与 MIT 许可。明确限定用途的 v3-to-v4 skill 和版本一致参考策略不变。职责拆分仅供大型混合模块选择，普通小型迁移不要求固定文件布局。

[#1452](https://github.com/LodyAI/Lody/pull/1452) 的后续调整先区分任务模式，再规划迁移；当前上下文中每个解析版本的指南完整阅读一次。Owning 指南定义五个按适用性回答的行为问题；纲领区分交付状态与验证证据，并记录合成引导评估场景。这样避免 review/debug 重复执行完整迁移流程，同时保留实现阶段的生命周期验收。

事实修正：v4.0.2 的 `src/internal/effect.ts` 通过 `causeSquash` 实现 `runPromise` rejection，单一类型化失败已经是原始错误，不是 `FiberFailure` 包装。需要在领域投影前检查完整 Cause 时，仍使用 `runPromiseExit`；普通 squash 可能丢失组合失败与恢复所有权。`Stream.runCollect`/`runDrain` 返回 Effect，是组合算子，不是 runtime 执行入口。

## 验证边界

本次只修改指令与技能，没有改变依赖和运行时代码。发布包检查只证明参考资料存在，不证明 Lody 的关闭、取消、同步行为，也未测量 agent 使用效果。文档改动未运行 Lody 行为测试。针对精确的 npm 4.0.2 参考包，五个临时确定性实验在 Node 22.22.0 上通过：单一失败投影、惰性 Promise 重试、忽略 abort 的 Promise 在等待中断后仍能迟到写入、协作取消、ManagedRuntime 共享与释放顺序。实验使用显式信号而非 sleep，只证明上游语义，不证明这个未安装依赖的工作区中的集成行为。#1452 后续调整重新运行了这些实验，skill 元数据验证也通过。合成 prompt 场景记录了预期结果，尚未进行独立效果评估。文档检查与安装检查分别报告，不等同于运行时验收。
