# 输入框编辑器：用一个 Lexical contenteditable 取代 textarea 加显示层

Status: implemented
Translation: current

[English](2026-11-10-composer-lexical-editor.md)

## 摘要

共享 composer 原来是一个透明 `<textarea>` 叠在显示层 `<div>` 上：textarea 负责编辑和光标，显示层负责画文字和 mention chip。两者排版只要不同，光标就会落在和正在编辑的字不同的行上。2026-11-10 的报告里，经典滚动条只让 textarea 变窄，于是光标和输入法候选框掉到了文字下面一行。现在所有带 mention 的 composer 都在同一个 Lexical contenteditable 里编辑，文字、光标、选区、输入法预编辑和 chip 都由它自己画。对外模型不变：字符串加 UTF-16 区间，消息格式和草稿也不变。owner 要求用户完全无感知，所以编辑器复刻了 textarea 的外观和编辑语义。没有 mention 来源的 composer 仍保留普通 textarea。已在 Chromium、WebKit、Electron 应用，以及 iOS 和 Android 模拟器的系统中文输入法上验证。

## 问题

可见的文字和光标属于两套排版。要正确，两者必须在每个换行点都一致，而这无法保证：滚动条、小数缩放、字体回退、chip 宽度和输入法预编辑都会让它们错开。同类 bug 已经上线过几次：#1128 和 #1140（菜单不在光标处）、#2366（chip 边缘的光标和颜色），以及输入法光标吸附那次修复。菜单定位还得另做一个离屏克隆，只为找到光标位置。

在 textarea 版本上实测：三行高的 composer 放中英混排长文本，显示滚动条。点一个看得见的字再输入，字会落在 8–28 个字符之外，400 到 720px 的每个宽度都这样。`tests/e2e/composer-editor.spec.ts` 里的 "a click on a visible glyph puts the caret there" 固定了这个现象：在 textarea 上失败，在编辑器上通过。

## 决定

- **编辑器**：Lexical core、`@lexical/plain-text`、`@lexical/history`，精确锁定 0.53.0，不用 `@lexical/react`。chip 通过 portal 渲染进各自装饰节点的 DOM。
- **文档结构**：一个段落，由文本节点、换行节点和 `MentionDecoratorNode` 组成。mention 节点的文本内容正好是它的区间所覆盖的文字。`ui/mention/composer-document.ts` 是唯一计算偏移量的地方，负责 `{text, mentions}` 与 Lexical 位置（包括实时 DOM 位置）之间的换算。
- **对外模型不变**：调用方仍持有字符串和区间。调用方的值与文档不同时就重建文档；就像给 textarea 赋值一样，光标随后到末尾，除非组件自身要求了特定光标；编辑器自带的撤销历史也随之清空，所以发送后被清空的草稿不能被撤销找回。写入的值成为下一次编辑撤销回去的基准：Lexical 清空历史时也会丢掉当前状态，曾导致提交 chip 之后输入的文字无法撤销。组字期间不写入调用方的值；调用方只在组字提交后才收到文字。
- **编辑逻辑保留**：方向键跨 chip、Backspace/Delete 规则、菜单按键、触发符、历史快照和所有插入路径，都还是原来的字符串运算，没有改动。
- **事件处理顺序**：调用方的 `onKeyDown`、`onPaste`、`onCopy`、`onCut`、`onBeforeInput` 先于 Lexical 执行；它们调用 `preventDefault` 时，跳过 Lexical 的默认处理。脚本派发的输入事件不会改动内容，和 textarea 一样。
- **元素与接口**：ref 仍是一个 DOM 元素，即编辑器的 `div`。文字、光标和几何信息通过 `ui/mention/composer-input.ts` 读写，它同时支持编辑器和普通 textarea；因此 focus、`closest`、floating-ui 锚定和 `activeElement` 判断都还是普通 DOM 操作。
- **与 textarea 对齐**：
  - CSS 给它 textarea 的 UA 盒模型：inline-block、pre-wrap、`overflow: auto`。
  - 高度为 `rows` 行加内边距，工具类仍可覆盖尺寸。
  - 调用方的 `placeholder:` 工具类通过 `tailwind/index.css` 里的 `placeholder` 变体，同样作用于编辑器的占位符。没有这类工具类时，从一个样式相同的 textarea 复制浏览器默认的占位符颜色。WebKit 读不到 `::placeholder` 的样式，所以在 WebKit 上不复制，使用 CSS 默认值。
  - 渲染 chip 的地方关闭拼写检查，选区用系统颜色，和显示层时期一样。
  - 程序或键盘聚焦保留原光标，指针聚焦按点击位置放光标。
  - 首次内容在元素挂载时写入，所以父组件的 layout effect 量到的是已填好内容的编辑器，和 textarea 一样。
  - 去掉 Lexical 设置的行内 `word-break: break-word`，保持 textarea 的换行规则。
