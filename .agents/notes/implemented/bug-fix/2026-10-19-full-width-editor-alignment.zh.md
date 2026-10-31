# 全宽消息编辑器与用户栈对齐

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1714

[English](2026-10-19-full-width-editor-alignment.md)

## 摘要

全宽对话中用户栈被限制为列宽的 70%。编辑已发送消息时，原本贴合内容的气泡
会变成全宽列，其 800px 上限仍停留在行内起始侧，导致编辑器卡片比位于栈
行内结束侧的 metadata 和头像左移数百像素。现在编辑态内容盒获得
`margin-inline-start: auto`，使受限列跟随同一行内结束边缘。非编辑行保持
贴合宽度，窄于上限的列没有剩余空间，因此两者都不受影响。

## 决策与证据

编辑时行包装器已从 `w-fit` 切换为 `w-full`，内容盒保持 `w-full` 与
`sm:max-w-[800px]`。没有自动外边距时，宽度 100%、上限 800px 的盒子停在
更宽用户栈的行内起始侧，而其中的编辑器卡片在该 800px 盒子内右对齐。StyleX
规则只作用于编辑态，头像和 metadata 仍贴在栈边缘。

`AI GUI/UserMessageEditor--full-width-from-message-edit` 场景把消息行放进
inline-size 容器。Playwright 回归在 1800px（70% 栈宽超过 800px 上限）和
900px（普通宽度对照）比较编辑器卡片与
`[data-testid="user-message-metadata"]` 的行内结束边缘。

## 验证与限制

在系统 Chrome 中运行 Storybook 场景，改动后在两个宽度下通过；临时移除样式后
1800px 用例失败。该环境未安装 Playwright 自带浏览器。未在打包后的桌面应用中
验证布局。逻辑外边距支持 RTL；移动端使用 28rem 的移动栈，未单独覆盖。
