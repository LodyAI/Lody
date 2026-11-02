# 本地持久化失败后 Streams 实时读取循环空转

Status: proposed
Type: bug-fix
Translation: current

[English](2026-10-19-streams-read-loop-spin.md)

## 摘要

更新到 0.107.1 后，桌面端用户频繁看到"重连中"，之后 CLI 会彻底无响应，只能退出应用。原因是 Streams 实时读取循环进入了无限微任务循环，入口是把同步数据写入 `repo.sqlite3` 时遇到 `SQLITE_BUSY`。三个上游缺陷叠加导致这个结果：重试的读取沿用已经取消的请求控制器；SSE 读取器把这个取消原因重新归类成可重试的网络错误；取消分支重试时既不换控制器也不退避。在已发布包上的确定性复现中，0.106 的组合以同样方式空转，所以 0.107.1 只是让触发条件变得频繁，循环本身不是它引入的。两个上游修复已合并：loro-streams#429 修复空转，loro-repo#159 让锁等待不再冻结事件循环。两者都能让不打补丁时失败的新回归测试通过。持锁进程仍未查明，所以 Lody 现在会在报告锁失败时，记录哪些进程打开着 `repo.sqlite3`。

## 报告中的证据

一份 0.107.1 日志包覆盖两天。其中 0.106.0 那部分没有 `database is locked`；0.107.1 那天有 197 条。0.107.1 上每次出问题的顺序都一样：

1. daemon 主线程在低 CPU 下被阻塞 5.0–5.7 秒（有一次 10 秒）。`better-sqlite3` 同步等满 5,000 ms 的 `busy_timeout`，随后 loro-repo 持久化以 `SQLITE_BUSY` 失败。桌面端 800 ms 的状态探测超时，所以界面显示重连中。
2. meta、文档和 Flock 房间随后出现 `sse flush chain error` / `live read failed (flush chain)`，这些房间进入 `error`。
3. 大约一秒后，一份 `idle=0%` 的卡顿采样指向 `awaitSseRelease ← readFromOffsetSseItems ← runReadLoopIterations`，并且有 `classifyFetchError`。这份报告之后主线程再没写出任何日志。60 秒只是 watchdog 出报告的时间点，线程从未恢复。之后本地 IPC 连接一直被拒，直到 SIGKILL。

0.107.1 那天的十次应用重启中，有九次发生在这种永久卡死之后；另一次是正常退出。

## 机制（已复现）

复现使用已发布的包、Node 真实的 `fetch` 和一个回环 SSE 服务器。让 `beforeRemoteCursorSave` 钩子抛出一次 `SqliteError`，与 loro-repo 的持久化屏障在锁争用时的表现一致。

1. flush chain 对当前的实时请求控制器调用 `abort(flushError)`。
2. 读取循环把错误归类为 `internal`，记为终止错误，并安排在 1 秒下限后自重启。
3. 与此同时，undici 用同一个错误对象让 SSE 响应体出错。streams-client 的 SSE 读取器把这次失败记成 `fetch` 边界错误，但没有标 `abortKind: "caller"`。`thrownToStreamError` 把它映射为 `network_error`，并以该对象作为 `cause`。streams-crdt 的 `toTransportFailure` 返回同一个对象，并把它记录的上下文替换成 `originalCode: "network_error"`。
4. 自重启执行 `state.requestController ??= new AbortController()`，保留了已经取消的控制器。`awaitSseRelease` 同步抛出已保存的取消原因；它现在被归类为可重试的 `network`。
5. 取消分支（"rejoin() abort or retriable flush"）把尝试次数清零，然后直接 `continue`，不换控制器，也不 sleep。不再发出任何请求，也不再有任何定时器能运行。

调用方的 `rejoin()` 会替换控制器。复现中，失败后 500 ms 调用 rejoin 能恢复房间；1,500 ms 时它永远执行不到。Lody 的工作区重连会对出错房间调用 `rejoin()`，但日志里观察到的延迟是第一次 0.8–1.1 秒，之后 1.7–4.6 秒。因此每个出错的房间都在和自己 1 秒的自重启赛跑。

## 上游修复与验证

三个缺陷都在 loro-streams。每个补丁都打在已发布产物的临时副本上，再跑同一个复现：

| 产物                                        | 钩子抛 `SqliteError`               | 钩子抛可重试的 503 | 无原因的取消 |
| ------------------------------------------- | ---------------------------------- | ------------------ | ------------ |
| streams-crdt 0.17.0 + streams-client 0.9.0  | 1 秒后空转                         | 立即空转           | 立即空转     |
| streams-crdt 0.19.0 + streams-client 0.12.0 | 1 秒后空转                         | 立即空转           | 立即空转     |
| 仅循环入口换新控制器                        | 恢复                               | 空转               | 空转         |
| 取消分支换控制器并退避                      | 恢复                               | 恢复               | 恢复         |
| 两处都改                                    | 恢复                               | 恢复               | 恢复         |
| 仅修正调用方取消的归类                      | 不空转，但停在 `error`，不发新请求 | 未测               | 未测         |

