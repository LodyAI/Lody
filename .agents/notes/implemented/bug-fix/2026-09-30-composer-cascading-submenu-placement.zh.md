# Composer 级联子菜单定位

Status: implemented
Translation: current

[English](2026-09-30-composer-cascading-submenu-placement.md)

## 摘要

Composer 子菜单相对整个主菜单居中，使其与触发行分离。现在所有桌面运行配置子菜单
都锚定各自触发行，空间足够时顶边对齐，角色菜单也不例外。视口碰撞允许平移或翻转；
规则一致不意味着屏幕坐标一致。模型列表高度上限改为约束实际内容，而非定位容器。
隔离的 Playwright 验证覆盖布局和交互，但不能证明打包后的 Electron 验收通过。

## 决策与依据

共享触发行锚点继续生效。后续搜索区对齐调整及被拒绝的尺寸／位置尝试，见
[模型搜索锚定记录](2026-09-30-model-search-trigger-anchor.zh.md)；
该记录负责当前带搜索模型菜单的偏移规则和验证。

本决策仅替代[之前角色菜单记录](2026-09-29-composer-role-submenu-placement.zh.md)中的定位决策。
角色双栏按内容增长、14rem 上限、独立滚动及标准内边距继续保留。放弃的方案是把
相对整个主菜单居中、底边限于主菜单的规则推广到所有子菜单；这统一的是相对主菜单的位置，
而不是子菜单与打开它的选项之间的关系。

[Fluent 子菜单规范](https://github.com/microsoft/fluentui-react-native/blob/main/packages/components/Menu/SPEC.md#submenu-positioning)
明确以菜单项为锚点、与其顶边对齐。
[Material Web 子菜单默认值](https://github.com/material-components/material-web/blob/main/docs/components/menu.md)
连接锚点的 `START_END` 与菜单的 `START_START`。按横向 LTR 布局理解，
即触发行右上角连接子菜单左上角。

`DesktopRunConfigMenu` 的角色、Agent、模型、交互、推理和 Provider 自定义选择菜单
共用 `align: start` 及横向翻转、纵向平移的碰撞规则。菜单组件保留默认触发行锚点与
inline-end 方向，包括 RTL 处理；不再有按高度计算的主菜单偏移。模型搜索过滤后，
结果能放下时恢复触发行对齐。较高子菜单可以越过主菜单底边或覆盖相邻页面内容；
碰撞边界是视口，不是 Composer 底部。意图见
[定位 Spec 草稿](../../../../specs/composer-run-config-submenu-placement.zh.md)。

模型高度上限原先作用于 `Menu.Content` 的定位容器，实际弹层仍可能越过它。
现在弹层内部的 StyleX 容器将内容限制在 20rem 与可用高度内。搜索保持可见，
只有选项滚动。现有浏览器测试增加视口边界、过滤后的触发行对齐及产品 Story 中
四类子菜单的验证。

## 验证与限制

Playwright Chromium 渲染真实菜单、UI 组件、角色面板和模型搜索；使用合成目录，
隔离服务与数据 Hook。Composer 外框为合成布局，不是产品的 `ChatComposer`。
事实纠正：首次外框留了 80px 底部空间，截图又排除了视口底边，因此不能据此证明贴底验收。
修正外框按桌面外壳
[`getSessionChatInputAreaShellClassName`](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx)
保留 8px 底部间距；截图包含视口底边，Playwright 也断言这段间距。

对比图在相同 1040×720 视口、内容和高度上限下，比较放弃的居中实现与修正实现。
Agent、模型顶边分别与触发行同为 y=512、540。推理行位于 y=568，176px 弹层因
视口碰撞上移 32px，位于 y=536–712。长模型弹层避让到 y=384–712，高 328px；
过滤到单个匹配项后恢复触发行，位于 y=540–608。Composer 距视口底边 8px 时，
六类子菜单均通过触发行锚定与视口避让规则的验证。

已执行验证覆盖六类子菜单、连续鼠标切换、无角色行的菜单、靠右边缘时横向翻转、
480px 高视口、选项实际溢出滚动、搜索焦点和模型选择。截图与验收环境保持忽略，
不把捕获的会话记录加入源码。现有运行配置按钮显示测试全部 11 项通过；源码格式与
lint 通过。组件类型检查仍受借用依赖中缺少 Electron 依赖及 shared/ACP 导出过旧影响。
隔离环境不能证明完整 Storybook 或打包后的 Electron 验收通过。

左右两侧都放不下菜单的极窄窗口，仍需单独设计导航；本次不引入逐级进入形态。
当前实现说明见 [Composer 运行配置](../../../docs/sessions-run-config.md)。
