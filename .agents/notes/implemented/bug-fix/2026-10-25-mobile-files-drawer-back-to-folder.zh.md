# 打开文件时保留下方的移动端文件抽屉

Status: implemented
Date: 2026-10-25
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1881
[English](2026-10-25-mobile-files-drawer-back-to-folder.md)

## 摘要

在移动端会话的文件抽屉里打开文件时，代码会先关闭文件抽屉再打开文件查看抽屉，因此从查看页返回会落到对话页，而不是用户刚才浏览的文件夹。现在文件抽屉保持打开，查看抽屉叠在其上方，返回后露出原来的文件夹、滚动位置和面包屑。层级数值没有改动：两者都是同一 `z-50` 层的 Vaul 抽屉，查看抽屉的 portal 总是更晚挂载。手势与叠放仍需真机验证。

## 决策与证据

会话宿主传给文件浏览器的 `onOpenFile` 会在 `handleOpenIndexedFile` 之前调用 `setMobileFilesBrowserOpen(false)`。关闭会卸载文件抽屉内容，`MobileProjectFileBrowser` 因而丢失文件夹层级；即使查看页关闭后重新打开文件抽屉，也只会从根目录开始。浏览器自身的委托约定本来就承诺停留在文件夹层级。

`MobileFileViewerDrawer` 只在内容上设置了 `forceMount`，但 Radix Dialog 的 portal 仅在打开时挂载子节点，所以每次打开查看页都会在已打开的文件抽屉之后追加新的 portal。两者都是 `fixed z-50`，DOM 顺序决定查看页在上。Radix 只关闭最上层，在查看页内点击不会关闭文件抽屉。

未采用：让文件抽屉内容常驻挂载，并在查看页关闭时重新打开文件抽屉。这需要额外的“从文件抽屉打开”标记，避免从对话打开的文件也弹回文件抽屉；一次返回会播放两段滑动动画；而且文件数据源的请求以抽屉打开为前提。

这与 [diff 面板交接](2026-09-28-mobile-diff-file-handoff.zh.md) 有意不同：那个面板位于更高的模态层（80），会盖住查看页；它引用旧的文件抽屉行为只是作为相同模式。

抽屉从 `session-detail.tsx` 移入 `MobileSessionFilesDrawer`，以便测试它与查看抽屉的真实组合。当前背景：[移动端导航栈](../../../docs/ui-mobile.md#stacking)。

## 验证

`tests/mobile-session-files-drawer.test.tsx` 渲染真实的文件抽屉和查看抽屉：进入文件夹、打开文件，然后检查查看页 portal 位于仍打开的文件抽屉之后，返回回到该文件夹，再逐级退出并关闭。若打开文件时先关闭文件抽屉，该测试会失败。边缘滑动顺序（查看页 → 文件夹 → 上级 → 对话）以及重新打开已有查看标签的文件，仍需真机验证。
