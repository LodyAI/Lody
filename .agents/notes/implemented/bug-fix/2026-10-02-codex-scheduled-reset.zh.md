# Codex 已安排重置兼容修复

Status: implemented
Translation: current

[English](2026-10-02-codex-scheduled-reset.md)

## 摘要

重置面板只解析 `active_watch`，因此漏掉了已安排的重置公告。
公开状态接口现在独立返回 `scheduled_reset`，即使没有活跃预测也可能有公告。
解析层、两个入口和弹窗现已支持独立公告，不为其虚构概率。
到达计划时间不代表已经执行；公告保持可见，直到接口移除它。

## 证据与决策

2026-10-02 检查[公开 schema](https://codex-resets.com/api/openapi.json) 和
[状态接口](https://codex-resets.com/api/v1/status)，其 `active_watch` 为 null，
但另有计划时间 `2026-10-02T17:00:00Z`，对应北京时间 10 月 3 日 01:00。
Schema 允许计划时间为 null，也允许观察来源不带 URL。解析器兼容这些格式，
检查来源链接，并将公告与预测、最近已执行重置分开。
复用预测概率和过期逻辑会歪曲公告含义，因此优先展示公告，时间文案使用“计划”，
不承诺必定完成。请求、缓存和 Provider 准入逻辑保持不变。

## 验证

合成解析与弹窗用例覆盖公告缺失、空或无效时间、来源格式、显示优先级及到达计划时间。
Storybook 包含未来、等待执行确认和时间未定状态。
当前工作树缺少依赖，测试运行受限；尚未进行真实界面验证。
使用本机已有 Zod/TypeScript 的独立解析检查通过了合成案例与在线返回；
修改的 TypeScript 文件通过语法诊断和 Oxfmt。这不能替代工作区类型检查或 React 测试。
文档检查报告了指向未初始化 ACP 子模块的既有断链，没有涉及本次改动。
