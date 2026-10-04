# 基于可主题化 StyleX 表面的对话节奏

Status: implemented
Translation: current
PR: [#1238](https://github.com/LodyAI/Lody/pull/1238)

[English](2026-10-03-conversation-rhythm-stylex.md)

## 摘要

对话间距叠加了虚拟行 padding、活动按钮 padding，以及仍占普通布局空间的隐藏用户操作，
使相关内容之间留白过大；固定紧凑预留区又削弱了默认字号下的层次。现在语义 StyleX
变量根据界面行高计算阅读与轮次间距：默认场景的活动行高为 24px，正文为 14px / 22px，
回复间距为 36px，下一轮最小距离为 56px。Footer 操作与下一条用户消息的 metadata 共用该预留区，
更高内容可以自然撑开；主题可覆盖 token，原始消息文本和文字角色保持不变。

## 证据与决策

截图反映症状，不是 CSS 计算值。1120 × 1500、14px 字号下，真实已完成 fixture 的
原活动行测得 26–28px，气泡到回答约 54px，引用到下一气泡约 86px。用户 Copy 操作
虽然视觉隐藏，仍占 flex 栈的一行；活动行自身 padding 又叠加虚拟包装的 padding。
消除这些重复是必要的，但固定的 32px / 约 56px 预留区让默认界面过于紧密。仅把外围
预留区放大到 40px / 64px 后，正文仍为 14px / 20px，消息之间拉开了，阅读内部却没有
舒展。展开四行活动的 fixture 中，第一条气泡到实际正文为 140px，其中活动区占 96px，
其余是间距。短文本 fixture 验证了盒模型距离，却没有充分暴露自动换行后的阅读密度。

[会话 token 组](../../../../packages/components/src/components/ai-gui/conversation.tokens.stylex.ts)
拥有语义间距，而非新增全局间距或文字尺度。`responseGap`、`roundGap`、段落间距、
活动 pitch、列表项间距和气泡 padding 都由 `@lody/ui` 行高与共享间距计算。
[节奏 Spec](../../../../specs/conversation-rhythm.zh.md)统一拥有公式与字号示例。曾考虑
固定调整为 40px / 72px；使用带下限的比例行高，才能覆盖全部五档字号，而非只调整
一张截图。最终方案将阅读行高与界面行高分开：`readingLeading` 为 body 行高的
1.1 倍，默认 14px 字号下为 22px；回复与轮次预留区采用更小、独立的乘数，默认是
36px / 56px。用户文本与普通 Markdown 消费阅读 token，紧凑工具正文、代码和界面
控件保留既有行高。显式 Markdown 预览使用与字号相同的类型除法缩放阅读 token。
主题可单独改变阅读行高，不改变外围预留区或代码。围栏代码重复的 `sectionGap`
别名合并到 `surfaceGap`。

用户行把操作放在回复预留区内。助手第一行不再添加顶部 padding，无论它是正文还是
已完成工作标题。紧接用户轮次时，助手最后一行拥有轮次预留区。普通 footer 的最小
高度扣除下一条用户消息的 metadata pitch 与 gap，让操作和 metadata 包含在约定距离
中。Metadata pitch 在最小字号下也容纳固定 14px 的状态图标。没有 footer 时，最后
内容行提供同样预留区；没有后续用户消息的尾部仅使用普通行 padding。文件修改卡片、
换行或额外操作及附件均可超出最小距离，不使用固定高度裁切。

下一条用户消息的角色参与助手行缓存身份，包括用户 placeholder；第一行、最后一行
的边界状态参与 memo 比较。追加或移除追问会正确更新间距，行 key 保持稳定；未改变
的行保留引用身份。滚动引擎与 outline 的索引转换保持不变。

消息包装、气泡、metadata、活动行与 Markdown 元素使用 StyleX，代码与 diff 共用
代码正文组件。变量组引用共享圆角与颜色；没有对应语义 token 的既有 CSS 颜色变量
保留为兼容桥接。Shiki 调色板适配、表格、Mermaid 与 diff 行专用 CSS 仍保留。用户
文本继续使用 `pre-wrap`：删除原始空行会改变复制、搜索和内容。光学阅读基线仍为
4px；[排版决策](2026-10-03-interface-typography.zh.md)继续拥有文字角色。

## 验证与限制

九组聚焦单测通过，共 140 项，覆盖虚拟行身份与边界更新、折叠、活动、操作缩进、
发送者身份、复制、Markdown 流式重解析、空闲渲染与分享 Markdown。浏览器测试通过
20 项，覆盖全部五档字号、明暗主题与窄窗口、
实测回复和轮次距离及列表 pitch、用户空行、键盘操作、代码换行、无 footer 和文件
修改场景、原生选择、有序列表标记以及原有排版与偏好设置。实际局部 `createTheme`
将回复和轮次预留区独立改为 48px / 80px，阅读行高改为 24px 时，代码仍为 18px，
同时覆盖表面颜色与 margin。新增静态与流式阅读 story 使用连续中英文段落，浏览器
Range 检查自动换行后的真实行距为 22px。

阅读修订的前后截图使用同一个合成长正文两轮 story，1120 × 1500、14px、暗色主题，
并展开第一组活动，对比原先 20px / 40px / 64px 与新版 22px / 36px / 56px 的比例。
没有使用捕获的会话记录。组件类型检查在已有独立验证 clone 中执行，源文件变更从
主工作树复制。

主工作树缺少依赖与 ACP 子模块；根目录 `pnpm check` 在 ACP 筛选无匹配之后，因
缺少 `tsgo` 停止，根目录 `pnpm format` 因缺少 `oxfmt` 停止。使用验证 clone 的
formatter 检查本次修改的全部 13 个 TypeScript、TSX 和 CSS 文件，格式检查通过。
未证明全仓 build/check 全绿。文档检查仍报告指向缺失子模块的链接；
本次修改的文档没有失效链接，未改变 SHA 保护主题。Spec 保持 draft，实现和测试通过
不代表人工批准。

已选轮次浏览器 fixture 保留此前的设置：先通过原生鼠标建立选择，再设定精确范围。
仍断言文本保留和节点连接状态；该设置避免了在原生产样式下也会于 writer 更新前
消失的程序化选区。
