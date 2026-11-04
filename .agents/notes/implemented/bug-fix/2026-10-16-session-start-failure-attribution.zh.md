# 会话启动失败要说明是哪一步，并保留原始错误

Status: implemented
Translation: current

[English](2026-10-16-session-start-failure-attribution.md)

## 摘要

一个恢复中的会话以 `Failed to restore session for chat: ` 失败，冒号后面什么都没有，用户和 daemon 日志都无法说明是哪里坏了。这是三个缺口叠加造成的：抛出的错误是一个 message 为空的 Effect tagged error；会话启动从不记录当前处于哪一步；失败启动的清理过程可能用自己的错误替换掉原始错误。现在会话启动在每一步开始时上报这一步，turn 记录下来并在失败信息里写明。没有 message 的错误会用它的类型和 cause 来描述。清理失败只记日志，不会替换调用方要用来分类的那个错误。原始错误对象依旧原样传递，因为调用方要靠它的身份来决定走重新登录、历史回放还是通用失败，包装它会破坏这些判断。

## 问题

2026-10-16，一台 daemon 记录了三次启动失败。新会话显示 `turn_pre_prompt_failed`，恢复中的会话显示 `session_restore_failed`，原因为空。只有创建路径碰巧记录了堆栈，堆栈指向 `createWorktree` 内部的 `squashFileLockFailure`。恢复路径只记录 message，所以对应的那次恢复失败只能靠时间特征归到同一步：`Worktree already exists` 之后 14 秒内没有任何日志，然后就失败了。[文件锁持有者释放](../architecture/2026-10-16-file-lock-holder-release.zh.md)修复了这个具体原因，这份 note 处理的是"为什么原因看不到"。

- `formatErrorMessage` 直接返回 `error.message`，而没有 message getter 的 `Data.TaggedError` 的 `message` 是 `""`。CLI 和 shared 包里大约有二十个这样的类。
- `SessionManager.createSessionInnerWithAgent` 在一个 Promise 里依次执行凭据、工作目录、worktree、Git 身份、运行时解析和 agent 启动。没有记录当前步骤，所以失败无法说明发生在哪里。
- 它的 catch 分支先 await `session.terminate()` 和 `credentials.release()` 再重新抛出。其中任何一个失败，都会替换掉原始错误。

## 决策

- `SessionConfig.onStartStage` 会在每一步开始时依次收到 `credentials`、`workdir`、`worktree`、`git-identity`、`agent-runtime` 和 `agent-start`，每一步也会记一条 debug 日志。执行服务把最后一步记在 turn 的运行时状态上，只对发起这次启动的那个 turn 生效，并在会话绑定后清除。这样，之后发生的 prompt 前失败不会被算到启动头上。
- `session_restore_failed`、它的历史回放兜底和 `turn_pre_prompt_failed` 都记录为 `<步骤> failed: <message>`。认证失败保留原有 message，因为客户端靠它提供登录入口。恢复路径的日志现在也会带上错误对象，因此会记录堆栈。
- 失败信息使用新增的 `formatReportedError`。遇到 message 为空的错误时，它用错误的 `_tag` 或 `name` 加上 cause 来描述；因为这段文字会写进同步的聊天历史，所以 cause 只在是 Error 或字符串时才会展开。`formatErrorMessage` 本身不变：worktree 恢复逻辑和恢复路径对 `acp_resume_failed` 的检测都会对它的输出做子串匹配，如果让它永远不为空，cause 的文本就可能改变这些判断。
- 失败启动的清理总是执行到底，每个清理失败都会连同 cause 一起记日志，然后重新抛出原始错误。这与现有的 `createAgent` 失败分支做法一致。

## 备选方案

- **把失败包装成 `SessionStartFailed { stage, cause }`。** 不采用。恢复路径会检查 `AcpAuthenticationRequiredError` 和 `acp_resume_failed` 文本；创建路径会检查 ACP 和断连的错误形态，以及缺少 Git 的情况。这些地方都得先解包，漏掉任何一处，认证或续接失败就会悄悄走进通用失败路径。
- **给每个 tagged error 都加上 message。** 必要，但不够。#1614 已经为文件锁错误补上了 message，但以后任何一个没有 message 的类都会让空原因再次出现。格式化函数的兜底能在上报边界一次覆盖所有情况。
- **每一步加 trace span。** 没有采用。每个步骤边界的 debug 日志已经给每次切换打上了时间戳，而 span 还需要额外的结束事件。

## 限制

- 步骤归属只覆盖 `SessionManager.createSession`。执行服务里的 prompt 前工作（内存压力、访问校验、配置）保持原有的错误信息。
- 清理过程中记录的未完成释放，不在这里保留以供重试。它仍由各自的租约负责，例如凭据代理的 scope。
- 步骤名称以英文写在失败信息里，和其他 prompt 前失败信息一样，没有做本地化。

## 验证

`tests/session-execution-service.test.ts` 覆盖了真实的恢复和创建边界。被 mock 的 `createSession` 先上报 `worktree`，然后抛出一个 message 为空的 tagged error，两条路径都记录为 `Preparing the worktree failed: MessagelessStartFailure: <cause>`。在 `agent-start` 期间上报的认证失败仍记录为 `Authentication required`。去掉格式化函数的兜底后，恢复用例记录的内容与生产环境的症状完全一致：`Preparing the worktree failed: ` 后面什么都没有。没有上报步骤的现有用例，失败信息保持不变。

后续变更：重试决策新增了 `worktree-setup` 步骤，在 setup 脚本开始时上报。见[临时性失败重试](../feature/2026-10-16-session-start-transient-retry.zh.md)。
