# 通过语义作用域路由关闭动作

Status: implemented
Translation: current

[English](2026-09-22-semantic-action-targeting.md)

## 摘要

桌面标签关闭记录点击和焦点，却忽略鼠标移动，因此移到右侧面板仍可能关闭会话
或窗口。默认关闭的开发者 Beta 已通过窗口内共享的语义作用域 resolver 路由原生 Cmd/Ctrl+W。
鼠标和键盘意图选择界面，现有界面处理器继续管理关闭生命周期。空面板收起并
将焦点交回，供下一次调用操作；阻止或取消不能穿透到其他区域。定向测试已通过，完整产品窗口
和跨域预览交互仍待验证。

## 证据与职责

[SessionDetail](../../../../packages/components/src/components/sessions/session-detail.tsx)
已用 `data-lody-session-tab-region="side-panel"` 标记右侧面板，根节点只捕获
pointer-down 和 focus，不捕获鼠标移动。默认区域是会话，未标注的后代也视为会话。
[关闭 resolver](../../../../packages/components/src/components/sessions/session-tab-close-target.ts)
在仅有一个会话标签时选择窗口；焦点在空右侧且会话使用 empty sentinel 时也选择窗口。

[Shell closer](../../../../packages/components/src/lib/desktop-tab-or-window-close.ts)
选择最后挂载的 closer，在返回 `unhandled` 或没有 closer 时调用 `window.close()`。
[命令规则](../../../../packages/components/src/lib/commands/AGENTS.md)要求保留原生加速键，
禁止重复注册 renderer Mod+W。本提案保留此入口及
[已有决策](../bug-fix/2026-09-21-last-tab-window-close.zh.md)中的会话窗口关闭策略。
[会话关闭 Spec](../../../../specs/session-tab-closure.zh.md)已区分显式关闭最后一个草稿
标签与原生窗口关闭快捷键，修正过期措辞，与桌面窗口 Spec 一致。

## 实现

产品行为由[草案 Spec](../../../../specs/semantic-action-targeting.zh.md)负责。
`semanticShortcutsFeatureEnabledAtom` 组合开发者总开关与默认 false 的设备持久化选项，
Beta 设置行控制该选项。`useSemanticActionRouter` 只在开启功能的 Electron SessionDetail
安装输入监听，Session 身份变化或清理时重置。

`semantic-action-router.ts` 解析最内层可见的已注册 DOM 作用域。两列用
`data-lody-action-scope` 声明身份，SessionDetail 提供当前关闭处理器。悬停更新标签栏
提示但不移动输入光标；随后打字或键盘导航接回归属。程序恢复焦点不覆盖鼠标意图。
Mod+W 使用现有 TanStack 匹配器，不创建第二个关闭绑定。打开的模态层和菜单阻止后台
关闭；不可用或移除的目标消费本次调用。只有目标处理器显式返回才能交给原生窗口关闭。

空右侧收起。同一 Session 内从可见转为隐藏时，作用域和 composer 焦点交回会话。
未保存确认、Side Chat 终止、错误和关闭等待继续由现有处理器负责。按明确要求，正常
重复派发保持原样，不增加重复锁、修饰键释放要求或定时器。悬停延迟留待评估。

公共浏览器原生视图在宿主边界观察 Electron 输入，仅在视图可见且所属窗口聚焦时向该
窗口发布 `publicBrowser.interaction`，且必须开启功能。现有可见性 IPC 携带跟踪开关，
关闭 Beta 同时停止原生输入推送与 renderer 消费。载荷只有浏览器 id 与来源类别。可见 renderer
宿主仅在功能启用时消费信号，从其注册界面派发 DOM 归属事件；不添加网页内容读取、
按键文本传输、preload 或脚本注入。鼠标进入 iframe 使用宿主 pointerover 事件，不读取 frame。跨域 Managed Preview
iframe 内部键盘输入仍需独立桥接，不属于首版 Beta 的覆盖范围。

## 同类设计与修正

2026-09-22 的调研区分已记录的行为、用户请求和历史缺陷报告；它们不能证明存在
统一的关闭策略。

