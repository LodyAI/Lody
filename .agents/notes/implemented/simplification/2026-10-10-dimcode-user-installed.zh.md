# 内置 Dimcode 改用用户安装的命令

Status: implemented
Translation: current

[English](2026-10-10-dimcode-user-installed.md)

## 摘要

内置 Dimcode 原先下载固定 npm 包，由 Lody 负责版本。现在改为与 Bub 一样启动用户安装的
`dimcode acp`，兼容性和升级由用户管理。缺少命令时 setup 失败并显示可复制的 `npm install -g dimcode`，不下载备用
运行时。这会共用用户的 Dimcode 配置和状态，并非私有运行时隔离方案。

## 决策

本次替代[原接入决策](../feature/2026-09-22-dimcode-builtin-acp.zh.md)中的运行时选择；
当前意图由 [Spec 草案](../../../../specs/dimcode-builtin-acp.zh.md)定义。
曾考虑私有托管产物，但它仍由 Lody 负责版本；本次选择复用用户安装的 CLI。
Provider 标识、旧 npm 缓存和历史 Registry 启动契约保持不变。

能力来源标识改为 `builtin-dimcode:local-acp`，使旧固定版本缓存失效。后续用户升级后，
与 Bub 一样显式刷新能力。只有验证成功才发布配置；缺少命令或不支持 ACP 子命令时保留
可重试的失败状态并提供安装命令。界面显示“未检测到 dimcode，使用 npm install -g dimcode 安装”，复制按钮紧邻命令，去掉长说明和外部安装指南链接。

[上游 CLI 文档](https://www.dimcode.dev/en/docs/cli/)提供
`DIMCODE_DISABLE_AUTOUPDATE=1` 和 `DIMCODE_AUTOUPDATE=0`。
两者仅用于 Lody 启动的 Dimcode 子进程，避免启动时请求更新共用的安装。
用户终端环境和 Dimcode home 不变。

## 验证

CLI 启动及 setup 的 69 项测试全部通过，覆盖直接命令解析、额外参数、自动更新环境变量优先级、成功发布和失败不发布。
CLI 类型检查通过；真实 Dimcode 运行、完整构建及带认证的对话仍未验证。

真实 Provider 行及对话框测试覆盖安装命令、剪贴板写入成功和失败、无关验证错误，以及重试和刷新，共 51 项全部通过。
改动范围内类型感知 Oxlint 零错误（74 个警告），i18n 和 diff 空白检查通过。
根目录 `pnpm format` 通过；`pnpm check` 受 `packages/ignore` 缺失依赖阻塞。
组件类型检查受 Electron 缺失依赖及改动文件之外的相关类型错误阻塞。
初始化根工作区六个 ACP 子模块、构建 Core/DSH 后，从本机 pnpm 缓存安装了组件依赖。
公共边界检查通过；文档检查保留六个原有的 Kimi/Pi 未初始化子模块链接错误，无新增错误。

`ProviderSetupRow/DimcodeNotInstalled` 用合成 setup 数据渲染真实组件。
Chrome 截图覆盖 900px 中文浅色、390px 中文浅色及英文深色。
三种渲染均无页面异常或横向溢出。
窄屏下原有操作区预留列仍挤压 Provider 名称，此独立布局问题尚未解决。
这是组件验证，未验证打包应用或真实机器安装。截图为临时评审产物，不提交入库。

PR: [#1380](https://github.com/LodyAI/Lody/pull/1380) (draft).
