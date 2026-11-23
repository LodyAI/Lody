# 保留待回答请求之间的答案与恢复能力

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1533

[English](2026-10-13-question-request-continuity.md)

## 摘要

提问答案提交失败可能没有提示，请求切换会清空未完成的答案，输入法确认还可能提前提交自定义回答。现有响应归属组件现在显示提问写入失败，待回答表单保留切换期间的本地状态，自定义答案处理器使用共享输入法保护。只有当前请求可见且可回答，已结束的请求释放草稿。Playwright 复现了这些问题，并通过浏览器事件验证重试、鼠标与触屏切换、候选词确认；完整桌面应用与实体输入法仍未验证。

## 根因与决策

`FloatingPermissionRequest` 已经捕获 writer 写入失败并保存错误，但仅普通权限分支显示该错误。`QuestionRequest` 现在将错误传入问题卡片，卡片在提交或翻页操作上方，使用已有的内嵌提示呈现本地化文案。正文使用次级文字色，由小型错误色图标标示失败，避免整句变红。这替换了最初置于卡片外的裸文本，后者在视觉上割裂了错误、答案和对应操作。现有表单保留答案与备注用于重试，没有增加重试队列或新的响应协议。

此前请求切换会替换带 key 的 `QuestionRequest`，销毁卡片本地的选项、自定义答案、备注和当前页。现在待回答表单在现有交互面内保留会话与请求身份。非当前表单隐藏、设为 inert 且禁用，包括当前显示普通权限请求时。回答或取消被接受、请求撤回，以及交互面卸载时，表单及其草稿随之释放。这直接保留已挂载表单状态，没有引入持久化存储或第二份草稿缓存；非当前表单在释放前仍占用内存。

自定义答案处理器此前只检查 `nativeEvent.isComposing`。当 Enter 只携带已有的 `keyCode`/`which` 229 输入法信号时，确认候选词会被当作提交并写入答案。现在复用共享 UI 的 `isImeComposingKeyboardEvent`，与输入框及队列编辑框一致。普通 Enter 继续沿用翻页或提交行为，没有引入延迟或第二份键盘状态。

[请求 Spec](../../../../specs/permission-requests.zh.md) 保持 draft，并明确了这一有限保留生命周期。本决策补充[唯一交互提示决策](../feature/2026-09-24-permission-prompt.md)和[独立回答备注决策](../feature/2026-09-20-ask-question-answer-notes.zh.md)。之前权限提示记录中的失败反馈保证已在普通权限请求中实现，但提问分支不完整；本次修复补齐了该缺口。

## 证据与限制

- [生产响应归属组件](../../../../packages/components/src/components/sessions/floating-permission-request.tsx)继续使用 `usePermissionResponse` 的既有 writer 接受边界。
- [真实组件 stories](../../../../packages/components/src/stories/FloatingPermissionRequest.stories.tsx)在 writer 边界模拟拒绝与接受，并将接受结果写入合成历史，不定义产品外观。
- 7 个 [Playwright 恢复用例](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)在 Chrome 中通过，覆盖触屏、普通权限请求穿插、重试的完整载荷、已结束字段的移除，以及输入法信号后普通 Enter 的正常提交。Chromium 忽略 KeyboardEventInit 的 `which`，兼容性用例显式定义该字段。修复前后截图位于忽略提交的 `artifacts/usability/round2/` 与 `round3/`。`artifacts/usability/feedback-ui/` 的视觉复核对照覆盖明暗主题与窄窗口中文；恢复用例在 390 和 1000 像素宽度下检查提示位于卡片内部、操作按钮上方。
- 合并两条重复的提交检查，改为验证实际提交后的只读状态与答案载荷。权限提示和问题卡片套件共 30 个组件测试通过。包类型检查仍报告未修改模块的依赖缺失或版本不匹配，修改文件已经没有类型错误。桌面构建已在上一轮队列编辑验收中被 CLI 依赖问题阻断，本轮没有重复构建。
- 验收使用生产组件与合成 writer/历史数据，未验证 daemon 送达、提供方行为或实体原生键盘。输入法对照重放 Enter 与 keyCode 229，并未驱动系统输入法。
