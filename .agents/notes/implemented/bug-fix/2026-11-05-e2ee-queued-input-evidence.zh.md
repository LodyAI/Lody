# 加密工作区排队输入的执行证据

Status: implemented
Translation: current

[English](2026-11-05-e2ee-queued-input-evidence.md)

## 摘要

排队输入是通过机器写入的行进入历史的，所以这一行的签名指向机器，而不是输入的作者。现在排队输入自带证据。
人的输入携带客户端已经准备好的 purpose-8 签名原件，启动时按该原件的签名者授权。机器自写的输入携带本地收据，
内含内容摘要。两者都没有的提升行不启动。普通工作区不变，ledger 格式不变。运行时原件需要包含此改动的客户端。

## 决定

- **标记。** 加密工作区里，提升时在行内写入 `queuedInput: true`。已有的签名行校验覆盖该字段，事后无法移除。
- **人的输入。** 客户端把帧存到 `queueDispatchOriginals`，先于队列行，且在同一文档内。两者因此有因果顺序，
  没有帧的行也就不会再等到证据。启动时 `makeVerifiedExecutionOriginal` 按当前账本打开帧，绑定会话、Turn 和配置，
  返回签名者。之后由现有 `authorizeExecution` 检查当前成员资格、设备状态和共享。
- **单独的 map。** `rpcDispatchOriginals` 按严格相等比较，而提升时会加上 `resume`。如果从那里读队列帧，不含此改动
  的 CLI 会拒绝该 Turn。
- **比较方式。** `queuedInputEvidence` 是作者所选内容的规范形式。它排除 `resume` 和自动化标记，并把缺失与空的
  MCP 选择视为相同。
- **机器输入。** 自动化是 CLI `pushMessageQueue` 的唯一调用方，Schedule 容量调度也经由它进入队列。写入前它把摘要
  记到 `execution-origins.sqlite`。`userId` 和机器签名都不参与判断。
- **发送。** 加密排队发送必须有帧才能继续，所以会等过 200 ms 的准备期限。做不出帧时不发送，发送者能看到结果。
- **编辑。** 每个 Turn 的原件不可变，所以改变输入的编辑会换新的 `userTurnId`、`operationId` 和时间戳。切换编辑
  标记不会。
- **范围。** 直接写的历史行不受影响：它的签名者就是作者。客户端 steer 路径自己写行，拒绝只改状态。这里覆盖
  [#2344](https://github.com/LodyAI/Lody/pull/2344) 执行来源提议的排队部分，其余部分仍在该 PR 中。

## 替代方案

- *在提升时拒绝。* 被拒的行要有自己的终态路径，可能卡住队列，而且每条提升路径都要检查。启动门禁已经有一条可见的
  拒绝路径。
- *不新增签名，信任 `queuedItem.userId`。* 该字段只是显示数据。
- *用帧里的配置替换行的配置。* 这会掩盖不一致，而不是拒绝。

## 后果和限制

- 不含此改动的客户端写的排队行没有帧，启动时被拒绝。Web 和手机通过 `lody-oss` 版本获得此改动，所以该更新要与
  CLI 一起发布。升级前排队的行同样处理。
- 排队输入保持原有的 15 分钟窗口。
- 帧会让 Session 文档增长，`rpcDispatchOriginals` 本来也是如此；不做裁剪。
- 账本落后时，未知的请求签名者会被拒绝，不会重试。

## 验证

`apps/cli/tests/e2ee-runtime.test.ts`（"encrypted queued input evidence"）用真实账本、签名原件、watcher 提升和启动
claim，覆盖成员、owner、未共享、已移除、已撤销、无签名、被改动和机器自写的输入，以及派生来源。
`packages/components/tests/legacy-session-send-migration.test.ts` 固定客户端顺序、拒绝和编辑。没有运行真实后端、设备
或手机。
