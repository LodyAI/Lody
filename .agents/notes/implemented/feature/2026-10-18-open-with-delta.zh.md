# 使用 Delta 打开

Status: implemented
Translation: current

[English](2026-10-18-open-with-delta.md)

## 摘要

此前，在 Delta 中审查 Lody 会话需要复制工作树路径，或配置自定义启动方式。现在，Delta 是内置的桌面启动方式，通过 `delta open <path>` 打开对应路径。实现复用现有的本地路径解析、可执行文件探测和原生启动桥接。与 Zed 一样，这里假设 Delta 及其 CLI 已安装可用，不增加安装流程。

## 决策与限制

启动时将 `open` 和解析后的路径作为独立参数传递，保留路径中的空格和 Shell 字符。持久化标识为 `delta`，设置中复用其他启动方式的通用说明。图标采用 [Delta 官方标志](https://delta.dev/favicon.svg)，与 Zed 一样通过 `currentColor` 适配主题。

仅使用自定义启动方式可以减少内置选项，但每个用户都要自行配置。单独建立 Delta 执行服务会重复已有桌面边界，因此这里只增加一项命令定义。可用性复用现有 PATH 可执行文件探测，不区分其他同名 `delta` 程序；用户需确保 PATH 中的命令来自 Delta 应用。实际启动应用仍需人工验证。

相关的[文件操作决策](2026-09-17-markdown-file-link-context-menu.zh.md)负责共享原生操作边界；本次增加不改变该边界，也不改变 Lody 的差异查看器。参见 [Issue #1687](https://github.com/LodyAI/Lody/issues/1687)。

## 验证

现有启动方式测试覆盖桌面可用性、浏览器排除、偏好解析，以及含空格和 Shell 字符的命令参数。设置测试检查所选 Delta 的名称、图标和通用说明。这两个测试套件的 24 项测试及 components 类型检查全部通过。格式、翻译、文档及仓库边界检查通过。完整的 `pnpm check` 在 ACP 适配器准备阶段因无关运行时依赖未安装而停止；尚未验证实际启动 Delta 窗口。
