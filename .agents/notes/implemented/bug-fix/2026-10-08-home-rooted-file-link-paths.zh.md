# 本地文件链接操作中的主目录路径

Status: implemented
Translation: current

[English](2026-10-08-home-rooted-file-link-paths.md)

## 摘要

agent 在聊天中写出的 `~/...` 路径可以正常预览（机器侧预览策略早已展开 `~`），但桌面端的
"在 Finder 中显示"/打开/编辑器操作却以 `not_found` 失败：渲染器把波浪线路径拼到了工作区
根目录上（`<workspace>/~/...`）。现在 `resolveLocalWorkspaceFilePath` 把以主目录为根的路径
视同绝对路径——仅在会话属于本机时按该机器的主目录展开，其他情况保持未解析，绝不会拼到
工作区根目录。`~user` 形式保留原有的工作区相对含义，因为渲染器无法解析其他用户的主目录。
远程会话仍然只提供"复制路径"。

## 决策与依据

报告的失败把 `~/Code/my-spells/better-readme/SKILL.md` 解析成了
`<workspace>/~/Code/my-spells/better-readme/SKILL.md`。两个解析器对同一字符串适用了不同
规则：CLI 预览策略（`apps/cli/src/lib/file-preview/file-preview-path-policy.ts`）按
`os.homedir()` 展开开头的 `~`，而渲染器的 `resolveLocalWorkspaceFilePath` 只区分绝对路径与
工作区相对路径，于是落入了工作区拼接。修复保持这一分工：渲染器解析器新增 `homeDir` 参数
（取自 Electron 探针的 `localHomeDirAtom`，仅当会话机器为本机时传入），并在与绝对路径相同的
`allowExternalPaths` 门槛下展开 `~`、`~/...` 和 `~\...`。非本机目标或主目录未知时返回 null，
于是"复制路径"回退为原始文本，远程也不提供任何 shell 操作。

曾考虑在 `markdown-agent-file-link.ts` 内归一化 `~`，予以否决：该模块负责 Markdown href 解析
（行号后缀、URL 解码、worktree 根），不负责宿主路径身份，且改写存储路径会破坏远程会话的
"复制路径"——查看者并不知道远程机器的主目录。在身份解析时展开可让展示与剪贴板保留原始文本，
只有交给桌面桥的路径被展开。这一修复扩展了
[本地文件链接操作](2026-09-09-local-file-link-actions.zh.md)覆盖的路径形式；意图记录在更新后的
[草案 Spec](../../../../specs/local-file-link-actions.zh.md)。

## 验证

`session-local-file-path.test.ts` 覆盖 POSIX/Windows 主目录展开、单独的 `~`、主目录未知与
远程拒绝，以及 `~user` 的落回行为。`use-session-file-actions.test.tsx` 复现了报告的
Markdown 链接场景（reveal 收到 `/home/dev/...`），并断言远程会话不解析任何路径、按原文复制
`~/...` 文本。Finder 的实际原生行为仍需在真实桌面运行时中验证。
