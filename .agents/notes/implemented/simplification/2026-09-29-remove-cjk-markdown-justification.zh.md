# 移除会话 Markdown 中文段落的两端对齐

Status: implemented
Translation: current

[English](2026-09-29-remove-cjk-markdown-justification.md)

## 摘要

会话段落只要含有汉字就会触发两端对齐，导致中英混排回复的字距被拉开。现在会话正文在流式输出期间和完成后都保持起始边对齐，让文字到达时对齐方式稳定一致。这样会放弃中文段落整齐的右边缘，以换取聊天内容中更均匀的字距。此前的设计理由保留在[中文排版决策记录](../feature/2026-09-28-cjk-markdown-justification.zh.md)中。

## 决策

会话是实时更新的混合文字阅读界面，而不是固定版心的出版页面。起始边对齐避免为填满每行而拉伸汉字间距或英文词间空格，也不需要在 Streamdown 将完成回复交给静态渲染器时再次排版。渲染器不再检测汉字来决定对齐方式；共享样式明确将顶层段落对齐到起始边。

## 验证与限制

- 对齐规范见[会话 Markdown 对齐方式](../../../../specs/conversation-markdown-alignment.zh.md)。
- `git diff --check` 通过。`pnpm run docs check` 因无关 note 中存在 62 个指向缺失隔离 package workspace 的旧链接而返回失败；本次文件未报告错误。未运行渲染器检查。
