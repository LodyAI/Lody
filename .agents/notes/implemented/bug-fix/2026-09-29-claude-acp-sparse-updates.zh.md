# 消费 Claude ACP 上游 0.84.0 同步

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1103

[English](2026-09-29-claude-acp-sparse-updates.md)

## 摘要

Claude 上游同步使工具更新变为稀疏字段，并将展示元数据置于 AIR 协商之后。Lody 的历史过滤器会丢弃部分单字段更新，主对话 reducer 会追加内容列表，权限建议也忽略了标准选项中拒绝优先的顺序。本次升级内置适配器并修复这些消费端，保留标准 ACP 协商、终端压缩存储和 Core 归属规则。运行时交付还需对齐 SDK 0.3.284 与经验证的 Claude Code 2.1.284 制品；fork 包版本仍为 0.79.0。验证没有使用已登录的提供方会话。

## 交付与依赖

Lody 在 `prepare:acp-adapters` 后通过 workspace 子模块打包
`apps/cli/src/claude-acp-entry.ts`，启动时不从 npm 下载此适配器。
`packages/acp-extension-claude` 固定到
[适配器 PR #37](https://github.com/LodyAI/acp-extension-claude/pull/37)
的合并提交 `5e7805800d792b8b036728d13948b7be352d8c69`。
上游 0.84.0 是源码基线，不是 fork 发布版本。审计时 npm 返回 0.54.3，GitHub
latest-release 接口返回 404；均不阻塞源码打包路径。本次没有发布或合并 release PR。

Lody 原 gitlink 仍要求 SDK 0.3.280。将 CLI 直接依赖与新适配器的 0.3.284 和原生
清单对齐，保留启动版本及完整性校验。八个平台的生产下载全部通过 SHA-256 和大小
核对后，才复用不可变制品。保留镜像来源及清单验证测试。重新生成 lockfile，精确版本
隔离期例外遵循[子模块 lockfile 决策](../process/2026-09-21-submodule-pointer-lockfile-regeneration.md)。
Core 仍由 workspace 的 0.1.9 契约提供。

## 消费端审计与修改

| 契约 | Lody 实际路径与结论 |
| --- | --- |
| 模式分类 | `classifyPermissionModeFace` 使用稳定 ID，含 auto、bypassPermissions，不依赖 AIR。 |
| 权限 | 标准工具标题、类型、路径及全部选项仍可用。AIR 展示字段缺失时保留通用标题，不编造原因。拒绝优先时建议单次拒绝，也兼容旧 defaultToNo；建议不会自动发送批准。 |
| 稀疏工具更新 | 终端压缩后保留单字段更新，按 toolCallId 合并，投影使用此前的 kind/Core 工具名。content、locations 整体替换，空列表清空，缺省字段保留。输出替换时，本地从 rawInput 派生的命令仍独立保留。编辑证据列表也替换，避免恢复旧路径。 |
| Diff | 不协商 AIR diffPatch；CLI 继续从标准 old/new text 提取证据。All Changes 行数来自本地 git/PR 比较，不依赖已删除的适配器 diffStats。主历史有意不存编辑正文，审批预览仍仅显示路径，这是权限 Spec 已记录的限制。 |
| 登录 | `isAuthenticationRequiredACPError` 识别 JSON-RPC -32000 和包装 cause；执行层映射 acp_auth_required 并终止旧运行时，登录和重试可以重建。无需 access-failure 通知。 |
| 终端与通知 | initialize 不声明 terminal_output_delta 或 session.notices，适配器因此使用当前 SDK/schema 支持的标准内容/文本 fallback。不声明未实现能力，也不冒充 AIR。完成的终端尾部仍限长且只显示一次。 |
| Steering | 保留 _lody/session/steer 的 inject-or-refuse 证据与 correlated applied 事件；prompt 完成、传输歧义和重试分类仍由原模块负责。 |
| 子代理与计划 | Core run ID 按根 session 隔离，祖先校验、终态屏障、权限归属继续协商。子工具数组原本已正确替换。计划按选项 kind/ID 渲染，不固定数量；接受后的 mode/config 更新仍为准。 |
| 其他 Core 字段 | Usage 标准化及取消计费、assistant UUID forkAtTurn 元数据、goal、answerNotes、工具名和压缩 activity 保留现有消费路径。 |

本次部分更新[权限提示决策](../feature/2026-09-24-permission-prompt.md)中有关 Claude
元数据的观察。[权限 Spec](../../../../specs/permission-requests.md) 保持 draft，补充标准
拒绝优先建议；[子代理契约](../../../../specs/subagent-events.md) 不变。

## 验证

合成回归覆盖分批与批量稀疏更新、列表替换和清空、缺省 read kind 时的过滤、定时工具
raw 字段保留、编辑证据替换，以及无元数据的拒绝优先请求的键盘选择。
`pnpm check` 通过，本地 fixture 测试隔离 Git 配置
（`GIT_CONFIG_COUNT=0 GIT_CONFIG_GLOBAL=/dev/null`），因为会话注入的 GitHub App
URL 重写会改变 fixture remote 身份。CLI：3227 passed、4 skipped；shared：1255 passed；
components：4555 passed。适配器全量：2084 passed、29 skipped。格式、文档、冻结安装、
公共边界检查，以及 2048 MiB 堆限制下的 CLI 生产构建均通过。构建的 `claude-acp.js`
使用 SDK 对应原生可执行文件完成标准 initialize 握手，保留 Core 能力。八个平台生产
下载均与清单匹配。没有运行真实凭据、计费或提供方 resume 流程；保留契约通过
既有合成测试及适配器源码审计核查，不声称已做真实端到端验证。
