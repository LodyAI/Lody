# M5 宿主执行 journal 边界

Status: proposed
Translation: current

[English](2026-10-26-e2ee-realtime-journal.md)

## 摘要

加密 RPC 需要持久证据来确认原请求已经开始，包括响应丢失和机器重启的情况。
独立的宿主 journal 保存精确原帧，通过 SQLite 只领取一次启动权，并将首次结果与
响应投递、清理分开保存，并在任一通道发布前保存精确的不透明响应原帧。
它不打开产品通道，不提供授权，也不批准 wire 格式。
产品接入还必须约束现有持久派发路径；存储测试不能证明 agent 执行链已经安全。
这里只接受当前日志格式。2026-10-27 owner 撤回了之前接受的全库 clock floor 永久拒绝限制。
[MVP 恢复决定](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md) 增加工作区隔离时钟、
可信时间检查、保留证据的显式重置，以及空库恢复。仍允许 SQLite 原生恢复，禁止应用层 schema 迁移。

## 已有证据与复用

[foundations Spec](../../../../specs/e2ee-foundations.zh.md)负责公开密码学契约。
实时 wire 和授权决定仍需 owner 批准。因此 journal 接受内部不透明标识和字节，
不实现待审编码。

- `session-dispatch-watcher.ts` 让 RPC 与 history 共用每会话检查链；RPC stash
  仅在内存中，响应表示已投递。
- `session-dispatch-logic.ts` 有意在重启后派发 `processing` history。
  `lastHandledUserMsgId` 是移动指针，不是全部请求的 journal。
- `session-execution-service.ts` 已保存 steer 提交和投递不确定性。
  接入时应查询这些证据，保留原 userTurnId。
- `machine-rpc-server.ts` 只在内存中去重并发 history 请求。
  `session-history-rpc-rejections.ts` 只将部分拒绝保留到过期。
- orchestration store 已有 SQLite 身份检查和退役 ID，但 MCP 任务的身份、
  所有权和结果投递不同。本 journal 不再建任务系统，也不依赖该 store。

这里保存宿主执行证据，与[先前决定](../../implemented/simplification/2026-09-29-remove-session-send-journal.zh.md)
删除的 renderer 发送 journal 不同。普通发送及其现有持久行为不变。

## 本地契约