| 一手来源 | 证据 | 对本提案的影响 |
| --- | --- | --- |
| [VS Code 1.57 发布说明](https://code.visualstudio.com/updates/v1_57#_removed-cmdw-ctrlw-keybinding-to-close-window-when-no-editor-is-opened) | 用户快速连续关闭导致窗口意外关闭，因此移除了无编辑器时关闭窗口的绑定。 | 多次独立按键也会误关；仅抑制按住自动重复不能解决升级为关窗口的问题。 |
| [Zed pane 布局请求 #14817](https://github.com/zed-industries/zed/issues/14817) | 用户要求保留空 pane，并在空 pane 上按 Cmd+W 才关闭它。这是需求，不是已发布行为的证明。 | 内容为空，容器仍可关闭；静默消费不是唯一安全选项。 |
| [Zed 焦点设置](https://zed.dev/docs/reference/all-settings#focus-follows-mouse) | 悬停聚焦默认关闭，支持 250 ms 停留时间。 | 立即悬停接管仍需验证，不能视为既定默认。 |
| [iTerm2 #10167](https://gitlab.com/gnachman/iterm2/-/issues/10167) | 用户报告前往 Dock 菜单时路过终端，终端抢走焦点。 | 要保护鼠标途经路径和菜单。这涉及完整焦点转移，只能类比，不能直接证明 action 悬停路由不可行。 |
| [VS Code #189256](https://github.com/microsoft/vscode/issues/189256) | 空分组看起来已激活，但打字仍作用于前一个编辑器。 | 布局变化后，视觉目标、键盘焦点和 action 归属必须一致。 |

修正最初的无操作提议：可见空右侧面板收起自身，成功后将焦点和活动作用域交回
会话。后续调用可以关闭会话，包括普通按键重复。按明确要求，实现移除了初始设计中的
重复抑制。取消、等待和失败仍由原界面接管。隐藏面板排除出候选，不能成为
永久空目标。由此区分同一次调用穿透与焦点转移后的合法下一次操作。

保留“会话仅剩一个标签时关窗口”只是限制本提案范围，并非调研验证了它。
VS Code 的撤回提供了独立审视该策略的证据。Zed 也提供显式
[无标签窗口策略](https://zed.dev/docs/reference/all-settings#when-closing-with-no-tabs)，
说明容器关闭与窗口关闭应分别决策。只改变 action 目标的悬停路由与焦点跟随鼠标
有区别：采用前需要验证是否会制造两个互相冲突的“活动 pane”。

## 验证与限制

现有 desktop-close 测试覆盖真实 DOM 输入、原生关闭派发、选择、嵌套、可见性、
取消/等待归属、模态/菜单屏障、键盘接回、程序聚焦、失焦、鼠标离开、拖拽、路由重置
和功能开关即时变化。浏览器输入测试验证事件传递及清理，不转发按键文本。布局和
Beta 设置 Story 覆盖启用及空面板状态；布局 Story 使用浏览器可用的 F8 模拟关闭入口。

53 个定向 Vitest 用例和 11 个 Electron 关闭、IPC 及浏览器测试通过。router、hook 和原生输入
适配器的独立严格类型检查通过。修改的源文件通过 Oxfmt，i18n 检查通过。独立 Chromium fixture 使用生产 router 验证
不点击的悬停、活动提示、关闭右侧标签并收起、焦点交接、后续关闭会话及进入跨域 iframe。这是路由
fixture，不是完整产品或 Electron 端到端运行。当前 Node 26 环境的 jsdom 存储测试需
`NODE_OPTIONS=--no-experimental-webstorage`。复用已有 checkout 依赖，没有安装第二套
workspace 依赖图。

完整仓库检查受缺失的 workspace/子模块依赖阻塞，public-boundary 检查也报告未解析的
ACP 子模块。文档检查保留已有子模块断链。原生菜单派发和原生视图焦点顺序仍需完整
产品验证；跨域 Managed Preview 键盘输入不属于本 Beta。没有声称已获 Spec 批准或测得可用性收益。

## Pull request

[Draft PR #912](https://github.com/LodyAI/Lody/pull/912) 的目标分支是 `main`。
