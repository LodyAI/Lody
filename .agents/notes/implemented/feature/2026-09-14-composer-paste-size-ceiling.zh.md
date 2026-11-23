# 拒绝超过 500 KiB 字节上限的输入框粘贴

Status: implemented
Translation: current

[English](2026-09-14-composer-paste-size-ceiling.md)

## 摘要

以前把一大段日志粘进输入框时，它会无上限地折叠成一个 `[Pasted N chars]` 胶囊，于是一次误粘的
数兆内容只留下一个短标签，却仍然跟着每一次草稿保存、每一次 prompt 重写以及这一轮对话本身一起被
带走——用户往往要等到发送之后才发现。现在输入框会按草稿真正会存下的内容来度量，任何 UTF-8 体积
超过 500 KiB 的粘贴都会被取消，并弹出一个错误 toast，同时给出实际体积与上限，并提示改用文件附件。
这个上限只是客户端输入框的一道防线：它不约束逐字输入的文本、不约束对已有粘贴草稿的编辑，也不约束
任何非粘贴入口，更不是服务端限制。

## 决策与证据

- 上限按 UTF-8 字节而非字符计。「500 KB」描述的是载荷大小，而按字符计会让中日韩日志以约三倍于
  预期的体积通过。`getPastedTextByteSize` 编码的是 `insertPastedTextDraft` 真正会存下的那份
  规范化并去除首尾空白后的字符串，因此 toast 显示的数字就是这份草稿实际要付出的代价，而不是原始
  剪贴板载荷。
- 这道判断位于两个输入框的粘贴处理中
  （[会话](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx)、
  [首页](../../../../packages/components/src/components/chat/chat-landing.tsx)），
  排在已有的 `shouldCapturePastedTextDraft` 折叠之前，并且整段拒绝而不是截断：粘进去一半的日志
  比完全没粘更糟，因为用户无从判断它是在哪里被切掉的。任务正文与评论输入框保持原有粘贴行为，
  它们不是 agent 的一轮对话，也不承载粘贴草稿。
- 阈值与既有的折叠阈值一起放在
  [`pasted-text-draft.ts`](../../../../packages/components/src/lib/pasted-text-draft.ts)，
  这样两个限制彼此可读：超过 1024 字符折叠，超过 500 KiB 拒绝。
- toast 复用会话文件展示中的 `formatFileSize`，而不是再写一个字节格式化函数，被拒绝的粘贴因此
  与超大附件使用同一套单位。

## 验证与限制

- [`session-chat-input-submission.test.tsx`](../../../../packages/components/tests/session-chat-input-submission.test.tsx)
  向渲染出的输入框派发真实的 paste 事件：超出上限一个字节时草稿原封不动且恰好弹出一个错误 toast，
  而正好等于上限的粘贴仍然折叠成胶囊。两个用例都断言最终的 textarea 值，因此移除这道判断会让
  第一个用例失败。
- [`pasted-text-draft.test.ts`](../../../../packages/components/tests/pasted-text-draft.test.ts)
  覆盖边界本身：上限取闭区间，中日韩文本在字符数只有三分之一时即越界，首尾空白与 CRLF 在度量前
  已被规范化掉。
- 只有会话输入框是通过渲染组件验证的；首页输入框共用同一个 helper 与同样的处理形状，但仅通过
  阅读代码确认，没有对应测试。该拒绝路径也未在打包后的桌面版中用真实剪贴板验证过。
