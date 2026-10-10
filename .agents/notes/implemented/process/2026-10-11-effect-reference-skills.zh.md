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

## 验证边界

本次只修改指令与技能，没有改变依赖和运行时代码。发布包检查只证明参考资料存在，不证明 Lody 的关闭、取消、同步行为，也未测量 agent 使用效果。文档改动未运行行为测试；文档检查与安装检查分别报告，不等同于运行时验收。
