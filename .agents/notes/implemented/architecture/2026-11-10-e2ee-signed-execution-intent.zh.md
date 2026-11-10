# 加密工作区里签名的执行意图

Status: implemented
Translation: current
Supersedes: [排队输入证据](../../archived/bug-fix/2026-11-05-e2ee-queued-input-evidence.zh.md)

[English](2026-11-10-e2ee-signed-execution-intent.md)

## 摘要

加密机器执行一条输入前必须知道它是谁写的，包括晚到几天、经快照导入、或服务端已裁剪历史的输入。以前的证明来自签名的文档帧、会话文档里存的完整加密请求，或本地回执，每种都带 15 分钟窗口。按 owner 2026-11-10 决定，现在每个可执行输入都带一份 Ed25519 签名，覆盖消息 ID 和将要执行内容的摘要，在同一次提交里和内容写在一起。启动时只验证这份签名和签名者当前的权限，不按时间判断。执行路径不再需要原始帧或 `forkAt`，签名字节也不依赖 Loro 结构，Roost 可以沿用同一语义。代价是加密发送在写入前多一步签名。

## 决定

- **记录。** `version, kind, signer, signature`（98 字节）以不带填充的 base64url 存在 turn 行、排队条目或定时任务声明的 `e2eeIntent` 字段。文档镜像没有二进制值类型，字节数组经它写入会变成逐字节的对象。
- **签名消息。** `lody-e2ee/execution-intent/v1`、类型（成员输入、机器输入、定时任务声明）、genesis、工作区、目标机器、作用域、消息 ID 和内容摘要（`packages/e2ee-core/src/internal/foundation/execution-intent.ts`）。
- **内容摘要。** 共享一份规范化形式（`packages/shared/src/e2ee-execution-intent.ts`）：历史写入层实际存储的输入配置（经过它自己的旧格式规范化和 schema），去掉 `resume`，机器输入另加 `derivedFrom` 或 `scheduleRun`。定时任务声明签定义指纹。两者都有固定测试向量。
- **写入方。** 客户端先签名再写入：桌面宿主和便携宿主都通过 `prepareDispatch` 签名，turn 或排队条目和记录在一次提交里写入；宿主签不了的输入不发送。改变内容的排队编辑沿用消息 ID，由编辑者重新签名。提升时原样拷贝排队条目的记录。这台机器自己写入的输入（预备会话、agent 消息、自动化、定时任务运行）由这台机器签名。定时任务的设定人通过 `signScheduleDeclaration` 签名：这个宿主能力自己计算指纹，不签任何其他内容。两种宿主都提供这个能力，而且不依赖 RPC 支持，因为共享界面在两种宿主上都提供加密定时任务。
- **启动。** `execution-intent-verification.ts` 用将要执行的内容重算摘要，按本工作区、这台机器、本会话和本消息验签，再在当前账本里检查签名者；找不到的签名者只在一次认证读取后仍找不到才拒绝。每种确定的拒绝都有自己的原因，只有 `e2ee_sender_not_authorized` 表示发送者没有权限。行里的显示账户不能决定请求者，加密行也不能自行指定要恢复的会话：watcher 从会话元数据取。启动时执行的输入只来自签过名的输入配置：watcher 不会用加密行里显示的 items 拼出正文，因为 items 不在签名覆盖范围内。这样其他写入者既不能借 owner 的签名换掉正文，也不能删掉存储的 blocks 来拦下这条消息。成员的宿主只签完整的 composer 输入（选定了 agent，正文不为空）；把 agent 留给会话决定的输入属于机器写入，由宿主签名。
- **执行日志。** `agent-start` 记录保存消息 ID 和摘要。一个 ID 只启动一次；已启动 ID 下的不同内容被拒绝。机器看到启动前就被取消的 turn 会把它记为已退役。执行记录的 `expiresAt` 为 0，不受任何时钟、偏差检查或下限影响；功能请求保留各自的期限。
- **等待。** 只有账本读不到才等待。收到该文档的新帧、账本读取确认、密钥装好、RPC 重新连上都会唤醒等待中的 turn；兜底定时器从 1 秒翻倍，最长 5 分钟。工作区打开期间，后台账本重试不会停止，上限同样是 5 分钟。

## 备选方案

- _保留帧签名者和 `forkAt`（#2344 的方案 A、B）。_ 需要保留帧、扫描服务端和时间窗口，快照或被裁剪的历史会让输入永远等待。#2344 提案里"定时任务是否在 Roost 前保留 fork"这一待决问题已解决：定时任务改用签名声明，不再有 fork。
- _在会话文档里存完整加密请求。_ 占 turn 行的 1.4 到 2.2 倍，依赖封装时的 epoch，还需要 15 分钟窗口。
- _把排队行的写入者绑定到帧签名者。_ 以前试过并已删除：正常同步和快照投递下会拒绝普通发送。不要重新引入。
- _在提升时拒绝。_ 每条提升路径都要检查，被拒的行可能卡住队列；启动时已有一条可见的拒绝路径。
- _信任 `userId` 或把签名者映射到账户。_ `userId` 只是显示数据，机器也没有账户目录。
- _对包括 `resume` 在内的整行签名。_ `resume` 由提升时从会话元数据补上，作者签不到；改为由 watcher 忽略行里的值。

## 后果

- E2EE 没有生产数据。旧客户端、没有记录的行和本次之前的执行日志都不迁移；测试机需要重置执行日志。
- owner 已接受：执行日志为空（例如重装后）时不知道以前的 ID；服务端可以延迟投递；撤销通过这台机器的账本读取生效；等待中的输入会一直保留。
- 直接发送现在要等宿主签名，最长 `QUEUED_ORIGINAL_DEADLINE_MS`，然后才写入 turn。
- 退役已取消的输入，前提是机器在它被改回 pending 前看到过取消状态；这段时间一直离线的机器无法退役它。
- 用相同的值重写定时任务字段，不再使声明失效。
- 排队信号的语义不变：行写入后的失败仍算已发送。

## 验证

`packages/shared/tests/e2ee-execution-intent.test.ts` 和 `packages/e2ee-core/test/foundation.test.ts` 固定摘要、记录和签名向量。`apps/cli/tests/e2ee-execution-intent.test.ts` 用真实签名验证文档及其快照、每种拒绝原因和未知签名者的读取。`apps/cli/tests/e2ee-runtime.test.ts` 覆盖排队输入（晚到、已移除、重放、编辑、机器签名、items 被改写、blocks 被删）、epoch 轮换、定时任务运行和声明，以及后台重试。`apps/cli/src/lib/e2ee/realtime-journal.test.ts` 覆盖只启动一次和退役；`apps/cli/tests/session-dispatch-watcher.test.ts` 覆盖唤醒和兜底上限；`packages/components/tests/legacy-session-send-migration.test.ts` 覆盖客户端顺序。`packages/e2ee-client/test/runtime.browser.test.ts` 通过真实便携宿主保存加密定时任务，并验证存下的声明。没有在真实后端、设备或移动端上运行。
