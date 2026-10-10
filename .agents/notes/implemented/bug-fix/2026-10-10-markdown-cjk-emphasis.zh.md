# 在标记边界解析 CJK Markdown 强调

Status: implemented
Translation: current

[English](2026-10-10-markdown-cjk-emphasis.md)

PR: [#1375](https://github.com/LodyAI/Lody/pull/1375)

## 摘要

中文粗体句子以标点结尾且结束标记紧贴下一句时，可能显示为字面 Markdown。
渲染器已经为解析出的粗体设置样式，问题在于 CommonMark 边界规则阻止了粗体
节点的生成。渲染器和搜索提取现在共同采用 CJK 强调解析，使流式正文、完成后的
正文和高亮偏移保持一致。代码和转义标记仍是字面文本，GFM 删除线不在本次范围内。

## 证据与决策

用 remark-parse 解析合成示例 `**检查完成。**接着执行下一步。` 只产生文本节点。
独立的一句，包括外面加中文引号的版本，本来就能产生粗体节点。失败的形式在结束
标记前紧贴标点、后紧贴文字，参见 [CommonMark 强调规则](https://spec.commonmark.org/0.31.2/#emphasis-and-strong-emphasis)。

在渲染器共用插件列表与搜索解析器中，均在 GFM 后接入
`remark-cjk-friendly/parseOnly` 2.3.1。其解析器扩展遵循 Markdown 的代码、转义和
嵌套语法，无需改写原文。只解析入口避免加载序列化扩展。上游提供
[CJK 边界扩展说明](https://github.com/tats-u/markdown-cjk-friendly/tree/main/packages/remark-cjk-friendly)。
这补充了[流式渲染器决策](../feature/2026-09-26-lobehub-streamdown.zh.md)，并保留
[搜索文本一致性决策](2026-10-07-session-search-literal-punctuation.zh.md)。

在标记周围加空格可以手工绕过问题，但会改变原文，也无法处理无法预先监督的
生成回复。直接用正则替换原文则需要重复实现代码、转义和嵌套行内解析规则。

## 验证

现有渲染器测试覆盖两端标点边界、粗体和斜体、代码及转义字面文本、非 CJK
边界，以及流式到完成的切换。搜索测试覆盖正文提取和跨节点高亮偏移。
[规范](../../../../specs/markdown-cjk-emphasis.zh.md)仍为 draft。

渲染器、搜索和大纲预览三个测试套件的 87 项测试全部通过。修改源码的 lint 和
格式检查、组件类型检查和公共边界检查通过。
文档检查报告 6 个指向未初始化的隔离 Kimi/Pi 子模块的已有断链，
本主题没有验证错误。准备完成工作区后重新运行了根检查。全仓类型检查和 lint
通过；测试阶段报告未修改的 CLI `roost-session-backend-contract.test.ts`
签名前缀恢复用例超过 30 秒。初次提交补丁时，其余测试套件仍在运行。
