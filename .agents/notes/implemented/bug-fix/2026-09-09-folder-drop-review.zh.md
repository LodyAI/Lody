# 保留每一个拖入的目录 mention

Status: implemented
Translation: current

[English](2026-09-09-folder-drop-review.md)

## 摘要

一次拖入多个文件夹可能覆盖先前的插入，因为每次插入都在 React 重新渲染之前读取了同一个受控
textarea 的值。输入框现在提交单一批次，一次性产出完整文本与已提交的区间。路径归一化与插入也
会保留 POSIX 与 Windows 盘符根路径。审阅中另一条「preload 缺少 path 桥接」的结论不适用于锁定的
toolkit 版本；无需额外暴露 preload 能力。

## 证据与决策

[PR #312](https://github.com/LodyAI/Lody/pull/312) 有三条审阅结论：

- 多文件夹：在既有 mention 之后连续同步插入两次即可复现，文本中只保留了第二个新文件夹。落地页
  与会话内的拖放处理器现在都只调用一次 `insertPathMentions`；共享原语接受一个批次，并针对逐次
  产出的文本/区间结果依次应用其 splice。它只更新一次受控文本与最终光标位置，并保留既有区间。
  逐文件夹 flush 或安排重渲染都没有必要。
- 文件系统根：复现了 `/` 被拒绝、`C:/` 变成盘符相对路径 `C:` 的问题。共享归一化器会保留根路径，
  插入逻辑复用它，而不是再次剥离斜杠。当归一化后的根路径已以斜杠结尾时，目录区间负载不再追加
  一个斜杠。
- 缺少桥接：lockfile 把 `@electron-toolkit/preload` 解析为 `3.0.2`。它随包提供的
  `electronAPI.webUtils.getPathForFile` 封装了 Electron 的原生方法，而
  `apps/electron/src/preload/index.ts` 在 context isolation 的两个分支中都暴露了该对象。再加一个
  桥接只会重复既有 API。

产品意图仍是绝对路径的目录 mention，普通文件继续作为附件，浏览器/移动端不可用的路径继续忽略。
本次不引入任何云端或 IPC 能力变更。

## 验证

回归测试复现了最初的多文件夹与根路径失败。输入框的覆盖检查了全部插入文本/区间、既有区间、含空格
的路径、聚焦与最终光标位置，以及空批次。归一化覆盖 POSIX 与 Windows 根路径。原生拖放尚未人工
验证。

验证结果：21 个相关 Vitest 文件 / 202 个测试通过；组件类型检查、对改动源码与测试的类型感知 lint、
格式化与文档检查均通过。根目录的 `pnpm check` 在 CLI 类型检查处中止，因为缺少 Claude、Codex 与
Grok 的 submodule checkout；其后续阶段未被执行。
