# 可选扩展代码语言包

Status: draft
Translation: current

[English](extended-code-language-pack.md)

## 摘要

Lody 将一组常用语法放在默认渲染路径中，并在外观设置里提供本地的“扩展代码语言”选项。该选项默认关闭，作用于 Markdown 代码块和会话文件预览。开启后，扩展语法只会在对应语言第一次使用时加载，因此首次渲染可能变慢，之后会复用已经加载的语法。优先使用 Worker 渲染；在 Worker 不可用的环境中使用同一开关控制的主线程 fallback。

## 场景与范围

用户因为对话或项目中出现默认集合之外的语言，在外观设置中开启“扩展代码语言”。之后 Markdown 围栏和文件预览会识别可选语言。关闭选项后，这些可选语言再次按纯文本显示，不会改变源内容或本地文件数据。

这个偏好保存在当前客户端本地，重启后保留，默认值为关闭。扩展包只改变语法识别，不增加语言服务器、格式化器、执行能力或文件图标。

## 语言分层

默认层包含已有的 JavaScript/TypeScript、JSON、Shell、Markdown、Python、Rust、Go、YAML、HTML 和 CSS，同时加入常用的 C 系、JVM、系统、Web、数据及配置语法：C、C++、C#、Java、Kotlin、Swift、Ruby、PHP、SQL、GraphQL、TOML、XML 和 Dockerfile。

可选层包含 Dart、MDX、Lua、MySQL、Objective-C、Perl、PostgreSQL、PowerShell、Batch、Fish、SCSS、Less、HCL、Protobuf、Vue、Svelte、Astro、Elixir、Erlang、Clojure、Scala、Haskell、OCaml、F#、Julia、R、Solidity、Zig、WGSL、GLSL、LaTeX、CMake、Nginx、Make、Lean 和 Coq。MySQL 和 PostgreSQL 标签（`mysql`、`pgsql` 和 `postgresql`）使用默认层的 SQL 语法。Markdown 中的 `rocq` 会映射到 Coq 语法，`lean4` 会映射到 Lean 语法。

扩展包开启后，`.v` 和 `.rocq` 文件统一按 Coq 处理，并使用显式的
Shiki `coq` 语法渲染。Lody 不保留 V 或 Verilog 的解释；扩展包关闭时这些
文件显示为纯文本。只读的 Coq 和 Lean 文件预览使用 Shiki，因为 Monaco 没有
对应的 basic-language contribution；可编辑的 provider 文件仍使用 Monaco，因而
编辑时这些语言显示为纯文本。`.v` 文件使用中性的代码图标，不显示 Vlang 专属图标。

## 渲染行为

Shiki 高亮器启动时只加载默认层。启用扩展后，某种可选语法会在第一次对该语言进行 Markdown token 化前加载，并在同一个高亮器的后续请求中复用。会话文件预览保持默认 Monaco contribution 静态加载，只为当前选中的语言动态导入可选 contribution；如果可选 Monaco contribution 加载失败，预览回退到纯文本。

共享 Worker 收到的请求带有同一个设置值。Worker 失败或不可用时使用主线程高亮器，主线程同样执行语言 gating 和按需加载。选项关闭时，或语言不属于任一层时，使用纯文本 fallback。Markdown 支持完整的 Shiki 列表；文件预览使用会话文件语言映射中注册的可选扩展名，并在有对应实现时使用最接近的静态 Monaco 语法。没有 Monaco contribution 的语言使用显式的 Shiki 只读查看器。

## 证据

- 实现：[语言分层](../packages/components/src/lib/markdown-highlighter.ts)、[Markdown 语言解析](../packages/components/src/components/ai-gui/markdown-code-highlight.ts)、[Monaco 语言加载](../packages/components/src/lib/session-monaco-languages.ts) 和 [外观设置](../packages/components/src/components/settings/appearance-setting.tsx)。
- 文件语言边界：[会话文件语言映射](../packages/components/src/lib/session-file-language.ts)。
- Coq 文件预览：[Shiki 文件查看器](../packages/components/src/components/sessions/session-shiki-text-viewer.tsx)。
- 验证：[会话文件语言测试](../packages/components/tests/session-file-language.test.ts)、[Markdown 语言测试](../packages/components/tests/markdown-code-highlight.test.ts) 和 [高亮 Worker 客户端测试](../packages/components/tests/markdown-highlight-client.test.ts)。
- 决策记录：[扩展语言包记录](../.agents/notes/implemented/feature/2026-10-01-extended-code-language-pack.zh.md)和[Coq 文件预览后续记录](../.agents/notes/implemented/feature/2026-10-02-coq-file-preview-rendering.zh.md)。