`apps/cli/src/lib/e2ee/realtime-journal.ts` 是同步 Node 存储适配器，不引入定时器、
网络、后台任务或 Effect 工作流。一个 owner 保留失败句柄的清理责任；同步 SQLite
事务中途不可取消，也不等待网络。每次操作打开已有数据库，busy timeout 为零，随后
关闭句柄。首次显式初始化以独占方式创建文件。短事务遵循
[上游同步事务契约](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/docs/api.md#transactionfunction---function)，
不在事务内部捕获并继续处理修改失败。重开只接受 schema 3。原生恢复后，版本为零且没有
任何 schema 对象的库可以完成首次初始化；其他不支持或不完整的 schema 改名归档并提示，
不解码或升级旧格式。当前格式的请求键必须先隔离，即使其他表不完整；当前请求键不可读时
拒绝重置，保留原件待修复。只有显式本机重置才新建日志。相邻的稳定 control SQLite 用共享锁协调普通打开、排他锁协调重置，
保留当前格式旧请求 ID 的执行隔离与中断重置意图。其所有权、崩溃边界与限制见
[恢复决定](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md)。损坏仍阻断依赖操作。

保留边界是已提交的逻辑证据和应用格式，而非 SQLite 物理文件逐字节不变。owner
已批准 SQLite 原生事务回滚和 WAL checkpoint，包括应用尚未识别并拒绝不支持版本
之前。恢复可以改变 main/WAL/journal/SHM 文件，但不允许应用迁移、删除证据、替换
数据库或修复格式。恢复例外允许改名保留证据和显式新建，但不导入旧行。无需原生恢复的已关闭 rollback 模式库仍检查字节和权限；WAL
及事务中断场景则验证已提交的 schema、版本和证据。锁与恢复由 SQLite 管理，应用
不通过复制、删除或绕过 journal 来检查未提交的主文件头。真实跨平台和断电验收仍未完成。

```text
receive(原件) -> 持久 received
claim(原件)   -> 持久 started + 一份仅 owner 可用的 permit
             -> 已有 uncertain/completed，或 expired；不再发 permit
finish(permit) -> 持久、不可替换的 completed 结果
retainResponse(permit, index, 原件) -> 持久、不可替换的响应原件
retryResponse(permit) -> 只保存原来待存的响应字节
readResponse(原请求, index) -> 已存响应或不存在
```

主键为 `(genesis, workspaceId, targetMachineId, requestId)`。该键下的请求设备、
截止时间和精确原帧不可改变。SHA-256 检查保存原件和结果是否匹配各自摘要，不抵御本地磁盘
攻击者。另一个有效请求设备不能复用 ID 再次执行。调用方提供账号私有路径，并验证
原帧和权限。

`BEGIN IMMEDIATE` 与持久随机 claim token 协调不同 SQLite 连接。领取成功时，只向
获胜 owner 发一份模块持有的 permit。不设租约到期、替换 permit 或接管所有权。
读取、重开将 started 显示为 uncertain；只有原来的活 owner 可以保存结果。因此副作用
之后崩溃不会授权自动重跑。接口同时暴露 `outcomeStatus: unknown`。同一工作区的其他请求 ID 仍可领取执行。
不确定性须用既有执行证据确认，不会产生替换 permit。

首次 `finish` 在 I/O 前复制结果并保留在 permit owner 内。持久化失败时保留 started；
`retryFinish` 只重试同一结果字节。成功持久化前崩溃仍会丢失该内存结果，并继续待确认。
已提交结果在重启、过期后仍可查询。相同结果重复保存安全，不同结果拒绝。句柄关闭
失败不替换结果或原操作错误：owner 保留句柄和第一份尚未取走的原始诊断原因，并单独
重试清理。反复清理失败时不再打开新句柄，最多保留一个 main 句柄、它的 control 锁及一份待取诊断；清理
成功后下一调用可继续。损坏、锁冲突等存储错误阻断依赖操作；恢复后可重新打开。

响应位置是本地存储索引，不是已经批准的 wire 序号或 progress/最终结果编码。只有
原来的活 permit owner 可以从零连续追加，不允许跳号。已有位置只接受完全相同的
字节，不同原件拒绝。查询匹配完整原请求，核对响应摘要后返回保存帧的自有副本。
表以完整请求身份和位置为键，通过外键关联请求。重启保留这些帧，但不能恢复 permit，
也不授权重新签名、加密或执行。

验证下一位置和 owner 后，写入尝试在 SQLite 修改前将最多一份待存响应原件保留在
permit owner 中；未决时拒绝其他位置或替换字节。`retryResponse` 只保存原件，确认
持久化后释放待存副本。非法位置和身份冲突不会阻断后续合法调用。响应写入失败不
改变已经完成的业务结果。调用方须保留原始字节，存储确认前不能发布；打开或验证
失败既不确认投递，也不提供权限。仍未实现发送端请求 outbox、确认策略或按过期
回收响应。

## 当前库中断恢复

当前 schema 3 数据库可能需要先回滚写入，SQLite 才能读取已提交结构。只读预检以
`SQLITE_READONLY_ROLLBACK` 阻断了这种正常恢复；依据本次原生恢复决定，移除此
预检。测试在子进程未提交的结果写入已 spill 后受控退出，覆盖真实回滚边界。重开须
返回原 uncertain claim，不能返回未提交的结果，也不能再发一份执行 permit。

不支持的 schema 同样可以先经过原生恢复再被拒绝。即使 SQLite 合并 WAL 或移除已
恢复的 rollback journal，应用也不能改变已提交的版本、schema 和数据行。原生恢复
遇到锁冲突或失败时返回原始存储原因；锁或故障解除后，下一次调用可以正常重试恢复，
无需替换数据库。

## 时钟下限和显式恢复

之前 owner 接受了文件级最大时间及异常前跳后的持续拒绝；2026-10-27 撤回这一可用性取舍。
其原始理由仍适用：仅凭本机墙钟无法分辨时钟纠正与真实经过时间后回拨，不能静默延长原截止时间。

现在下限按 genesis/工作区存储。调用方提供当前、已认证的参考时间时，本机领先超过十分钟就
在任何 floor 写入前拒绝；通过检查时使用参考时间推进，不使用领先的本机时间。无参考时保留
工作区内的保守最大值。操作员可归档并重置机器日志，不必等待真实时间追上。已知旧请求 ID
仍禁止再次执行，因此重置不会复活旧请求或接管 uncertain。CLI 与细节见
[恢复决定](../bug-fix/2026-10-27-e2ee-realtime-journal-recovery.zh.md)。

不按 `expiresAt` 回收证据；没有 GC 或退休 ID 清理策略。空间耗尽拒绝依赖操作，不删除证据。

## 仍需完成的产品接入

两个加密传输必须进入同一已验证授权入口，保存同一原件，并在实际副作用前共同领取
启动权。派发 ACK 不是 agent 最终结果。将请求绑定到真实 userTurnId、steer/fork 回执
和执行结果，不重复实现这些业务流程。watcher 与 Meta/history 回退必须遵守同一启动
门槛，否则可以绕过仅在接收处的去重。新执行及后续动作前重新检查机器共享、本地
验证账本、新鲜度、epoch/rotation 暂停和取消。wire、目标设备绑定、加密、发送端
请求原件持久化及结果查询授权都尚未接入。不透明响应存储本身不打开产品响应或查询入口。

## 验证与限制

`realtime-journal.test.ts` 使用真实磁盘 SQLite、独立重开及互相竞争的 worker 连接。
覆盖精确字节/身份、结果保留、崩溃不确定性、过期证据、已观察时钟回退、仅 owner
保存结果、锁冲突、缺失/损坏/首次初始化中断的空白原件、注入 SQLite 接收/启动/结果写入失败后的回滚，
以及结果已提交但关闭句柄失败。并发 worker 通过明确信号协调，不用 sleep 或网络。
数据库快照将每个 BLOB 表示为 SHA-256 摘要和字节长度，仍保留 schema、版本、journal
模式及其他列值，避免 Vitest 对多 MiB Buffer 逐字节深比较的开销，不缩小恢复负载或
延长测试期限。同样长度的 4 MiB 已提交 BLOB 只改一个字节，快照相等断言仍会失败。
这只改变测试证据的比较表示，journal 实现和持久字节均未改变。
零等待锁竞争可能让两个 worker 都失败，也可能在 COMMIT 时失败。测试接受这一合法
调度，释放竞争 owner 后，再用正常 claim 验证已有 uncertain 不会被接管，或只领取
剩下的一份 permit。另用真实读锁证明 COMMIT 失败会回滚，下一调用可以恢复。
响应测试还覆盖连续且不可替换的原件、独立重开、待存写入恢复、已完成结果保留和
非当前或不完整库归档后拒绝、不做应用迁移、不改写已提交证据。

这些是存储边界测试，不验证完整加密派发链、平台打包、断电、本地恶意替换存储、真实
网关、原生 iroh、恢复 UI 或延迟。受影响本地检查和限制记录在恢复决定中；此次仍未执行
完整仓库检查或独立对抗审查。
该提案不批准 Spec，也不代表 M2/M5 产品验收完成。
