# macOS Emacs 快捷键跨越已提交提及时的光标导航

Status: implemented
Type: bug-fix
Translation: current

[English](2026-10-27-mention-emacs-caret-navigation.md)

## 摘要

macOS 默认的 Emacs 文本导航键可能让光标停在已提交提及的边界：浏览器逐字符移动后进入原子范围，选区规范化又将光标拉回。现在提及输入框在边界处将 Control+B/F 交给现有的范围感知水平导航。组件测试验证了该行为，Electron 原生键盘事件分发仍需手动确认。

## 决定

在已提交提及的边界，将 macOS 默认的 Emacs 风格文本导航键 Control+B 和 Control+F 分别视为向左和向右移动一个字符，复用左右方向键已有的原子范围导航。远离相邻提及时，以及存在选区或 Shift 修饰键时，保留浏览器默认处理。其他平台的 Control 键行为不变。

按键映射集中在 `getHorizontalCaretMove` 中。macOS 其他默认 Emacs 导航键（Control+A/E/P/N）按行定位，编辑键则会修改文本；这个逐字符边界修复让这些命令继续由浏览器处理，而不会把所有 Control 快捷键都当作方向键。

## 证据

- 报告者观察到，在文件提及末尾按 Control+B 时光标闪烁却不移动，并确认普通左右方向键已经正常工作。对称的 Control+F 故障是根据同一源码路径推断并由组件测试覆盖，尚未在桌面应用中单独观察。
- 此前 `mention-input.tsx` 只拦截方向键事件。原生 Control+B 向左移动一个字符后会进入提及内部，`constrainCaretToMentionBoundary` 随即把光标拉回原边界。这个源码级复现解释了观察到的停滞，同时保留原子编辑规则。
- 组件测试提交一个合成文件提及，检查两个 Control 快捷键、分隔空格、普通方向键、非 macOS 行为和已有选区。jsdom 不实现 macOS 原生 Emacs 键盘导航，因此测试验证的是组件对按键事件的响应，而不是操作系统的键盘事件分发。

## 范围与验证

改动仅涉及共享提及输入框、对应组件测试和提及实现文档；不改变提及的存储、分发或恢复约定。修复后在原生桌面应用中再次复现仍有价值，因为自动化组件测试无法验证 Electron 在 macOS 上的键盘事件映射。
