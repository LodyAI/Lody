# 恢复 GPT-6 Sol 和 Luna 的思考等级

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/955

[English](2026-09-24-codex-gpt6-sol-luna-reasoning.md)

## 摘要

内置 Codex 选择器的精确模型支持表遗漏了 GPT-6 Sol 和 Luna，导致两个模型的 Max 和 Ultra 被过滤。为 Sol 补充 Max/Ultra，为 Luna 补充仅 Max。此修复恢复现有的按模型选择档位约定，不向未知模型开放未经确认的档位。未来新增模型仍需显式维护此表。

## 决策与依据

归一化逻辑既补充缺失档位，也过滤缓存档位，因此仅更新运行时模型目录不能修复界面。[#406](https://github.com/LodyAI/Lody/pull/406) 引入了当前按模型维护的表；[#286](https://github.com/LodyAI/Lody/pull/286) 添加通用模型档位映射时保留了内置 Codex 的独立路径。本次扩展现有策略，不修改能力数据权威来源，也不假定所有新模型支持 Ultra。

现有选择器测试增加了 Sol 档位补充和上游描述保留覆盖，并针对两代 Luna 验证缓存 Medium、Max、Ultra 时的结果。Luna 保留 Max，将不支持的 Ultra 回退为 Medium。源码维护规则显式列出两代模型。

## 验证限制

工作树没有安装依赖，完整包测试和仓库检查需要准备好的工作区。文档检查还报告了指向未初始化 ACP 子模块的既有失效链接。实际执行的检查及结果见 PR 测试计划。
