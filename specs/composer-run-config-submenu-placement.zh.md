# Composer 运行配置子菜单位置

Status: draft
Translation: current

[English](composer-run-config-submenu-placement.md)

用户在桌面 Composer 的角色、Agent、模型、交互、推理及 Provider 自定义选择子菜单之间切换时，
所有子菜单相对各自触发行采用同一定位规则。触发行负责展开和选择，也是子菜单的定位锚点。
此规则适用于新建聊天页、子标签草稿及已有会话，也适用于没有角色行的菜单。

空间足够时，纯选项子菜单顶边与触发行顶边对齐，不相对整个主菜单居中，也不把底边限制在
主菜单底边。

模型子菜单提供搜索时，过滤期间仍使用同一个 Model 触发行锚点。
结果变少时面板自然收缩；无结果时仅显示搜索框和空结果提示。
不得保留未过滤尺寸或上一次屏幕位置。定位组件根据触发行和当前面板尺寸重新计算，
空间允许时回到选项区域与触发行对齐。搜索框仍在面板顶部，结果或空结果提示在其下方。
面板上移搜索框高度及其后间距，使选项区而非输入框从 Model 行旁开始。
此偏移仅取决于是否有搜索框，不依赖查询或保存的屏幕坐标。
仅选项区域滚动，搜索框保持可见；过滤改变弹层尺寸时，
不要求搜索框的屏幕坐标不变。不带搜索的短模型菜单仍按内容决定尺寸。

子菜单优先向 inline-end 展开（LTR 向右，RTL 向左），空间不足时可以翻到另一侧。
纵向碰撞允许偏离触发行对齐，通过平移保持弹层留在视口内。
现有视口留白、高度限制、滚动、搜索焦点及选择行为继续生效。
本规则不引入左右均放不下子菜单时的主菜单内部逐级进入形态。
视口变化时，仍允许调整搜索面板尺寸和位置以保持可用。

## 证据

- [桌面运行配置菜单](../packages/components/src/components/sessions/desktop-run-config-menu.tsx)
- [产品组件 Story](../packages/components/src/stories/ComposerRunConfigMenu.stories.tsx)
- [定位决策与验证限制](../.agents/notes/implemented/bug-fix/2026-09-30-composer-cascading-submenu-placement.zh.md)
- [锚定触发行的模型搜索](../.agents/notes/implemented/bug-fix/2026-09-30-model-search-trigger-anchor.zh.md)
