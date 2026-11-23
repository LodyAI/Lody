# 磁盘写满时保持 CLI 守护进程存活

Status: implemented
Translation: current

[English](2026-09-27-cli-log-survives-full-disk.md)

PR：[#1056](https://github.com/LodyAI/Lody/pull/1056)

## 摘要

Lody 数据目录所在磁盘写满后，守护进程下一次写文件日志时会在一个无人监听的 stream 上
得到 `ENOSPC`。由此产生的 `uncaughtException` 执行清理后调用 `process.exit(1)`；清理中的
flush 也因 `SQLITE_FULL` 失败，于是本地模式下磁盘写满之后的所有 Loro 变更全部丢失，
supervisor 重启后又会以同样方式崩溃。现在文件日志传输自己持有滚动写入端：写入失败时丢弃
该写入端以及期间的日志行，待一次探测写入证明空间恢复后再打开新的写入端。守护进程会保留
内存中的变更，并在空间恢复后将其 flush。这只是 issue #1054 的第一层；磁盘空间检测、面向
用户的提示和降级模式仍待后续处理。

## 证据

- winston-daily-rotate-file 5.0.0 将 `fs.WriteStream` 的错误转发给 file-stream-rotator 的
  代理 emitter（`transport.logStream`），而它没有任何监听者。winston 的 `exitOnError: false`
  只覆盖已处理的异常，不覆盖传输层 stream 错误。
- 在 16 MB RAM 盘上，单独的 `DailyRotateFile` 遇到一次 `ENOSPC` 后，即使释放空间也不再写入：
  已销毁的 stream 会静默丢弃之后的所有写入，直到按日期或大小滚动。因此恢复必须新建写入端。
- 真实守护进程（`lody start`，本地模式，`LODY_DATA_DIR` 指向 256 MB RAM 盘）在基线
  `31fb1256` 上于磁盘写满约三分钟后以 `code=1` 退出，报错为
  `Uncaught exception in CLI: ENOSPC ... write`。应用本改动后，它在写满的磁盘上运行三分钟以上，
  只输出一条 stderr 提示；释放空间约两秒后恢复写文件，收到 SIGINT 后以 code 0 退出。在同一
  数据目录重启后能重新打开已有工作区。
- 将真实 logger、`registerProcessErrorHandlers`、`SqliteRepoStore` 和 `LoroRepo` 组合运行：
  先写入 10 个文档，写满磁盘后再写入 200 个，并输出 400 行日志。基线上进程以 1 退出，清理
  flush 报 `database or disk is full`，重新打开后 200 个文档一个都没有。应用本改动后，写满期间的
  flush 仍然以 `SQLITE_FULL` 失败，但进程保持存活，释放空间后 flush 成功；重新打开后文档为
  10/10 与 200/200，`PRAGMA integrity_check` 返回 `ok`。

## 决策

`ResilientFileTransport`（`apps/cli/src/utils/resilient-file-transport.ts`）是一个 winston
传输，它自己持有 `DailyRotateFile`，而不是让 winston 直接 pipe 过去。守护进程日志和 MCP HTTP
host 日志都通过 `createFileTransport` 构建它。

- 写入端 `logStream` 上的错误，或打开、写入时的同步异常，都会让该写入端被丢弃。已丢弃的
  写入端仍保留监听器，因此迟到的错误同样会被捕获。
- 没有可用写入端期间，日志行直接丢弃，而不是转写到 stderr。混合 logger 中 console 传输已经
  承载 info 及以上级别；守护进程 worker 的 stderr 只是 supervisor 在内存中保留的尾部，把 debug
  量级的日志复制过去只会增加噪声，并不会让它落盘。
- 恢复是惰性的：失败至少 30 秒后的第一次日志调用会在日志目录中创建并删除一个小探测文件，
  只有写入成功才打开新的写入端。这不引入定时器或后台任务；探测失败时沿用同一个失败周期。
- stderr 每 10 分钟最多收到一条失败提示；已报告的失败周期结束时再输出一条恢复提示。恢复后的
  文件以一条警告行开头，记录失败时间、错误和丢弃行数。该行数只是下限，因为失败的 stream
  已接收的行同样会丢失。
- `DailyRotateFile` 自身的 `error` 事件报告归档与保留清理失败。这类错误以警告写入仍然可用的
  文件，不会丢弃写入端。

进程级 `uncaughtException` 处理保持不变：其他致命错误仍会退出。本改动只防护已识别的来源，
并且不区分错误码，因为任何文件日志失败都不应终止进程。

## 范围审查

其他同步诊断写入原本就不会抛出：`appendDailyLogSync`（致命与退出 trace）会吞掉所有失败；
事件循环卡顿看门狗包裹了自己的 `appendFileSync`，并通过 logger 报告 `write-failed`；没有 SQLite
存储保存诊断数据；后台守护进程的 stdio 是管道而不是文件。

## 限制

- 前台运行的 `lody start` 如果把 stdout 或 stderr 重定向到写满磁盘上的文件，仍可能因 Node 的
  同步 stdio stream 崩溃。守护进程路径不会这样做。
- `acp-extension-claude` 中未防护的 `CLAUDE_AGENT_LOGS` 写入只在该包的独立二进制中运行，
  CLI 不会启动它。
- 恢复警告写在触发重新打开的那一行之前，但格式化在其之后，因此它的时间戳可能比下一行晚几毫秒。
- issue #1054 的第 2–4 层仍待处理：`statfs` 检测与机器健康状态、针对已分类存储错误的用户提示、
  暂停磁盘密集型工作的降级模式，以及压舱文件。loro-repo 侧由 loro-dev/loro-repo#139 跟踪。