已合并的上游修改为 [loro-streams#429](https://github.com/loro-dev/loro-streams/pull/429)（基于 `main` 的 `0900fca1`）：

- streams-crdt `transport-runtime.ts:runReadLoopIterations` 在入口替换已取消的 `requestController`。在取消分支里，若控制器仍是捕获的那一个，就换上新的控制器并走 `awaitReadRetryBackoff`。由 `rejoin()` 触发的取消已经换过控制器，保持立即重启。
- streams-client `sse.ts:readSseEvents` 把调用方取消之后发生的响应体读取失败记录为 `abortKind: "caller"`，与"显式取消不算 `network_error`"的既有规则一致。
- 回归测试模拟 Undici 用取消原因让已取消请求的响应体出错的行为。测试使用假定时器，并加了一个守卫：读取反复发生却没有新请求时，守卫会关闭 transport。streams-crdt `self-healing-loops.test.ts` 的三个用例和 streams-client `error-context.test.ts` 的调用方取消用例，打补丁前失败、打补丁后通过。两个包的完整测试套件都通过（streams-crdt 510 个，streams-client 206 个）。只改读取循环就能通过循环测试；只改归类时，房间停在 `error`，不发新请求。
- 构建出的补丁在所有使用真实 `fetch` 的回环场景中都能恢复。

Lody 在 `pnpm-workspace.yaml` 的 catalog 中把 streams-crdt 固定为 0.19.1、streams-client 固定为 0.12.1，并加入对应的经审核 `minimumReleaseAgeExclude` 条目，以此采纳修复。一次 catalog 升级同时覆盖 CLI 和使用同一实时循环的 renderer。loro-repo 的 peer 范围已经接受 0.19.1，所以它解析到的 peer 也随之更新。Lody 的持久化房间，无论 0.107 稳定分支还是 `main`，都通过 `loro-repo/transport/streams` 使用 Promise 版 `StreamsCrdt`。唯一的 `@loro-dev/streams-crdt/effect` 引用是 presence（临时）流，稳定版构建也没有引用 `loro-repo/effect`。所以修复覆盖了 Lody 运行的全部持久化房间。

## 等锁时不再冻结事件循环

[loro-repo#159](https://github.com/loro-dev/loro-repo/pull/159) 修改 `SqliteRepoStore`。它自己打开的连接在打开之后使用 `busy_timeout = 0`，之后每次存储调用都走一条按请求顺序执行的通道。遇到 `SQLITE_BUSY` 的那一段会异步退避重试，直到请求后经过 `busyRetryMs`（默认 5000 ms，与原来的上限相同），然后以驱动原本的错误拒绝。之后的工作排在它后面，所以请求顺序和"数据先于它的游标提交"规则都不变。`PersistenceWriter` 遇到忙碌的合并提交时只失败一次，不再逐组单独重试。

- **为什么放在存储层。** 出问题的脏文档刷写直接调用 `storage.save`，根本不经过 `PersistenceWriter`，在那里重试会漏掉它。
- **兼容性。** 打开数据库和 `recoverStaleWriter` 保留同步的 5000 ms 等待。调用方传入的 `database` 保持 `busy_timeout = 5000`。`close()` 会拒绝仍在等锁的工作。
- **测试。** 由第二个连接持有写锁，测试使用假定时器。不加修改时，顺序用例会阻塞 15 秒（三次调用各 5 秒）并失败，关闭用例和 `PersistenceWriter` 用例也会失败。预算用例是行为契约，改前改后都通过。完整的 `pnpm check` 通过（651 个测试），构建、打包和 writer recovery 检查也都通过。
- **暂缓的方案。** 把 SQLite 工作移进 worker 还能把 CRDT 的 CPU 计算移出主线程，owner 决定暂不做。

Lody 只需要升级版本：`createCliSqliteRepoStore` 自己打开连接，会直接用上新的默认值。本次修改把 loro-repo 固定为 0.23.3，并加入对应的经审核 `minimumReleaseAgeExclude` 条目。

## 记录锁的持有者

`apps/cli/src/lib/loro/sqlite-lock-diagnostics.ts` 监听 loro-repo 和 streams-crdt 打印的 `database is locked` 报告，然后通过共享进程层，对每个工作区的 `repo.sqlite3`、WAL 和 SHM 文件运行只读的 `lsof +c 0 -F pcR`，超时 5 秒。每个数据库记一条 warning，列出其他打开者的 pid、父 pid 和命令名。探测每分钟最多一次、同时只跑一个，从不重试、阻塞或改动存储。`lsof` 列出的是打开者，不一定是持锁者。没有 `lsof`（Windows）时，这一行会注明打开者未知。

## 未解决的限制

- **锁持有者未知。** daemon 内部对 `repo.sqlite3` 只有一个连接，且 loro-repo 的 SQLite 事务都是同步的，所以 daemon 不可能在等待期间自己持有这把锁。0.107 中桌面端和 MCP host 都不打开这个文件。一次性 CLI 命令会打开它（见 [Flock 持久化迁移](../../implemented/architecture/2026-09-27-loro-repo-flock-persistence-migration.zh.md)），但它们的日志不在这份报告里。出问题时可对 `repo.sqlite3*` 运行 `lsof` 记录打开它的进程。
- **持锁时长不变。** loro-repo 在加载和部分快照合并时，仍在 IMMEDIATE 事务内回放 CRDT 数据。因此主线程的 CPU 开销，以及每个进程为其他进程持锁的时长，都没有变化。
- **验证范围。** 两个修复由上游测试和回环复现验证，没有在报告者机器上验证。0.106 的对比用的是同一个合成触发条件，而不是报告者的真实负载。
