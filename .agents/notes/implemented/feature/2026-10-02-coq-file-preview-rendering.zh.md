# Coq 文件在只读预览中使用显式 Shiki 渲染

Status: implemented
Translation: current

[English](2026-10-02-coq-file-preview-rendering.md)

## 摘要

此前扩展语言包只在 Markdown 围栏中识别 Coq；文件查看器使用 Monaco，无法区分
Rocq、V 或 Verilog，因此 `.v` 仍显示为纯文本。现在扩展包开启后，文件语言映射
将 `.v` 和 `.rocq` 分配给 Coq，只读文件预览向 Shiki 查看器显式传入
`lang: 'coq'`。可编辑的 provider 文件继续使用 Monaco；由于 Coq 和 Lean 没有
Monaco basic-language contribution，编辑时保持纯文本。

## 决策

- 扩展语言包开启时统一将 `.v` 视为 Coq；客户端路径不再保留 Vlang 或 Verilog
  候选。
- `.v`、`.rocq`、`.coq` 和 `.lean` 的文件语言识别沿用现有本地扩展语言开关。
- Coq 和 Lean 的只读文件使用 Shiki 查看器，并显式传入语言，避免 `.v` 被文件名
  推断为 Verilog。
- `.v` 文件使用中性的代码图标，不显示 Vlang 专属图标，因为客户端将其分配给 Coq。
- 可编辑 provider 文件继续使用现有 Monaco surface。对于没有已注册 contribution
  的语言，向 Monaco 传入 `plaintext`，保持可编辑能力，不宣称支持不存在的语法。
- 移动端文件浏览器同样使用 Shiki 查看器，并沿用共享的换行和 VS Code 主题设置。

## 证据与限制

映射位于[session-file-language.ts](../../../../packages/components/src/lib/session-file-language.ts)，
查看器位于[session-shiki-text-viewer.tsx](../../../../packages/components/src/components/sessions/session-shiki-text-viewer.tsx)。
桌面会话 surface 和移动端项目文件浏览器只对只读的 Coq 或 Lean 文本选择该查看器。
大文件分页预览仍是有界的纯文本 surface，Coq 语言服务和编辑支持不在本决策中。

早期语言包实现记录了 `.v` 歧义暂不处理；该历史记录保持原样。本记录描述后来为
当前客户端明确指定文件映射的决定。

## 验证

- `session-file-language.test.ts` 确认关闭扩展包时 `.v` 为纯文本，开启后解析为
  Shiki 的 Coq，并且不会分类为 Vlang。
- 聚焦的文件语言 Vitest 测试已通过。
- 组件类型检查已走过改动文件，没有新增错误；完整命令仍因缺少隔离的
  `acp-extension-core`、`acp-extension-dsh` 模块及既有无关 implicit-`any` 错误而失败。
