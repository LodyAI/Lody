# 让关闭意图跨越无意的鼠标移动

Status: implemented
Translation: current

[English](2026-10-14-close-intent-ownership.md)

## 摘要

鼠标感知关闭 Beta 原本在鼠标移动时立即替换目标，打开文件后把鼠标移回只有一个标签的
会话区，可能关闭或隐藏整个窗口。现在明确的内容操作持续拥有关闭目标，只有没有明确
归属时才使用悬停延迟。异步打开不能覆盖更新的主动输入，其他关闭区域可见时，弱信号
也不能触发关窗。代价是明确操作后仅靠悬停切换目标的能力减弱；完整 Electron 易用性
仍未验证。

## 证据与决策

本次修订[早期决策](2026-09-22-semantic-action-targeting.zh.md)的鼠标立即切换策略，
并非认定旧实现违反其 Spec。[语义目标 Spec](../../../../specs/semantic-action-targeting.zh.md)
仍为草案，负责当前产品意图。设备本地功能开关仍默认关闭，同时要求开启 Developer Mode。

原[解析器](../../../../packages/components/src/lib/commands/semantic-action-router.ts)
把鼠标移动和点击合并为一种信号，可以覆盖明确选择。
[SessionDetail](../../../../packages/components/src/components/sessions/session-detail.tsx)
在只剩一个会话标签时放行到原生窗口关闭，随后
[外壳关闭器](../../../../packages/components/src/lib/desktop-tab-or-window-close.ts)调用
`window.close()`。这解释了无意移动如何触发 macOS 关闭或隐藏策略，而不改变共享会话状态。

以下一手来源于 2026-10-14 查阅，支持设计选择，并非 Lody 的实测结果：

