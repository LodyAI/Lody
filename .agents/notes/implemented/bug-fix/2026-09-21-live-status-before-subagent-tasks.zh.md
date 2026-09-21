# 将实时状态放在子任务摘要上方

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/867

[English](2026-09-21-live-status-before-subagent-tasks.md)

## 摘要

运行中的回复将任务摘要显示在“工作中”上方，使实时状态与回复分离。现在末尾的任务行会在卡片上方显示实时状态，无论该轮是否有页脚操作。任务展开及已完成轮次的折叠行为保持不变。

## 决策

先前的[实时耗时位置决策](2026-09-18-desktop-live-duration-alignment.zh.md)在内容以任务卡片结尾时，将状态放在页脚或独立的末尾行。会话流现在选择任务行承载状态，保留已有虚拟行标识和任务面板状态，并抑制页脚及会话末尾的重复状态。

## 验证

现有 `packages/components/tests/agent-activity-row.test.tsx` 套件覆盖有、无页脚操作时的状态顺序及唯一性，以及三个任务摘要的展开和收起。该套件、虚拟行标识和轮次操作间距套件共 26 项测试在独立检出中全部通过。工作区类型检查、lint、格式化及文档检查通过。全量检查受 Node 26 实验性 Web Storage 影响而出现测试失败；设置 `NODE_OPTIONS=--no-experimental-webstorage` 后，全部 22 个失败套件（188 项测试）通过。未重新执行完整根命令。尚未进行原生桌面视觉检查。
