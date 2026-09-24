# 提高异步委派链上限

Status: implemented
Translation: current

[English](2026-09-08-raise-async-chain-depth.md)

## 摘要

MCP 异步委派保护在因果链达到五次跳转后拒绝命令，使更深的委派工作无法在
创建 Operation 或目标 Session 前启动。现在共享上限改为 32，可执行
Operation 模型和 Review Automation 说明也使用同一数值。边界仍保持固定且
不可重试，因此只是扩大可用委派深度，没有移除递归保护。

## 决定与范围

- 在共享编排契约中将 `LODY_MAX_CHAIN_DEPTH` 设为 32。
- 用共享常量替换模型中的硬编码检查，并更新上限回归断言。
- 保持 `parentSessionId` 规则和机器侧 Review Automation 的归属不变；本次只
  修改异步因果跳转上限。
- 在待人工审核的会话编排 Spec 中记录新行为。

## 证据与限制

已用 `rg` 和 `git diff --check` 检查源码与模型变更。尝试运行定向 Vitest，
但当前工作树没有安装 `node_modules`，因此找不到 `vitest` 可执行文件。
已发布客户端和长链运行时验收仍待补充。
