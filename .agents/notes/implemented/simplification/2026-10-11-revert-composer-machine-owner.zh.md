# 撤回输入框机器身份展示

Status: implemented
Translation: current

[English](2026-10-11-revert-composer-machine-owner.md)

## 摘要

用户要求移除输入框信息栏中的机器名称与主人展示。撤回 #1300 引入的展示，
恢复桌面和移动端原来的单行 cluster/stage 布局。移除仅供身份展示使用的属性、
样式、预览、测试和翻译文案。信息栏不再提供常驻的执行机器归属信息。

## 决定与证据

反向应用提交 `385f1a727` 中相关实现的修改，保留之后的无关变更。
保留原提案作为历史，将其[Spec](../../../../specs/composer-machine-owner.zh.md)
标记为 outdated。本决定取代[归属提案](../../proposed/feature/2026-10-07-composer-machine-owner.zh.md)。
现有信息栏测试继续覆盖无上下文与同步状态。

此检出未安装工作区依赖，无法运行定向 Vitest 测试（`vitest` 不可用）。
尚未进行真实界面验证。

`git diff --check` 通过。已尝试根目录 `pnpm check` 和 `pnpm format`，
因缺少 `tsgo` / `oxfmt` 无法完成。文档检查报告现有文档引用的 ACP 子模块
文件缺失；未注册受 SHA 保护的主题。

PR：[ #1431](https://github.com/LodyAI/Lody/pull/1431)。
