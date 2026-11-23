# 通过 file URL 导入 DSH adapter

Status: implemented
Translation: current

[English](2026-09-11-dsh-windows-plugin-url.md)

## 摘要

内置 DeepSeek Harness 启动时把 Windows 盘符路径传给 Cordis ACP 插件入口，导致 Node 的 ESM
loader 在 ACP 初始化之前就拒绝 `c:` scheme。Lody 现在在生成 composition 之前用 `pathToFileURL`
转换其内置 adapter 路径。preset 与 session 目录仍是原生文件系统路径。该改动同时保留安装路径中
的字面空格、Unicode、百分号与 URL fragment 字符。

## 决策与归属

内置 adapter 的文件系统位置由宿主拥有；extension profile 会把宿主给出的入口直接序列化进 Cordis
模块名。应在该边界进行转换，而不是修补下载来的官方 loader，也不是手工拼接 `file://` 前缀——后者
会遗漏转义以及 Windows/UNC 语义。既有的内容哈希使修正后的配置获得新文件名，同时不改动运行时的
包固定版本，也不触碰用户设置与会话产物。

这修复了启动兼容性，不改变产品意图。既有的
[设置集成记录](2026-09-08-dsh-settings-provider.md)解释了为什么生成的配置由宿主拥有、手工编辑
不具持久性。

## 验证

归属该逻辑的运行时测试套件新增了一个位于含空格、Unicode、`#` 与 `%` 的目录下的合成 adapter。
测试读取生成的模块 specifier，在独立的 Node 进程中加载该确切值，检查 preset 目录仍是文件系统
路径，并检查重复启动时配置保持稳定。fixture 使用宿主的原生路径，因此同一个测试在 Windows 上会
覆盖盘符路径。原生 Windows 桌面端启动仍待验证。

在 macOS 上，隔离的 Vitest 3.2.4 与固定版本的 extension profile 源码下，全部七个运行时测试通过；
移除 URL 转换会让新的回归测试失败。运行时及其测试的隔离严格 TypeScript 检查、限定范围的 TypeScript
格式化以及 `git diff --check` 均通过。根目录的 `pnpm check` 与 `pnpm format` 曾尝试运行，但在该
checkout 中因缺少工作区依赖与其他 adapter submodule 而无法完成。`pnpm run docs check` 报告了指向
未初始化 Core/Codex submodule 的既有链接；对本记录它不报任何错误。

## 集成

- [Lody PR #599](https://github.com/LodyAI/Lody/pull/599)
