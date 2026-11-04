# 粘贴达到 50,000 字符时转为文件

Status: implemented
Translation: current

[English](2026-10-12-paste-file-character-threshold.md)

## 摘要

原来的 500 KiB UTF-8 阈值让大量粘贴文本仍嵌入草稿和提示词。按用户要求，现在统一换行并去掉首尾空白后，达到 50,000 字符即触发转换。新对话和已有对话输入框共用此判断，将原始剪贴板文本完整保存在 `pasted-text.txt` 中。更短的粘贴继续使用原有行内或折叠行为。

## 决定与验证

本次替换[超大粘贴附件记录](2026-09-28-oversized-paste-text-file.zh.md)中的大小判断。计数复用 JavaScript 字符串长度：普通汉字和 ASCII 计数相同；补充 Unicode 字符占两个 UTF-16 代码单元。附件校验和发送沿用现有路径。

更新后的 helper 测试覆盖 ASCII 和中文的 49,999、50,000、50,001 字符，以及空白和 CRLF 归一化。更新后的会话渲染测试检查 50,000 字符时附件内容完整，49,999 字符时继续折叠。打包应用中的真实剪贴板行为尚未验证。

已执行验证：借用现有依赖环境后，helper 测试全部 23 项通过。该环境提供 Effect v3，而本工作区需要 v4，导致渲染测试无法收集（缺少 `Context.Service`）。文档检查报告现有未初始化子模块的链接错误，未涉及本次修改的文档。格式化及 `git diff --check` 通过。

PR: [#1511](https://github.com/LodyAI/Lody/pull/1511)
