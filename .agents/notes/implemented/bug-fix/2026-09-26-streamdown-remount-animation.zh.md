# 会话切换时立即显示已有的流式文本

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1021

[English](2026-09-26-streamdown-remount-animation.md)

## 摘要

切回仍在生成回复的 Session 时，Markdown 行会重新挂载。`@lobehub/streamdown`
把行里已有的文字当成刚生成的内容，重播首次淡入动画。现在渲染器通过一个小型依赖补丁，
让挂载前已有的文字立即显示，后续新增文字仍按原方式动画。补丁绑定当前依赖版本；
上游提供相同行为后应移除。

## 问题与决定

[Streamdown 集成](../feature/2026-09-26-lobehub-streamdown.zh.md)让未完成的回合
使用流式引擎。切换 Session 或 Virtua 重新挂载行时，即使消息已有内容，也会创建新的引擎实例。
首次渲染会给现有尾部文字分配新的动画时间。

渲染器传入 `animateOnMount={false}`。针对 `@lobehub/streamdown@1.4.0` 的补丁
在首次渲染时将完整区块标记为已稳定，并将未闭合尾部已经渲染的字符标记为已呈现。
它在现有 rehype 处理中计算实际显示的字符，因此 Markdown 语法字符不会使边界错位。
之后新增的文字仍得到正常的动画时间，保留平滑输出和淡入。其他调用者的默认值仍为
`true`。

## 权衡与验证

流式行挂载时首次看到的内容会立即出现；后续内容才开始动画。依赖升级时需要维护补丁，
但修复留在负责字符动画时间的位置。跨 Session 切换保留整个 React 树也能避免重播，
但会增加内存和渲染成本。

Markdown 渲染器测试覆盖已有文字立即显示，以及后续文字的动画。冻结锁文件安装确认
补丁可应用。桌面应用中的视觉验证仍待完成。