- **光标来源**：光标以 Lexical 的选区状态为准。只有在 Lexical 放行了一次 keydown、且它尚未更新之前，才读取实时 DOM 选区。这样快速连按时光标不过期，也不依赖那些聚焦时会把 DOM 光标折叠到开头的引擎（jsdom 就会）。组字状态同时跟随 DOM 组字事件和 Lexical 自己的标记。
- **菜单锚点**：锚点取编辑器上的 DOM range，按元素行网格对齐，并随 transform 和 zoom 缩放。测量不插入任何 DOM。

## 其他方案

- **给显示层打补丁（补上滚动条宽度）**：修好了报告的那一种情况，但 owner 否决了，因为同类 bug 还会再出。
- **ProseMirror 或 Tiptap**：ProseMirror 能力相当，选 Lexical 是因为 iOS 已经在用 Lexical 模型，且 owner 同意。Tiptap 多了一层这个纯文本 composer 用不上的富文本抽象。
- **做一个形似 `textarea` 的 ref 外壳**：这是隐藏的兜底，否决；调用方改用显式的元素接口。
- **所有 composer 都用编辑器，包括没有 mention 来源的**：否决。它们的普通 textarea 没有显示层、也没有这个 bug，保留它是唯一能做到外观完全一致的做法。

## 影响

- **已删除**：`mention-highlighter.tsx`、光标克隆、issue 悬浮提示的 textarea 几何计算，以及没有调用方的 `FileAtMentionTextarea`。textarea 高度测量只保留给普通 textarea 路径。
- **测试**：
  - jsdom 测试借助 `tests/composer-test-utils.ts` 驱动真实编辑器。
  - 浏览器测试用 `tests/e2e/composer-text.ts` 读取文字。
  - `tests/setup.ts` 为 jsdom 补上了它缺少的零尺寸 Range 几何信息。
- **chip**：仍保持原文字的字符宽度（`mention-chips.tsx`），所以草稿换行和外观都和以前一样。
- **富文本**：网页端暂不提供；有了这个编辑器，以后可以在不改调用方模型的前提下加上。

## 验证

- **转换层**：`tests/composer-document.test.ts` 覆盖往返转换、区间清理和偏移量/DOM 映射。
- **行为**：`tests/e2e/composer-editor.spec.ts` 覆盖打字、换行、chip、方向键、Backspace/Delete、点击 chip、撤销重做（包括调用方清空之后，以及编辑器自带撤销下提交 chip 之后）、粘贴、CDP 模拟输入法（包括紧贴 chip 组字）、无障碍，以及内容溢出时光标落在字上。它在 textarea 版本上除光标落字那条外全部通过，在编辑器上全部通过。
- **现有测试套件**：composer 相关的 vitest 套件，以及 `composer-mention-placement`、`message-quotes`、`composer-submission-focus`、`interface-typography`，除了同一环境下在 textarea 版本上也失败的用例，没有新增失败。
- **WebKit**：同一套测试可在 Playwright WebKit 下运行（`LODY_E2E_BROWSER=webkit`），剪贴板和 CDP 输入法几条只适用于 Chromium。占位符那条在“从 `::placeholder` 查询复制颜色”的版本上会在 WebKit 失败。
- **设备（2026-11-11）**：
  - iOS Safari 配系统拼音键盘：中英混排、组字期间不写入调用方、紧贴 chip 组字、方向键跨 chip 和删除 chip、撤销（包括清空之后）、粘贴、换行、占位符颜色、两个宽度下的点击落光标、用选择手柄跨 chip 选择均通过。
  - Android Chrome 配 Gboard：拼音输入、点击落光标、mention 菜单、删除 chip、换行、粘贴、长按跨 chip 选择均通过。
  - Electron 应用的聊天输入框：紧贴 chip 拼音组字、方向键跨 chip 和删除 chip、溢出时点击落光标、mention 菜单、发送后不能撤销找回、发出的消息及其 mention 显示均通过。
- **尚未验证**：Electron 里 macOS 自带拼音（自动化输入落成拉丁字母；第三方拼音输入法通过）、iOS 上仅靠长按开始的选择、iPhone 横屏，以及在 Electron 应用里复测提交 chip 之后的撤销（上面的测试覆盖同一代码路径）。纯文本 composer 没有改动。
