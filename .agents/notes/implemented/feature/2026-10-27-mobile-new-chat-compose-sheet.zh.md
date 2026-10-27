# 移动端新建对话变成一张空白写作页

Status: implemented
Translation: current

[English](2026-10-27-mobile-new-chat-compose-sheet.md)

## 摘要

移动端新建对话原本弹出一张矮底 sheet，上半部分是一排带标签的表单
（机器、类型、项目、分支、工作目录），下面才是小卡片输入框：用户先看到的是配置，
而不是可以写字的地方。现在 sheet 接近全高，只有返回按钮、一个打开项目 sheet 的目标按钮
（机器 + 一个搜索框同时搜本地文件夹和 GitHub 仓库）、一整页高的输入区，以及底部一条可横向滚动的控制栏，
承载运行配置、机器、分支和工作树。附件和发送按钮固定在这条栏外。代价是窄屏手机上
机器/分支/工作树需要向右滑一下才能看到；头部目标按钮和底部机器 chip 打开同一个项目 sheet。
已用手机宽度 Storybook 截图、组件测试和目标文案单测验证；尚未在真机上运行。

## 致谢

本次改动基于社区贡献
[#491 — feat: simplify mobile new chat and project selection](https://github.com/LodyAI/Lody/pull/491)
（作者 [@natsustan](https://github.com/natsustan)）。`MobileNativeSelect`（保留给
分支）、底部控制栏的组成、全高 sheet 头部以及原生选择器回归测试
均改编自该分支。落地提交必须带共同作者尾注
`Co-authored-by: spike <zvq@live.com>`（#491 中的作者身份，对应 @natsustan），
PR 的 Contributors 也会列出 @natsustan。原分支以关闭未合并状态结束；本版本把它与
当前 workspace 代码做了对齐。

## 问题

- 旧 `MobileNewChatSheet` 在 `max-h-[92dvh]` 的 sheet 里堆了四到五排带标签的行，
  再放一个 `promptRows={4}` 的输入框。常见的 Chat 上下文因此是一张浮在空白背景上的
  小卡片，项目上下文则长成一张表单。
- 这些行重复了别处已有的摘要信息：机器胶囊、run-config face、工作目录 pills。
  静止的 sheet 没有优先回答“我在哪里输入？”。
- `ChatComposer` 只有 `landing`、`session`、`dialog` 三种形态。`session` 是固定高度
  的圆角卡片，无法铺满一页；它的紧凑占位规则（`< 440px` → “随便问点什么”）又会在
  最需要 `/`、`@`、`$` 提示的空白页上隐藏这些提示。

## 决定

- `MobileNewChatSheet` 是接近全高（`92dvh`，并减去键盘高度）的 sheet。头部只有一个
  返回控件和一个统一目标选择器；主体就是输入框，输入框底部是唯一的控制栏。
- `MobileNativeSelect` 在真实的透明 `<select>` 上渲染品牌化触发器。触屏平台因此弹出
  系统选项列表，而不是 app 自绘菜单；web 上仍保持键盘可操作。
- 头部目标打开 `MobileNewChatProjectSheet`：机器行、一个搜索框同时搜本地文件夹和
  GitHub 仓库、分组结果、Chat 行以及 add/connect。本地结果按机器过滤，GitHub 与机器无关；
  切到不拥有当前本地项目的机器时会清回 Chat。
- 头部选择器把 Chat、全部本地项目（“Local”分组）和 GitHub 仓库（“GitHub”分组）
  放进同一个列表。切换时复用 `handleDesktopProjectChange`，草稿、附件和运行配置
  都不会丢失；未选择目标时回退到 “Chat”。
- 底部控制栏是一条横向滚动行：运行配置/用量胶囊，然后是机器、工作树和分支。
  工作树排在分支之前，本地目标下优先露出影响更大的控件。附件 `+` 和发送按钮是栏外的
  兄弟节点，再长的目标名也不会把两者挤掉。
- `ChatComposer variant="sheet"` 就是页面本身：没有卡片、没有边框，输入区 `flex-1`，
  底部用一条细线与输入区隔开。`fillHeight` 贯穿 `CombinedMentionTextarea`，让
  mention 根节点、输入容器和 textarea 一起撑满 flex 列。sheet 关闭紧凑占位，
  窄屏也保留完整的命令 / 提及 / 技能提示。打开时通过 `promptAutoFocus` 聚焦输入区，
  键盘直接弹出。
- `MobileFooterRail` 包裹底部控件：只有还能继续横向滚动时才在右边缘渐隐，滚到末尾
  就移除渐隐；这样机器/工作树/分支有可滑动的提示，又不会遮住发送按钮。
- 全高输入区给 mention 菜单传 `mobilePanelPlacement="bottom"`：斜杠命令和 `@` 分类
  停靠在 footer 上方。默认的“输入框上方”停靠留给底部输入框的会话输入区；在全高 sheet
  顶部它会缩成压在头部上的一行。
- `resolveMobileNewChatTargetLabel` 集中标题规则：优先选中的仓库 / 项目名，其次本地化
  占位，否则纯 “Chat”；空白选择永远不会得到空标题。
- Role 绑定的机器保持固定：除当前 Role 机器外的选项以 `roleMachineLocked` 禁用；
  项目 sheet 也不会把项目切到另一台机器上。

## 备选方案

- **保留表单行，只把 sheet 拉高**：否决。它仍让表单成为第一印象，Chat 上下文里
  高度塌陷的问题也还在。
- **标题下方做 app 自绘的展开面板**（本次改动的第一版）：在看过 #491 后否决。
  它多一跳，并且在手机上又造了一套 app 内 picker；原生 select 打开的是用户熟悉的
  系统选择器。
- **每个控件一个底部胶囊、不滚动**：否决。模型、机器、分支、工作树放不进 390px
  手机，胶囊栏又会变成表单。滚动才能让附件和发送固定。
- **原生项目选择器**：评审后否决。它没有搜索、没有机器上下文，而本地文件夹属于机器。
  项目 sheet 保留一个搜索框和一个可见的机器行；原生 select 只留给分支。桌面
  `UnifiedProjectSelectorView` popover 也被否决，只借用了它的搜索语义。

## 验证

- Storybook `Mobile/MobileNewChatSheet`（Chat、Local、GitHub、长模型名、附件、
  关闭态、菜单）在 390×844 下的截图：头部选择器、整页输入区、底部控制栏均符合描述；控制栏在发送按钮处截断，
  与参考图一致。
- `tests/mobile-new-chat-project-options.test.ts` 覆盖机器过滤和同一个 query 搜文件夹名/
  路径与仓库名/描述。
- `tests/mobile-native-select.test.tsx` 覆盖原生 change 事件、分组、单选项禁用状态和
  可选指示器。
- `tests/mobile-new-chat-target.test.ts` 覆盖 chat / local / github 标签与空选择兜底。
- `@lody/components` typecheck 在改动文件上无错误；包内其余 providers/routes 错误为
  既存问题。
- 相关 composer / mention / landing 测试通过（32 个）；一个既有套件因仓库的 `effect`
  `Context.Tag` 版本不匹配而失败。
- 限制：未在 Capacitor iOS/Android shell 中实测，项目 sheet 的嵌套 drawer、机器列表、
  搜索键盘、键盘高度扣减与输入区
  Vaul no-drag 的真机表现未验证。Storybook 中未从新 sheet 打开真实 run-config sheet；
  底部胶囊用视觉替身。390px 手机上需要横向滑动才能看到分支/工作树。
