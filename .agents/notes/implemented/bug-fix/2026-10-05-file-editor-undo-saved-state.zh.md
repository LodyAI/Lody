# 文件编辑器撤销回已保存文本时清除 dirty 状态

Status: implemented
Translation: current

[English](./2026-10-05-file-editor-undo-saved-state.md)

## 摘要

文件编辑器将每次已接受的文本事件都视为未保存修改，即使撤销已经恢复已保存文本。保存 hook 现在维护完整文本基线，编辑器回到该基线时清除待保存缓冲区。工具栏、文件标签状态和离开保护共同使用同一保存状态。保存进行中、保存失败及未解决冲突仍保护草稿；验证使用合成存储与真实 Chromium/Monaco，不等同于打包桌面的验收。

## 决策与证据

在基线 `11734261b5a03f914df20aa5f1f9827afd675bb9` 上，真实 Monaco 通过 Cmd+Z 将合成 `qa-marker.txt` 恢复为 `QA_STARTED_20261004`，但 Unsaved 仍显示、Save 可用、Refresh 禁用。原有七项保存 hook 测试全部通过，却没有覆盖该操作。这证明当前分支存在缺陷，不代表已经建立其他线上构建与该修订的对应关系。

`useCodeCollabSaveText` 维护已保存基线、最新草稿和正在写入的文本。已接受的打开/刷新快照与外部应用建立基线，成功保存以返回文本推进基线。完整字符串比较避免将哈希碰撞或撤销栈版本误作文本相等的证据。编辑器首个事件的忽略规则仍仅处理初始化。独立的 provider 打开保护现在跟随同一 dirty 状态，干净撤销不会继续阻止后续读取。

保存进行中撤销仍保留 pending：如果用户回到 A 后 B 才保存完成，现有显式保存流程会随后写入 A。失败不会推进基线，也不会仅因请求结束就释放保护。检测到外部冲突后旧基线失效，恢复旧打开文本不能消除冲突。冲突标记仍是待保存的编辑器内容；覆盖解决冲突时采用 provider 实际解决的文本，不假设更新的编辑也已保存。

代次标记隔离文件切换（包括 A → 其他文件 → A）和已接受外部替换前的异步保存与冲突解决结果。provider 身份变化本身不重置状态，因为同一文件编辑或保存期间也会重建 provider。这些决策保留[外部快照重挂保护](./2026-09-11-file-preview-replays-stale-snapshot.zh.md)。

## 验证与限制

所属 hook 和组件测试覆盖撤销/重做、成功保存的新基线、撤销期间保存成功/失败、回到正在保存文本的修改合并、失败重试、外部替换、文件切换及冲突保护。组件测试还检查原生源码编辑后回到 provider 外部保存文本。测试使用可控 Promise 和合成内容。

Storybook 回归使用生产文件视图、保存 hook 和真实 Monaco 撤销栈，只有存储在内存中。Chromium 交互检查初始 A、编辑 B、撤销 A、重做 B、保存 B、撤销到此时未保存的 A、重做 B、Refresh，以及真实 beforeunload 否决。取消浏览器关闭确认后草稿仍保留。截图随交付提供，不提交到源码。父文件标签的 dirty 回调已测试；完整 Session 关闭确认对话框、打包 Electron、磁盘 RPC 和线上构建不在此夹具覆盖范围内。

四项相关测试套件共 74 项通过，Chromium 键盘回归一项通过。`pnpm format` 与 `pnpm run docs check` 通过，没有相关的 SHA 保护主题。Node 26.10.0 下完整 `NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm check` 通过，包括全部 4,774 项组件测试与 199 项 Electron 单元测试；所属套件仍跳过七项既有 CLI/RPC 测试。进程参数仅在验证时关闭 Node 的实验性 Web Storage。不加该参数时 Node 26 上一项未修改的 boot-shell 测试失败；隔离 Node 22.14 下该测试与相关套件共 93 项通过，但完整检查遇到既有 shared WASM 导入失败。没有修改无关源码或系统运行时。产品布局、文案、权限、保存协议和部署均不改变。
