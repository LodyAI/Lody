# 在 Provider 凭据过期后保留会话的 Agent 上下文

Status: implemented
Translation: current

[English](2026-09-09-oauth-expiry-context-loss.md)

## 摘要

一次 Provider OAuth 凭据过期就可能让会话与 Agent 的 transcript 永久脱钩：失败的
turn 会跳过 `session/close` 强杀 ACP 进程，下一个 turn 的 `loadSession` 随之失败，
fallback 于是新建一个 ACP session，其 id 覆盖了 `meta.acpSessionId`。由于该
fallback 直接读取本地 mirror 而不等待同步，刚重启过 daemon 的机器会一条历史都
replay 不出来，Agent 表现得像这段对话从未发生——而且是静默的，因为没有可 replay
的内容时连提示都不会写入。现在认证失败改为优雅关闭会话，能穿透
`[ACP_RESUME_FAILED]` 包装被识别出来，从而请求重新登录而不是烧掉 resume 指针；
fallback 也会拒绝启动一个没有上下文的会话，而不是无声降级。这个拒绝会让该 turn
失败，对历史确实无法同步的用户是可见的回退；这是刻意的，因为另一种结果无法被
察觉。

## 链条，以及每一环的切断点

四个缺陷是叠加的，只修其中任何一个仍然会丢上下文。

1. `handleTurnError` 对所有需要终止的 ACP 错误都用 `force = true`。
   `Session.terminate` 在 force 时跳过 `agentClient.closeSession()`，因此依赖关闭
   时落盘 transcript 的适配器会丢掉 `loadSession` 所需的产物。认证失败留下的是一
   个健康的进程，现在改为优雅终止；其余需要终止的错误仍然强杀，因为连接已经
   disposed 时优雅关闭只会拖慢拆除。
2. `isAuthenticationRequiredACPError` 过去只匹配最外层错误，且只认写明了补救方式
   的 Provider 文案（"please run /login"）。裸的 "OAuth session expired" 会落到
   `acp_internal_error`，而 restore 路径看到的是被包装的 `[ACP_RESUME_FAILED] …`
   而非底下的认证原因。现在它会遍历 `cause` 链，并接受指明认证名词的凭据过期文案；
   无关的过期（证书、试用期、缓存）仍被排除，测试从正反两侧都做了约束。文本匹配是
   **逐链接**执行的，而不是在展平后的文本上做一次：SDK 抛出的 `RequestError` 是
   `Error` 子类，而 `formatErrorWithCauses` 对嵌套 `Error` 只打印 message，会丢掉承载
   Provider 文案的 `data.details`。本修复的第一版是在展平文本上匹配的，在评审中被发现；
   它的测试之所以通过，只是因为用了普通对象作为 `cause`，而 `JSON.stringify` 会完整
   保留 `data`。现在的用例改用 SDK 类型。
3. restore 的 fallback 过去对任何 resume 失败都会触发。凭据过期是可恢复的——
   transcript 仍在磁盘上，用户重新登录后 `loadSession` 就能工作——因此 fallback
   替换掉了一个只需要重新登录的会话。现在认证失败时跳过 fallback，并以
   `acp_auth_required` 停止，让客户端展示登录面板。
4. fallback 过去用 `SessionDocument.getHistory` 构建 replay，那是一次永不等待同步
   的本地 mirror 读取，而且替换会话是先创建的。现在 `waitForReplayableHistory` 会
   在 mirror 订阅上有界等待，直到出现当前 turn 以外的条目；replay 在替换会话存在
   之前构建；replay 为空时该 turn 直接停止，而不是把新的 `acpSessionId` 覆盖到仍
   指向 transcript 的那个上面。

## 备选方案与未做的部分

在 `SessionMeta` 中记录 `previousAcpSessionId`，可以让 fallback 之后的 turn 重新尝试
原始 transcript。此处未采纳：那是一次线格式变更，而更收敛的认证修复已让它对本缺陷
不再必要；历史已同步的真实 resume 失败仍会替换会话，这也仍然是正确结果。

`create` 分发分支（`resolveSessionDispatchAction`）与 `restoreMissingSession` 不同，
完全没有历史 replay。此处刻意不改：它只有在 `meta.acpSessionId` 从未写入时才可达，
因此没有 Agent 上下文可丢；而把这些会话改走 `continue` 会跳过只有 create 路径才执行
的 worktree 准备。该分支唯一可达的丢上下文场景是处于 `sync_conflict` 的导入会话，
那属于本地项目历史特性，不属于本缺陷。

replay 本身按设计仍是有损的：上限 10 万字符，先丢终端输出、再丢 thinking、最后截断
最旧的 turn。本记录不改变这一点，只保证 fallback 不会在无话可说时被进入。

"绝不把可 resume 的 ACP session 换成没有上下文的会话"这条规则**没有**写进它本该所在的
`apps/cli/src/session/AGENTS.md`：该文件距离 8192 字节的上限只剩 14 字节，而最短的表述
约需 135 字节。写入它需要先从该文件中移出一个主题，那是另一次改动；在此之前，本记录是
这条规则唯一的书面出处。

## 验证

`apps/cli` 的单元测试覆盖了每一环：分类器接受裸的凭据过期文案、能穿透 resume 包装，
同时拒绝无关的过期；因 `OAuth session expired` 失败的 turn 记录 `acp_auth_required`
并以 `force = false` 终止；包装了认证原因的 resume 失败会停止且不再调用第二次
`createSession`；未同步的历史会拒绝无上下文的 fallback；迟到的历史通过 mirror 订阅
被等到并作为 replay 文本进入 prompt。迟到同步的测试用 microtask 驱动订阅，断言的是
信号而非睡眠。

未验证：没有对活的适配器真实制造过期凭据，因此"哪些适配器会在 `SIGKILL` 时丢失
transcript"——优雅关闭这一修复的前提——是依据 ACP 契约推断的，而非实测。15 秒的历史
同步上限是判断值，不是测量值。
