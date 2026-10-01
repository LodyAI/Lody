# 输入区指示器优先显示五小时订阅用量

Status: implemented
Translation: current

[English](2026-10-01-five-hour-usage-indicator.md)

## 摘要

输入区为详情弹层按周期从长到短排序订阅窗口，随后直接取第一项显示紧凑指示器。
同时存在五小时窗口时，这一做法仍固定选择本周用量。指示器现在显式选择五小时窗口，
保留已有回退方式和上下文优先级。弹层继续按原有顺序显示所有上报窗口。

## 决策

本次在[新会话用量显示](2026-09-28-session-tab-rate-limit-ring.zh.md)的基础上，
让 `SessionUsagePopover` 独立选择入口窗口。反转共享数组的排序会同时改变详情顺序，
因此入口先查找五小时窗口，再回退到详情中的第一项。0% 也是有效选择。
提供商和模型匹配、数据归一化仍由现有辅助函数负责。

[显示 Spec](../../../../specs/session-usage-indicator.zh.md)记录行为意图，
[会话目录索引](../../../../packages/components/src/components/sessions/README.md)链接到该约定。
已有 `QuotaOnly` Storybook 场景已提供两个窗口。

## 验证

两个用量测试套件共 20 项全部通过，覆盖提供商窗口的两种输入顺序、五小时用量为零、
入口无障碍文案、弹层顺序、仅本周窗口的回退，以及重新渲染后上下文用量的优先级。
新增的两个用例在修复前均失败。

已初始化子模块的独立克隆通过了仓库类型检查、lint、格式化、文档检查和边界检查，
Electron 的 199 项测试也全部通过。`pnpm check` 停在既有的 boot-shell 存储不可用测试
（组件测试 1 项失败、4592 项通过）；在 Node 26.10.0 下恢复原始组件代码后仍复现。
未进行应用界面手动验证。

PR：[ #1201](https://github.com/LodyAI/Lody/pull/1201)。
