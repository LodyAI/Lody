# Nowledge Mem 健康状态兼容

Status: implemented
Translation: current

[English](2026-10-25-nowledge-health-status.md)

## 摘要

Lody 将顶层状态为 `healthy` 的成功响应判成不可用，阻断身份列表、创建和更新。
适配器现在仅在命令成功退出时接受 `ok` 与 `healthy`。成功的空列表仍返回 `ready`，
失败的探测不能授权身份修改。远端服务行为的证据来自
[#1871](https://github.com/LodyAI/Lody/issues/1871)，本工作树未做远端端到端验证。

## 决策与证据

保留[原 Provider 边界](../feature/2026-10-04-agent-role-memory.md)，仅修改健康状态比较；
找不到可执行文件、无效 JSON 和非零退出码的分类不变。
[草案 Spec](../../../../specs/agent-role-memory.zh.md) 同步纠正仅接受 `ok` 的过窄描述。
本机 nmem 0.10.107 返回顶层 `ok`，嵌套 graph-store 的 `healthy` 不参与 Provider
健康判断。插件安装检查是独立事项。

本次修改纯响应分类，不改变进程所有权或取消行为。已评估并暂缓原生 Effect 迁移：
迁移 Promise 适配器及消费者不能改善这次兼容修复，现有进程和 login-shell 的
Legacy 边界保持不变。

## 验证

适配器原有测试套件补充两种健康状态的空列表、创建、更新，以及非零退出码不修改身份的覆盖。
使用 Vitest 5.0.2 和 Zod 4.3.6 的临时隔离环境执行真实适配器、请求 Schema 和原有套件，
未使用的进程导入替换为抛错保护，11 项测试全部通过。相同套件测试修复前适配器时，
`healthy` 的列表、创建、更新三项失败。合成测试不修改远端凭据或真实身份。
两个修改的 TypeScript 文件通过 Oxfmt；文档检查保留 84 项基线错误，无新增。
本工作树未安装依赖，未运行整个工作区的类型检查或构建。
