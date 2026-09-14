# 精简静态分享对话框文案

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/682

[English](2026-09-14-share-dialog-copy.md)

## 摘要

静态分享对话框的设置页原本堆叠四段说明文案。现在只保留公开链接访问提示，以及一行
图片/文件附件范围说明。被移除的两段曾披露：已发布的包包含思考与工具记录、标题会在
链接预览中公开、之后的新消息不会加入，以及运行配置和类型明确的终端输出会被省略。
冻结、投影和发布行为不变，只是确认文案变短。撤销与撤销后的文案也在同一次整理中压缩，
并保留“已下载副本无法收回”的警告。分享 Spec 与分享组件说明同步去掉了首屏披露义务。

## 决策

多余段落重复了产品负责人认为冗余的信息，并挤占了设置页唯一的主动作。首屏现在只说明
拥有链接的人都可以查看这个对话，以及图片会共享、文件附件不包含。发布包与之前完全一致：
`session-share-export.ts` 与 `session-share-package.ts` 仍按相同字段投影和省略，读取者
仍会收到思考与工具内容，类型明确的终端输出仍在传输层被省略。

同一次整理还收紧了撤销及撤销后的文案。撤销确认仍保留“已下载的副本无法收回”，因为这是
该操作不可逆的后果。

这会有意移除产品中唯一一处披露：分享可能包含敏感的思考/工具记录、标题会在链接预览中
公开、终端输出会被丢弃。保留这项披露并非无足轻重的副作用，而是本次请求的改动本身。
`specs/session-sharing.md` 不再要求确认页披露这些省略，分享 `AGENTS.md` 现在描述精简后的
首屏，而不是强制更广泛的披露。

## 验证

移除两个不再使用的键（`sharing.static.contentNotice`、`sharing.static.historyOmissions`）
并在两个语言文件中更新 `sharing.static.attachmentNotice` 后，`node scripts/check-i18n.mjs`
通过。`@lody/components` 完整测试套件通过（462 个文件、3519 个用例），其中包含渲染保留下来的
`sharing.static.publicNotice` 的管理与设置测试；`tsgo --noEmit` 与 oxlint 通过。未运行完整的
workspace `pnpm check`。
