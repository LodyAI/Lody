# 修复 e2e fixture 在 Windows 上的 scripted agent 命令行引号问题

Status: implemented
Translation: current

[English](2026-09-18-windows-scripted-agent-command-quoting.md) | 中文

## 摘要

2026-09-18 的 Daily 是
[cascade 修复记录](2026-09-17-daily-e2e-cascade-and-windows-tags.zh.md)
中 tag 引号修复（#783）之后 Windows 腿第一次真正执行场景，结果 15/22
失败：所有依赖 agent 的 journey 都在等待自定义命令 `Ready` 探测时挂够
60 秒。fixture 生成的命令行允许 Windows 路径不加引号（`\` 在 allowlist
里），但设置对话框用的是 POSIX 风格解析器——无引号的 `\` 会转义下一个
字符——于是 `D:\a\Lody\script.mjs` 被解析成 `D:aLodyscript.mjs`，spawn
的可执行文件不存在。12 份各自复制的 `quoteCommandArgument` 现已收敛到
共享的 `fixtures/command-line.ts`，任何含反斜杠的 token 都会被加引号。
已通过 `pnpm e2e:check` 和新的 tokenizer 往返测试验证；Windows 腿本身
只能等下一次 Daily 证明。

## 证据

- Run 35317896229：7 个不依赖 agent 的纯 UI journey 通过；15 个 agent
  journey 全部挂在 `getByText('/^(Ready|就绪)$/u')` 60 秒超时。
- `scenarios/lody-agent-001/agent-provider-lifecycle-acp.ndjson`
  **0 行**——scripted agent 一个事件都没写，进程根本没启动。
- `cli-backlog.json` 显示 daemon 健康（"Local agent service is
  ready"、mcp-http 在 `127.0.0.1:55438` 服务中）——PROJECT journey
  依赖的 machine RPC 路径是活的，故障被隔离在自定义命令 spawn 上。
- 本地复现：对
  `C:\hostedtoolcache\...\node.exe D:\a\Lody\script.mjs` 调用
  `parseCustomAcpCommandLine` 返回
  `{command: 'C:hostedtoolcachenode.exe', args: ['D:aLodyscript.mjs']}`
  ——每个 `\x` 都被当作 POSIX 转义吃掉。

## 根因

`quoteCommandArgument` 被复制进 12 个 fixture，allowlist
`[A-Za-z0-9_./:\\-]` 让 `\` 和 `:` 不加引号通过——意图是让 Windows
路径可读，但消费方 `parseCustomAcpCommandLine` 会把无引号的反斜杠当
转义符。这个缺陷从 fixture 诞生起就存在，只是 Windows 腿在 #783 之前
从未真正执行过任何场景。

## 修复

- 新增共享 `e2e/src/support/fixtures/command-line.ts`；allowlist 改为
  `[A-Za-z0-9_./:@-]`（同时并入 lifecycle 变体多出来的 `@`）。含
  反斜杠的 token 一律加引号；双引号内解析器把 `\\` 还原为字面
  反斜杠，两个平台上的往返都是精确的。
- 转义集合收窄为 `["\\]`（原为 `["\\$\`]`）：解析器在双引号内只认
  `\"` 和 `\\` 两种转义，给 `$`/反引号加转义反而会在解析结果里
  多出一个字面反斜杠。
- 12 份本地副本全部替换为共享 import，消除了让 lifecycle fixture
  携带不同 regex 的 drift。
- `command-line.test.ts` 用 POSIX tokenizer oracle 固定契约（e2e 包
  无法 import 共享解析器）：Windows 路径产出双反斜杠引号串，完整
  Windows argv 往返不变。

## 验证边界

`pnpm e2e:check` 全绿（套件契约 22 场景、dry-run、tsc、单测）。
Windows 腿只能由下一次 Daily 证明——与 #783 相同的限制：macOS 无法
真实执行 Windows spawn 路径。如果该腿仍然失败，下一批嫌疑是 ACP
stdio 握手或 named pipe 环境变量向孙进程的传递；但 agent 事件日志
为空证明 spawn 失败是第一处断点，那些层当时根本没有走到。
