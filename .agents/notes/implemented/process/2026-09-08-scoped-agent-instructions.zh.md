# 按任务范围组织 Agent 规则

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/473

[English](2026-09-08-scoped-agent-instructions.md) | 中文

## 摘要

父级说明文件积累了大量功能契约，修改无关代码也要读取；仅 chat/submission 的祖先规则就有 36,226 字节。本次保留直接可见的全局边界与文档义务，将平台、目录、MCP handler 和文件辅助模块的契约放到各自的 `AGENTS.md`，并在父级明确哪些调用方必须读取。该祖先链现为 27,409 字节，不包含按任务触发的额外阅读。产品保证和审查等级保持不变；代价是跨目录修改需要遵循必读链接，因此父级缩短不代表每种任务的总阅读量都下降。

## 决定与此前工作的关系

本次实施规则归属整理和文字精简，不改变产品意图。它细化[文档维护提案](../../proposed/process/2026-09-05-human-reviewed-spec-maintenance.zh.md)中的内容归属，不批准整个提案或任何 Spec，并保留[明确 Note 触发条件](2026-09-07-explicit-agent-note-triggers.zh.md)所要求的根级 Spec/Note 提醒。

约束仍在 `AGENTS.md`，解释放在 `.agents/docs/`。跨目录契约由共同父级说明什么行为变更必须阅读契约，包括定义目录外的 UI/CLI 调用方。已有 UI 几何、执行同意、持久化、隐私和 P0/P1 审查要求均保留。没有新增审批门槛、生成索引或运行时改动。

## 归属与入口核对

| 原位置与内容 | 现在的位置 | 其他调用方如何读到 |
| --- | --- | --- |
| 根：平台组装、设置能力、遥测、运行时下载通道 | [platform 规则](../../../../packages/platform/AGENTS.md) | 根要求修改这些行为前阅读；全局公开仓库与 local 边界仍留在根。 |
| 根：协议协商、MCP 选择、目录持久化、Role 安全与派发 | [shared 规则](../../../../packages/shared/AGENTS.md) | 根触发条件覆盖目录 UI、每轮选择及 Role 创建/派发；原契约完整保留。 |
| 根：viewer 发布版本 | [已有 viewer 规则](../../../../packages/code-review-viewer/AGENTS.md) | 根将打包和版本修改指向已有的详细定义。 |
| 根：社区贡献大小与分配细则 | [已有 GitHub 规则](../../../../.github/AGENTS.md) | 根仍识别身份，要求规划社区工作以及 PR/Issue 工作前阅读。 |
| CLI：Session/Task MCP 工具 | [MCP 规则](../../../../apps/cli/src/mcp/AGENTS.md) | CLI 要求工具、调用方及委托 Task 自动化修改前阅读；子 Session 来源、模型校验和反馈隐私仍在 CLI 父级。 |
| components 包级：崩溃恢复、文件预览、Code Collab | [辅助模块规则](../../../../packages/components/src/lib/AGENTS.md) | 包级触发条件明确覆盖 UI、hooks、providers、缓存、诊断及 IPC 调用方。 |
| lib：IPC/路径解释与已知缺口 | [文件身份说明](../../../docs/components-file-paths.md) | 缓存别名、错误分类、跳过目录及 readonly 修复约束仍在 lib 规则中。 |
| chat：输入框与选择器措辞 | [chat 规则](../../../../packages/components/src/components/chat/AGENTS.md) | 作用域不变；行为、阈值、草稿归属、菜单交互及平台差异仍直接列出。 |

新增的 platform/shared 作用域各有 `CLAUDE.md -> AGENTS.md` 符号链接。维护指南补充了必读触发条件与祖先链测量方法；CLI 和组件说明也指向新的规则归属。

## 测量与方案取舍

字节数对比 Git 管理的基线 `AGENTS.md` 与当前未忽略的文件，每份只计一次，不重复计算 `CLAUDE.md`。祖先链是从根到指定源码目录的各级 `AGENTS.md` 大小之和。

| 范围 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 根文件 | 7,983 | 5,046 |
| CLI 父级 | 8,151 | 5,610 |
| components 父级 | 7,641 | 2,956 |
| chat | 8,183 | 6,988 |
| CLI `src/session/worktree/` 祖先链 | 28,059 | 22,581 |
| components `src/components/chat/submission/` 祖先链 | 36,226 | 27,409 |
| 所有 `AGENTS.md`，含新增归属文件 | 302,390 | 298,195 |
| 超过已有 7,000 字节警告阈值的文件数 | 21 | 17 |

迁移契约不取消阅读义务：Role 相关输入框任务还要读 shared，文件界面任务还要读 lib。以上数字不代表模型 token 数、运行时性能或 Agent 成功率。

只缩句会继续让父级携带无关契约；把约束塞入历史 Note 会失去可靠入口。本次采用作用域归属与必读条件。更广泛的政策删除或新增累计大小检查门槛不在此次范围内；其余较大的作用域保留当前规则，不为达到数字目标机械拆分。

## 验证与限制

- 对照基线 diff 核对根/MCP 契约迁移及组件/chat 改写，覆盖显式空 MCP 选择、Role 冻结、执行同意、local 文件路由、二进制缓存排除与恢复边界。
- `pnpm run docs status`、`pnpm run docs check` 和 `git diff --check` 通过；剩余 17 项原有大小警告，没有注册的 SHA 保护主题。
- `pnpm check:public-boundary` 因八处 ACP workspace 依赖无法解析而失败。将未修改的 HEAD 导出到临时 Git 仓库并建立索引后，得到相同八处失败。当前 checkout 缺少对应子模块 manifest，此次文档修改未新增边界问题。
- 准备 PR 时执行了 `pnpm check`，因缺少 `tsgo` 停在类型检查，后续 lint/test 未运行。`pnpm format` 已完成；提交前恢复了它产生的无关源码格式改动。
- 未改应用源码、包 manifest 或依赖；完整应用类型检查、构建及测试验证仍未完成。文档验证不证明产品正确性，也不授予 Spec 批准。
