# 执行仍忙碌时显示收尾状态

Status: implemented
Translation: current

[English](2026-10-06-finalizing-status-label.md)

## 摘要

prompt 完成后隐藏活动提示，会让仍然忙碌的会话看起来已经可以立即执行下一轮。
界面现在将现有的明确收尾阶段显示为“收尾中…”，英文为“Finalizing…”。
执行权和发送路由保持不变。这解释了等待原因，不引入多轮收尾重叠，也不缩短
收尾耗时。

## 决策与范围

本次调整 [PR #614](https://github.com/LodyAI/Lody/pull/614) 的呈现方式：保留可选
presence 阶段与图片回调保护，将隐藏改为显示该阶段。历史与 presence 独立到达，
尤其在目标自动继续时，因此不能通过历史选择收尾文案。

提前释放执行权是独立方案，需要固定每轮数据并防止旧收尾结果覆盖新状态。
单纯隐藏提示或在清理结束前启动下一轮并不能提供这些保证。
现有[问题收尾决策](2026-09-12-turn-question-finalization.zh.md)仍适用：必要清理由
所属轮次负责。

行为意图：[Spec](../../../../specs/session-finalization-status.zh.md)。

## 验证边界

保留阶段判断回归测试并更新其命名；另行检查翻译键和差异。当前检出未安装包依赖，
未验证组件测试及打包后的 Electron 交互。
