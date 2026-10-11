# 可选代码语言语法包

Status: implemented
Translation: current

[English](2026-10-01-extended-code-language-pack.md)

## 摘要

现有渲染器只加载一小组 Shiki 和 Monaco 语言，因此较少见但有用的语言会显示为纯文本，或者如果直接加入默认集合就会增加默认包体积。现在客户端将常用语法放在核心层，并在外观设置中提供一个持久化的扩展层开关。扩展语法会在 Markdown 或文件预览第一次使用时加载，Worker 和主线程路径共享同一个 gating。`.v` 的歧义有意留在本次范围之外。

## 决策

- 设置保存在本地，默认关闭，键名为
  `lody-extended-code-languages-enabled`。
- 现有的 JavaScript/TypeScript、JSON、Shell、Markdown、Python、Rust、Go、
  YAML、HTML、CSS，以及常用的 C 系、JVM、Web、数据和配置语言留在核心层。
- 更广泛的语言列表（包括 Lean 和 Coq）放入可选层。`rocq` 是现有 Coq
  语法的 Markdown alias，不是 `.v` 文件名规则。
- 只有在扩展包开启时才识别 MySQL 和 PostgreSQL 标签（`mysql`、`pgsql`、
  `postgres` 和 `postgresql`），并使用核心 SQL 语法，因为当前锁定的 Shiki
  版本没有独立的方言语法。
- 可选 Shiki 语法通过高亮器的 `loadLanguage` 路径加载；可选 Monaco
  basic-language contribution 按语言动态导入。并发加载会去重，失败的加载会
  从缓存中移除，使之后的尝试可以重试。
- Markdown Worker 协议传递同一个开关值。Worker 不存在或失败时，主线程
  fallback 使用相同的开关和按需加载行为。
- 开关关闭时，受 gating 的会话文件扩展名返回 `plaintext`。文件语言映射不
  添加 `.v`，也不猜测 V/Verilog/Rocq。

## 取舍

如果一开始就注册所有语法，每个用户都会承担启动和包体积成本，即使从未遇到
这些语言。若开关打开就立即加载全部可选语法，又会把很大的成本集中到一次设置
交互中。本次选择按需加载，让 opt-in 成本与实际渲染的语言数量相关；设置中的
辅助文案明确说明首次渲染可能变慢。

部分 Shiki 语法没有对应的 Monaco basic-language contribution。它们仍然可以用于
Markdown 围栏；文件预览使用可用的 Monaco 映射，或回退到纯文本。语言服务器、执行
支持、文件图标和有歧义的 `.v` 推断属于后续独立决策。

后续的 `.v` 映射和只读 Coq 文件查看器记录在[后续记录](2026-10-02-coq-file-preview-rendering.zh.md)中；
本记录保留最初语言包实现的范围与取舍。

## 验证

- 聚焦 Vitest 已通过核心/扩展 Worker 请求边界、受 gating 的文件语言识别和
  Markdown 语言解析测试，共 8 个测试。
- 所有改动的源码、测试、Spec 和 Note 文件均通过 Oxfmt 检查。组件类型检查已
  走过本次改动代码，没有发现新的错误；命令仍因当前 checkout 缺少隔离的
  `acp-extension-core` 和 `acp-extension-dsh` 模块，并报告无关的既有 implicit-any
  错误而返回失败。
- 草案契约见[可选扩展代码语言包](../../../../specs/extended-code-language-pack.zh.md)。
