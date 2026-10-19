# Git transport 的 exec-path 探测不得阻断会话启动

Status: implemented
Translation: current

[English](2026-10-14-git-transport-exec-path-probe.md)

## 摘要

在 managed GitHub 会话上启动对话时，agent 尚未启动就可能以
`turn_pre_prompt_failed` 失败，原始错误为 `spawnSync /usr/bin/git
EAGAIN`。`ensureGitHubGitTransport` 在每次会话准备时同步执行一次 `git
--exec-path` 探测，一次瞬时 fork 失败就会终结整个 turn。现在探测结果被记录到
shim 目录下的 `lody-git-transport.json` 标记中：标记匹配时完全跳过探测；仍需要
探测时，对瞬时 spawn 错误（`EAGAIN`/`EBUSY`/`ETXTBSY`/`ENOMEM`）做有界退避重试并
加 10 秒超时；探测仍失败时回退到任何可用的已记录布局。只有在没有已记录布局且
探测持续失败时才抛出——连 fork 都做不了的机器同样也起不了 agent。

## 证据

- `prepareGitHubRepoSessionConfig` → `ensureGhShimSessionEnv` →
  `ensureGhShimScript` → `ensureGitHubGitTransport` 在会话创建内部同步执行
  `execFileSync(realGit, ['--exec-path'])`。抛出的 `spawnSync <git> EAGAIN`
  作为非 ACP 错误进入 `recordPrePromptFailure`，在 `promptStarted` 之前被记为
  `turn_pre_prompt_failed`。
- 探测仅有的两个产出——`execPath` 和 `nativeGit`——是被解析出的 Git 安装的常量。
  每个会话重查一次只是在每次启动对话时多加了一次同步 fork（以及事件循环停顿）。
- 生成的 adapter 对给定 `(realGit, statePath)` 是确定性内容；`writeIfChanged`
  每次调用都会重新物化，因此只跳过探测不会钉住过期的 adapter 代码。

## 决策

标记记录 `{version, realGit, statePath, execPath, nativeGit}`，且只在完整物化
之后最后写入。当记录的 `execPath` 仍存在且 `nativeGit` 仍可执行时标记可用；
`realGit`+`statePath` 完全匹配则跳过探测。探测本身对瞬时 spawn 错误码以 100ms
`Atomics.wait` 退避重试四次——与 `code-collab-v2-service.ts` 已有的瞬时分类一致——
并以 10 秒超时兜底，防止卡死的 Git 拖住 daemon 事件循环，对齐 `git-identity.ts`
中 `git config` 超时的先例。不完全匹配但仍可用的标记在探测失败时仍是应急布局
来源：其中记录的 Git 仍是可用的 Git，用它生成相同的 adapter 好过因瞬时错误让
启动失败。

## 备选方案

- **只重试**：只要压力长于退避窗口，启动仍会失败；而且每个会话的同步 fork
  本就不必要。
- **只做进程级缓存**：跨不过 daemon 重启；标记把布局持久化，而重复会话恰恰
  主要发生在重启之后。
- **降级为不带 transport 的原生 Git**：生成的 adapter 负责凭证策略选择
  （managed 与 local 回退、读/写分类、advertisement 校验）。不带它们启动会
  静默削弱该策略，因此在完全无法确定布局时代码保持 fail-closed。

## 验证与限制

- `github-git-transport.test.ts` 新增六个用例：标记内容、匹配标记时跳过探测、
  瞬时重试后成功、`ENOENT` 不重试、无记录时抛出、以及旧标记回退并告警。全部
  通过；`gh-shim-script.test.ts` 与 `worktree-manager-broker-auth.test.ts`
  保持绿色。
- 既有的 `clones recursive native SSH submodules` 用例在本环境下于基线提交上
  同样失败（`context_unreadable`），与本改动无关。
- 首次探测无法运行且不存在标记时，daemon 仍会令启动失败；那种状态下 ACP
  进程同样起不来，提前抛出保留了诚实的错误。
- `git-identity.ts` 的 `readGitConfig` 做同样的同步 Git 调用，但已吞掉失败，
  无需改动。