| 一手来源                                                                                                                            | 证据与限制                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [Zed 焦点设置](https://zed.dev/docs/reference/all-settings#focus-follows-mouse)                                                     | 悬停跟随焦点默认关闭，支持 250 ms 停留。它转移键盘焦点，与 Lody 只改变动作归属不同。     |
| [VS Code 1.57](https://code.visualstudio.com/updates/v1_57#_removed-cmdw-ctrlw-keybinding-to-close-window-when-no-editor-is-opened) | 连续按关闭键造成意外关窗，因此移除了空编辑区 Cmd/Ctrl+W 关窗绑定，并保留独立关窗快捷键。 |
| [Zed 空窗口策略](https://zed.dev/docs/reference/all-settings#when-closing-with-no-tabs)                                             | 提供保留窗口选项，不能据此确定 Lody 最后一个会话标签的策略。                             |
| [menu-aim](https://github.com/kamens/jQuery-menu-aim)                                                                               | 用鼠标方向区分路过和有意悬停；子菜单几何规则不能直接套到两个内容面板。                   |
| [Horvitz，CHI 1999](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/11/chi99horvitz.pdf)                           | 建议考虑不确定性、动作代价、近期交互记忆及用户控制，没有指定面板关闭算法。               |

## 归属与职责

每个窗口的解析器保留明确操作或悬停归属，以及一个待确认悬停候选。普通鼠标移动不能
覆盖明确归属，停留再久也不行。点击、键盘输入或导航、非缩放滚轮输入，以及明确打开
内容或选择标签，立即使目标区域取得归属。程序恢复焦点或滚动不取得归属。没有明确
归属时，在同一个可见区域连续悬停 250 ms 后才确定目标；区域内部移动不重启计时器。

| 状态变化                                       | 结果                                 |
| ---------------------------------------------- | ------------------------------------ |
| 打开右侧文件，再把鼠标移回会话                 | 保留右侧关闭目标。                   |
| 在会话中点击、输入、导航或滚轮滚动             | 明确归属转交会话。                   |
| 没有明确归属时路过区域                         | 停留完成之前保留已确定目标。         |
| 成功关闭右侧最后一个标签                       | 收起面板，主动将归属及焦点交回会话。 |
| 仅由悬停、焦点或默认回退选中的会话只剩一个标签 | 其他关闭区域可见时消费动作，不关窗。 |

已有提示显示确定的归属，不显示待确认候选。原生菜单入口、正常按键重复、未保存文件
确认、Side Chat 生命周期，以及取消或失败时的关闭归属，仍由现有处理器负责。
隐藏或移除的目标消费动作，不转向其他区域。明确的会话操作仍可关闭最后一个会话的
窗口，面板成功收起后的下一次调用也可如此；保护不会悄悄改为关闭另一个面板。

文件打开先异步解析路径。`deferActivation` 在调用时记录版本并返回完成回调；更新的
主动输入、另一次打开请求、重置或销毁会使它失效。查看器标签写入后，回调可在 React
提交作用域之前取得归属；目标可见前，关闭调用属于原目标并消费动作。没有创建标签的
打开不调用完成回调。查看器打开及明确选择侧栏或标签共用同一个解析器 ref；恢复状态
不会仅因挂载而取得明确归属。

[原生浏览器适配器](../../../../apps/electron/src/main/services/public-browser-interaction.ts)
现在区分移动、点击、离开、滚轮和键盘类别。桥接只传浏览器 id 和交互类别，不传坐标、
页面内容或按键文本。关闭快捷键及单独修饰键不取得归属。移动和离开遵循 renderer
作用域的悬停规则，点击、滚轮和键盘输入取得明确归属。可见性和功能开关仍控制事件传递。

## 替代方案与剩余代价

单加停留过滤路过，仍会误判停放的鼠标；速度和方向也无法从静止鼠标判断目的。
始终优先右侧面板，会误处理明确的会话标签关闭。

近期操作评分或贝叶斯模型需要带意图标注的样例和校准的误判代价，任意权重不等于概率。
明确归属提供了可解释的首版实现，不需要训练或产品遥测。只关闭内容的 Cmd+W 与独立
关窗命令仍属于另一个产品决策；本次没有增加确认弹窗或全局关窗绑定。

## 验证与限制

已有 DOM 关闭测试覆盖反馈中的鼠标停放场景、主动操作接回归属、程序恢复、停留边界
及取消、弱信号关窗保护、过期异步结果、原生交互类别，以及功能和路由生命周期清理。
测试用虚拟计时器断言面板、标签、焦点和窗口状态。运行：

```sh
NODE_OPTIONS=--no-experimental-webstorage NODE_ENV=test pnpm --filter @lody/components exec vitest run tests/desktop-tab-or-window-close.test.tsx tests/session-tab-close-target.test.ts
node --test apps/electron/src/main/services/public-browser-state.test.mjs apps/electron/src/main/close-focused-tab-or-window.test.mjs apps/electron/src/main/ipc/ipc-channel-list.test.mjs
```

Chromium 夹具加载生产解析器并使用真实鼠标移动和点击，验证打开文件后鼠标返回时保留
归属、主动操作接回会话、悬停不移动输入光标、弱信号不关窗、过期异步归属，以及面板
收起后的连续关闭。原生关闭事件使用模拟入口；这不是完整产品或 Electron 端到端验证。

桌面关闭测试的 54 个用例和限定 Electron 测试的 11 个用例全部通过。解析器及 hook
的严格类型检查、改动源码类型感知 lint 和格式检查及 i18n 验证通过。独立的会话标签目标测试
因共享索引导入的 `mdast-util-from-markdown` 缺失而无法收集。包含原生适配器的类型检查
及完整类型检查被已安装的 Effect、ACP 库不兼容及依赖缺失阻断，根级 `pnpm check`
无法完成。公开边界检查报告 ACP 工作区子模块未解析；文档检查报告改动文档以外的
82 项断链，没有受 SHA 保护的主题。复用已有依赖，没有在嵌套工作区安装依赖图。
本次不宣称测得易用性收益或原生视图
焦点顺序；Managed Preview 跨源键盘输入仍在现有桥接范围之外。

## 拉取请求

[PR #1558](https://github.com/LodyAI/Lody/pull/1558) 目标分支为 `main`。
