# Coding Agent 定时任务主线页

Status: implemented
Translation: current

[English](2026-10-05-coding-agent-scheduler-page.md)

## 摘要

寻找周期性编程任务的读者需要区分定时规则、运行时可用性和厂商原生自动化。英文主线页及中英文操作文档解释了 Lody 的统一定时流程、六条接入路径、执行机时区、提议确认，以及已知的配置校验失败。页面复用 GUI/远程页外壳，不虚构定时界面截图，也不声称所有 Agent 均已完成执行验收。本次不改变运行时行为或发布打包。

## 决策与证据

- `/coding-agent-scheduler/` 负责场景概览和厂商方案对比；`/docs/scheduled-tasks/` 负责操作及排错。沿用 [GUI/远程页决策](2026-09-30-coding-agent-workflow-pages.zh.md) 的外壳、原生 FAQ、英文独立路由，不生成不存在的多语言地址。
- Codex、Claude Code、Kimi Code、GLM over Claude Code、DeepSeek Harness、Pi 是接入路径，不是统一能力矩阵。GLM 是 Claude Code 上的 provider 配置，Harness 不等于 DeepSeek over Claude Code。网站构建无法证明真实模型执行成功；用户应先测试选定配置。
- 在 `cd3f5b3ca969be5fa2e327744d449ffd802efe7b` 核对：`apps/cli/src/lib/schedules/schedule-workspace.ts` 通过启动及轮询唤起调度，不唤醒操作系统。共享时间逻辑只选择最近错过的时刻，编辑器和提议默认 `run_once`。界面使用机器上报时区，旧机器缺少元数据时回退到查看设备时区。Once 保存绝对时刻，日历规则保存时区；高级 cron/skip 不等同于编辑器默认值。
- [#1197](https://github.com/LodyAI/Lody/pull/1197) 说明执行机时钟输入和 DST 修复；[#1159](https://github.com/LodyAI/Lody/pull/1159) 移除额外权限门禁，但保留普通 Session/provider 校验。
- 提议卡必须点击创建才提交；MCP 定时工具也支持暂停，因此修正旧文档「不能修改任务」的绝对说法。
- [#1247](https://github.com/LodyAI/Lody/issues/1247#issuecomment-5986803074) 报告保存的 `fast: "false"` 在 Session 创建时遭拒，却显示 `DISPATCH_UNAVAILABLE`。文档解释症状及诊断边界，不修复运行时、不编造规避方法，也不声称用户已安装修复或端到端执行已通过。

## 官方方案现状

2026 年 10 月 5 日核对：

- [Claude 定时文档](https://code.claude.com/docs/en/scheduled-tasks) 区分会话内 `/loop`、Desktop 定时任务及云端 routines；不能再声称所有 Claude 定时任务在退出会话后消失。
- [Codex automations](https://developers.openai.com/codex/app/automations/) 当前重定向至 [OpenAI Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)，涵盖本地项目及网页工作流。页面承接搜索意图，不将旧入口描述为唯一现行产品界面。
- [Harness Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md) 是独立 Host 子系统；上游支持不代表 Lody 已暴露对应功能。

## 结构与验证

薄路由 → metadata 与定时页面组件 → 既有外壳及操作文档。路由加入静态路径、目录式 canonical、llms 发现入口、主线导航及页脚。不新增运行时依赖、截图素材、全局 SEO 政策或后续 Agent 独立页。既有路径测试覆盖新路径和锚点；生产浏览器场景增加该页，覆盖 FAQ、移动溢出、主题、禁用 JavaScript 及历史导航。

实际执行的最终检查及环境限制记录在 PR。构建和静态站点检查不代表真实 Agent 定时执行、用户安装版本或线上部署验收。
