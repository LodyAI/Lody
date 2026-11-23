# 剪贴板中的文本优先于 Office 顺带渲染的那张图

Status: implemented
Translation: current

[English](2026-09-17-composer-paste-prefers-text.md)

## 摘要

从 Word 或 PowerPoint 粘贴到 Lody 输入框，结果只得到一张图片附件、文本一个字都
没有：这些应用会在文本旁边把所选内容渲染成一张图放进剪贴板，而各处粘贴处理器只
要发现剪贴板里有文件，就拦截事件并按附件处理。现在所有处理器统一走
`selectPastedClipboardFiles` 这一个判定：当剪贴板同时带文本时丢弃源应用渲染的图，
而截图、用户复制的图片文件、非图片文件的粘贴行为完全不变。"顺带渲染"的判据是文件
没有自己的文件名，而不是 MIME 类型——文件名是唯一能把 Chromium 合成的位图与用户在
文件管理器里复制的图片区分开的信号。这是启发式判断，因此两个聊天输入框还提供了一
个"改为附加图片"的操作。

## 缺陷

`session-chat-input-area.tsx` 与 `chat-landing.tsx` 会读取每个 `kind === 'file'`
的剪贴板项，一旦发现就调用 `preventDefault()` 并作为附件加入。Word、PowerPoint、
Excel 总会在文本旁边附带一张渲染位图，于是这条分支在每次 Office 粘贴时命中，用户
复制的文本从未进入文本框。`task-thread.tsx` 与 `task-body-editor-fallback.tsx` 是
同样的写法。

超过 1024 字符的粘贴不受影响：`shouldCapturePastedTextDraft` 会先把它折叠成 chip
并提前返回，走不到文件分支。"短的 Office 粘贴变成图片、长的却正常"这一不对称正是
定位到该分支的线索。

## 决定

判定收敛到 `packages/components/src/lib/file-drop.ts` 里的一个纯函数，与它所对应的
拖放拆分放在一起。只要剪贴板带文本，文本优先，但仅针对看起来由源应用渲染出来的
文件：图片 MIME，且没有文件名或只是一个 `image.<扩展名>`。

两个条件缺一不可，且防的是相反方向的错误。仅看文本不够：Finder 与资源管理器会把
所复制文件的名字作为文本放进剪贴板，"有文本就赢"会把复制的图片文件变成一段文件名
文本。仅看文件名同样不够：截图也是一张无名的 `image.png`，正是"没有文本"这一点让
它毫无歧义。

顺带还有两处行为变化。折叠大段粘贴不再提前返回，因此同时带长文本和真实文件的剪贴
板现在两者都会生效。两个聊天输入框会弹出带"改为附加图片"操作的短暂提示，并使用固
定的 toast id，使重复粘贴只替换而不堆叠；任务编辑器则静默丢弃渲染图，与其他聊天产
品的做法一致。

## 备选方案

读取 `text/html` 并依据 Office 特有标记（`mso-`、条件注释）判断：已否决。Chromium
自身的"复制图片"同样会写入只含一个 `<img>` 的 `text/html`，HTML 的存在并不能区分两
种情况，而标记清单会随 Office 版本过时。

只要有文本就判定为文本粘贴、不做文件名检查：已否决，原因是上述文件管理器场景的回归。

同时插入文本并附加图片：已否决。常见情况下那张图只是文本的重复，却会被上传并发给
Agent，而我们没有低成本的办法把重复图和用户真正想要的插图区分开。

## 验证与局限

`packages/components/tests/file-drop.test.ts` 覆盖了整张优先级表：渲染位图、无名位
图、截图、仅空白字符的文本、有名字的图片文件、非图片文件，以及同时带真实文件与位
图的剪贴板。`packages/components/tests/session-chat-input-submission.test.tsx` 在组件
边界断言"文本 + 位图"的粘贴不会被拦截；该用例已确认在改动前的实现下失败。

没有任何测试使用真实的 Office 剪贴板——jsdom 没有剪贴板，组件测试也无法走附加路径，
因为那里没有 `URL.createObjectURL` 和图片上传。因此附加方向的覆盖在辅助函数层而非
输入框层。Chromium 是否在所有平台与 Office 版本上都把渲染位图命名为 `image.png`，
在本仓库无法验证；若它使用了别的名字，该次粘贴会退回到此前的行为，此时也不需要提示
里的操作，因为图片本来就已附加。

意图记录在[输入框粘贴优先级](../../../../specs/composer-paste-precedence.md)。
同一处理器里的另一项决定——500 KiB 上限——仍保持原样：
[输入框粘贴体积上限](../feature/2026-09-14-composer-paste-size-ceiling.zh.md)。
