# 协商 Provider 标题生成能力

Status: implemented
Translation: current

[English](2026-09-24-acp-session-title-capability.md)

## 摘要

过去标题归属依赖内置 Provider 名单，自定义 Provider 无法避免重复标题进程。
Core 现在定义版本化 sessionTitle 能力，Lody 根据主 Session 的实时初始化结果决定
是否启动后备生成器。带 generated 标签的标题进入既有清理和条件写入路径，保留用户命名。
旧版内置行为保持兼容；Provider 生成失败时保留草稿标题。

本变更部分替代[早期记录](../architecture/2026-09-08-acp-owned-session-titles.zh.md)
中的纯身份判断；当前意图见[草稿契约](../../../../specs/acp-session-titles.zh.md)。
ACP 已有标题更新回调，因此无需新 RPC。将判断移动到初始化之后，避免依赖缺失或
陈旧缓存。缓存 v9 将支持标志贯穿探测、Session 启动、Flock 比较及设置页面；旧缓存
已知字段继续可读。明确的 fallback 标签优先于旧版无标签信任规则。
Claude、Codex、Grok 的适配器源码现已声明该能力。Claude 区分生成结果、已保存的自定义
名称和摘要兜底；来源变化时，即使文本相同也重新推送。Codex 保留原生名称的 explicit
标签。Grok 为官方运行时的无标签名称补 explicit，保留已有标签。Grok 协议无法区分
未标注的兜底文本与真实名称，因此沿用既有信任边界，并未证明生成来源。
未修改适配器发布版本和托管运行时固定版本；源码发布前，已安装旧运行时继续使用兼容路径。

验证覆盖能力解析与版本拒绝、原生和旧版标题路由、有无能力的主 Session 启动、
缓存变更及设置页面。适配器检查通过：Claude 标题/Agent 测试（10 项原有跳过）、
Codex 初始化/事件测试、Grok 代理/运行时测试，以及 Claude 构建与 lint、Codex 类型
检查和 Grok 语法构建。通过 run-codex 技能执行的最小真实请求以 end_turn 完成，
验证了启动和回合流程，但未验证异步生成标题通知；未执行真实 Claude/Grok 标题生成。

提交前完整 `pnpm check`、`pnpm format` 和文档检查通过。

Core 0.1.7 已发布。Claude、Codex、Grok 已固定依赖该版本，两个 npm 锁文件记录对应发布包的完整性摘要。Lody 固定 Core 发布提交并保留 workspace 覆盖；已核对 npm 发布包源码与该提交一致。

## 配套 PR

- [Core #13](https://github.com/LodyAI/acp-extension-core/pull/13)
- [Claude #33](https://github.com/LodyAI/acp-extension-claude/pull/33)
- [Codex #53](https://github.com/LodyAI/acp-extension-codex/pull/53)
- [Grok #19](https://github.com/LodyAI/acp-extension-grok/pull/19)
