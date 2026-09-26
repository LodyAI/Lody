# 会话信息卡迁移到 v2 预览卡

Status: implemented
Translation: current

[English](2026-09-26-session-preview-card.md)

## 摘要

鼠标停在侧边栏对话上时弹出的信息卡，是最后一个仍画在 `@lody/ui` 之外的浮层：Radix
popover、侧边栏灰底、0.5px 描边，「工作树」用药丸表示，CI 外面套着浅色底框。放在 v2
菜单和 popover 旁边，它看起来像另一种材质。`@lody/ui` 新增 `PreviewCard`：它就是 Base
UI 的 hover card，放在 popover 同一个浮层上。会话卡用 StyleX 迁到它上面：每行一类信息加一行状态，没有边框、药丸和底色填充。侧边栏依赖的悬停时序原样留在产品组件里；`@lody/components` 不再依赖 `@radix-ui/react-popover`。

## 问题

`session-info-hover-card.tsx` 自己画浮层：`--sidebar-background`、由它混出来的描边、两层投影。其他浮层都读 `@lody/ui` 的
`popup`（raised 背景、`shadow.popover`、14px 圆角、无描边），所以应用里最常出现的这个浮层反而对不上。卡片内部，工作树状态说了两遍（图标加 `Badge`），可见性是唯一加粗的一行，CI 放在 `bg-muted-foreground/[0.06]` 的框里，在浮层上等于又叠了一层表面。它也是这个包里最后一个引用 `@radix-ui/react-popover` 的地方。

## 决定

**预览卡就是被停留的指针打开的 popover 浮层。** `PreviewCard.Content` 把 Base UI
`preview-card` 的 portal、positioner、popup 组装在一起，类名和 popover 完全一致（`surface.popup` +
`surface.popupPanel`），同样带强制调色板传递和 popup container 挂载点。没有新增 token。它和 `Popover` 的区别只在打开方式：不抢焦点，没有 dialog 角色，因为扫过列表的指针只是路过。

**悬停意图仍由产品组件负责。** Base UI 的 trigger 只有每个 trigger 各自的延迟，而侧边栏需要：只有第一次悬停要等待；已预热时立即打开；全应用同一时间只开一张卡；按下后在指针真正移动前不再弹卡。最后这一条避免卡片在切换对话的同一次 commit 里挂载（见已有测试）。组件保留这些计时器，受控 `Root open`，并通过 `Content anchor={ref}` 指向自己的行。`PreviewCard.createHandle`（一张卡、多个 trigger）可以取代"只开一张"的记录逻辑，但需要改动所有行的调用方，这次没有做。

**机器卡共用同一个外壳。** `SidebarHoverCard`（上面的计时器，受控 `Root open`）由对话行和机器分组标题共用，所以两者之间同一时间只开一张卡。两张卡现在都在预览卡的浮层上：机器卡去掉了自己的侧边栏灰色边框，只负责排列各行。它的内容这次没有重做样式。

**卡片内容：每行一类信息，按阅读顺序排列。** 每行左侧一个 14px 标记排成一列，右侧值用正文墨色、footnote 字号：

1. 工作在哪里：仓库前面是 owner 头像，本地项目前面是文件夹图标。
2. 分支，等宽字体、可复制。分支图标说明是工作树还是普通分支，因此不再有「工作树」一词或 `Badge`。
3. 是谁的、在哪台机器上，同一行：作者前面是头像，后面跟一个小显示器图标和机器名（二级标签色）。个人工作区不传作者，这一行只剩机器。
4. 谁能打开：可见性词语加图标。解释放在该词的 `title` 里，不再单独占一行。

唯一的 `Separator` 下面是**一行状态**：PR 图标带状态色，`#128` 和状态词（按下打开 PR），CI 结论（一个带色调的标记加文字），最后是 diff。不再列出 CI 任务，它们归 PR 标签页。任务运行中时，用已完成数量代替文字（琥珀色标记后面写 "CI 1/3"），英文下这一行也放得下。

**为什么显得局促，改了什么。** 所有者觉得卡片局促。量下来问题不在行数：卡片宽度贴着内容（`max-content`，15rem 到 21rem），右边缘紧贴最长的一行，diff 挤到 CI 结论上；行是 12px 字、16px 行高（1.33），中文行间会挤在一起；机器名离作者只有 6px。现在卡片固定 18rem，行高 18px（1.5），行间距仍是 4px，标题与各行之间 12px，机器名离作者 12px。试过把 diff 放到分支那一行的末尾，但它会截断分支名，而分支是用户要复制的信息，所以放弃。

**过程中被所有者否掉的方案。** 第一版保留每行，但在 "CI passed 3/3" 下再列出每个任务（同一件事说三遍），还留着会截断分支名的「工作树」一词。第二版把仓库和分支合成一条路径（`repo ⑂ branch`），读起来又长又乱。第三版让分支单独一行，把作者、仓库、机器、可见性折成一行灰色的 `a · b · c`；所有者指出读者得先判断每个词是什么，而且作者排在了仓库前面。一行没有标签的词，比它省掉的标记更费力。标记保留下来，因为每个标记说明这一行是哪类信息；去掉的是标记周围的装饰（药丸、可见性说明段落、CI 底色框、逐个任务列表）。

## 备选方案

- **用受控的 `Popover`。** 否决：popover 是管理焦点的 dialog，悬停时每一行都会被读屏当成对话框播报。
- **在 Tailwind 里重画 Radix 卡片。** 否决：components 的规则要求重写的样式使用 `@lody/ui` token 的 StyleX，而且那样还会保留 Radix 依赖。

## 验证

- `packages/ui/test/preview-card.test.tsx` 覆盖四点：锚定的受控卡片打开时没有 dialog 角色、不抢焦点；Escape 会请求所有者关闭；popup 的类名与 popover 浮层完全一致；强制调色板能跨过 portal。
- 已有的 `packages/components/tests/session-info-hover-card.test.tsx`（按下抑制、预热窗口）在新浮层上原样通过。
- 在 Chromium 里用 zh_CN 语言、亮暗两种主题检查了 Storybook `Sessions/SessionInfoCard`。重做之后，所有独立 story 都在亮暗两种主题下截图：带作者的团队会话、已合并且 CI 运行中、已关闭且 CI 失败、无 CI 数据、超长分支、本地工作树、私有本地项目、纯聊天。token 看板上新增的预览卡示例悬停即可打开。
- `@radix-ui/react-popover` 仍作为 `@assistant-ui/react` 的传递依赖留在 lockfile 里，所以也仍在生成的许可证清单中。
