# Kimi 媒体输出与 ACP 历史记录

Status: proposed
Translation: current
PR: [LodyAI/Lody#2307](https://github.com/LodyAI/Lody/pull/2307)

[English](2026-11-04-kimi-media-output.md)

## 摘要

Kimi 可能把含有 Base64 图片的媒体工具结果作为一整段 JSON 文本发送，Lody 因而显示出很长的编码字符串。拟议的适配器修改将可识别的图片数据作为 ACP 图片块发送，并保留相邻文字的顺序。Lody 现有逻辑会从持久化历史中过滤工具图片，因此该修改能消除编码文本，但不会增加图片预览。已安装的客户端要获得修复，仍需要单独构建、发布并校验托管运行时。

## 边界与取舍

[Kimi PR #20](https://github.com/LodyAI/acp-extension-kimi/pull/20) 修复源码中的转换。非媒体结果和无法识别的数组保留原有表示方式，`rawOutput` 也继续发送。Lody 现有的[工具图片历史策略](../../implemented/bug-fix/2026-10-11-drop-tool-images-from-history.zh.md)会移除结构化图片，而不是保存或显示它们。在 Lody 中通用地识别 Base64 可能误删正常文本，对已知的供应商格式也没有必要。已有的历史记录不会被改写。

## 交付与证据

适配器测试覆盖混合文字和图片、多张图片、错误以及保持原样的回退结果。一条由适配器生成的合成通知经过 Lody 历史处理后，文字得到保留，图片数据没有被保存。Lody 测试还使用适配器的内容和原始输出格式验证写入边界。尚未验证真实的 Kimi 登录请求或已安装的运行时。

源码子模块指针本身不会更新托管运行时。在修改清单之前，需要基于干净的 Kimi 源码构建产物，发布到运行时渠道并校验其哈希和可用性。如果 Kimi PR 以 squash 方式合并，构建前还需将子模块指针更新为合并后的提交。在那之前，此源码集成不会修复已安装的 Lody 客户端，Issue 应保持打开。
