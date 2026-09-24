# 通过 Core 接入 Grok 会话分叉

Status: implemented
Translation: current

[English](2026-09-24-grok-session-fork.md)

Provider PR: [acp-extension-grok #21](https://github.com/LodyAI/acp-extension-grok/pull/21)

## 摘要

Grok 的标准 ACP 能力响应没有 fork，但其原生私有接口可以复制完整会话或包含
指定历史 prompt 的前缀。适配器现已把 Core 的标准分叉和版本化轮次选择桥接到
该接口，查找源工作目录，并且不回放地接入子会话。原生 prompt 标记提供重启后
仍可使用的分支内坐标，实时用户回显继续对宿主隐藏。协议测试及隔离的原生磁盘
复制探针通过；鉴权后的继续对话以及跨压缩历史分叉仍需端到端验证。

## 决策与证据

此记录纠正初次调查中“没有标准 ACP fork 能力就表示运行时没有分叉实现”的推断。
上游 [`f0e3be1` fork.rs](https://github.com/xai-org/grok-build/blob/f0e3be1100ef5252488e3be8bb0e91cf68d8c305/crates/codegen/xai-grok-shell/src/session/fork.rs)
通过 `x.ai/session/fork` 接受 `targetPromptIndex`。虽然 `/fork --at` 命令被禁用，
下层实现已经支持该参数。

[Spec](../../../../specs/grok-session-fork.zh.md) 沿用
[Core 的既有契约](../../../../packages/acp-extension-core/README.md)：
`session/fork`、`_meta.lody.forkAtTurn` 和输出的 `_meta.lody.turnId`，无需修改
Core 或宿主生产代码。原生 `promptIndex` 转换成不透明的 `grok-prompt:<index>`
标记，重启后不依赖进程内查找表或推算的计数器。没有原生标记的旧轮次不产生
可选择的边界。外部 rewind 可能复用坐标，因此 ID 表达当前分支历史。

适配器内部开启原生用户回显，消费实时用户文本，在助手输出前发布 Core 的
会话信息边界。回放用户文本及无关元数据保留。每次新 prompt 清除上一次边界；
轮次中无标记的用户回显不会清除已知的当前边界。

每次分叉通过标准 `session/list` 分页查找源 cwd。请求中的 cwd 是目标目录，
包括 worktree 目标。原生复制成功后，通过 `session/resume` 配合目标 MCP
服务器及启动权限接入新 ID，避免重复回放历史。源会话不会被重新加载或取消。
复制或查找失败时保留原始 RPC ID；接入失败还返回已持久化的子会话 ID，供恢复
使用，不会静默丢失它，也不会假装分叉成功。

直接转发 `session/fork` 无法实现功能，因为 Grok 没有实现该标准方法。重放
文本会丢失原生上下文，因此没有采用。存储复制完全由 Grok 负责，适配器不重新
实现压缩或持久化逻辑。既有的
[流式分叉入口规则](../bug-fix/2026-09-11-streaming-fork-affordance.zh.md)
保持不变，本次只补充提供方能力及轮次标记。

## 验证与限制

- 82 项适配器测试全部通过，覆盖完整和指定轮次转换、源目录分页查找、包含式
  零索引、并发请求、反向请求 ID 隔离、启动权限、错误目标、失败处理、回放标记、
  重启后轮次定位以及模型快照延迟完成。
- 适配器 build/typecheck 脚本通过，内容为 JavaScript 语法检查。
- 在官方 Grok 1.0.34、1.0.40 上运行
  `GROK_PATH=<binary> node scripts/probe-session-fork.mjs` 均通过。探针使用隔离的
  `GROK_HOME` 和合成数据，不登录、不发送模型 prompt。检查源会话发现、完整及
  第 0/1 轮包含式前缀复制、跨 cwd、新会话身份、模型上下文和回放文件，以及
  源文件逐字节不变。
- 鉴权后的子会话继续对话、持久化正在进行时复制，以及跨压缩历史边界，尚未
  端到端验证；适配器将相关持久化语义交给固定版本的运行时。
- 此嵌套检出没有根依赖。已尝试 `pnpm check` 和 `pnpm format`，分别因缺少
  `tsgo` 和 `oxfmt` 等依赖失败；未运行桌面界面。根文档检查仍报告指向其他
  未初始化 ACP 子模块的既有失效链接；本次变更没有已注册的受保护内容主题。

## 本 PR 冗余代码的消融

以适配器 `58cff15` 为基线，每次只应用一个候选改动，使用未修改的原始 82 项
测试运行 `node scripts/test.mjs`，随后恢复基线再开始下一个实验。
测试通过本身不能证明可以删除协议保护。

| 独立改动 | 结果 | 决定 |
| --- | --- | --- |
| 移除 `turnBySession` 写入 | 80/82；实时、回放边界及下一轮归属失败 | 保留 |
| 移除重复游标检查 | 81/82；找不到源会话时继续请求重复页面 | 保留 |
| 移除推测性的嵌套 `result.result` 回退 | 82/82 | 删除；源码与原生探针确认响应直接返回对象 |
| 移除重复的子会话 ID 回调参数 | 82/82 | 从 resume 请求的 session ID 获取 |
| 用规范化 ID 往返替换重复的正则、范围校验 | 82/82 | 复用发出 ID 的格式化函数 |
| 移除 fork 专用的请求 ID 分配器 | 82/82 | 与上下文、账单请求共用 `runtimeRequest` |

合并后的改动同样通过全部 82 项测试、语法检查及两个版本的原生探针。
原始和简化后的校验器对 269 个确定性输入的接受结果、错误码完全一致，覆盖
错误前缀、数值别名、范围边界、非字符串和 200 个规范 ID。既有非法输入测试
另补充指数、空白、负零别名，以及未约定的嵌套原生响应。没有删除或弱化测试。
前述原生持久化、继续对话的验证限制保持不变。
