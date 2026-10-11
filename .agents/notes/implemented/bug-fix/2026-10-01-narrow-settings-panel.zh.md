# 保持窄窗口中的桌面设置可用

Status: implemented
Translation: current
PR: [#1198](https://github.com/LodyAI/Lody/pull/1198)

[English](2026-10-01-narrow-settings-panel.md)

## 摘要

桌面设置在面板只有 420px 宽时仍保留固定 240px 导航列，挤压 Role 名称并裁切新增角色按钮。
面板现在在宽度不超过 720px 时把同一导航列折叠为图标栏——收起标签与分组标题，
每行保留可访问名称和悬停提示——并允许标题操作换行。
两个宽度共用同一棵导航树，调整窗口尺寸保留选中态、键盘焦点范围和打开的编辑器草稿。
浏览器回归测试用合成目录数据验证实际几何与嵌套编辑器交互；打包 Electron 和真实云工作区
不属于本次验证范围。

## 根因与决策

500px 桌面视口中的 `84vw` 面板为 420px，禁止收缩的 240px 侧栏只给内容区留下 180px，
还需扣除内边距。不换行的标题与操作行超出剩余空间，又被面板裁切。桌面设备在窄窗口中
保留桌面 renderer 是有意行为，见
[紧凑桌面决策](../feature/2026-09-25-compact-desktop-layout.zh.md)。

[`desktop-settings-modal.tsx`](../../../../packages/components/src/components/settings/desktop-settings-modal.tsx)
拥有具名 inline-size 容器；同一棵导航树服务两种宽度，容器查询就地折叠——不需要同步第二套
呈现，焦点范围也能跨越缩放。低于断点时，列变为 48px 的图标行：侧栏自己的图标、同样的分组、
当前行保持同样的选中底色。每行保留可访问名称，图标栏态下悬停显示提示。短窗口滚动这一列本身；
选中分类或列尺寸变化时露出当前行——只滚动列，不滚动正文。方向键无法离开 Base UI 弹窗——popup
在 portal 边缘拦截 composite 键（方向键、Home/End）的冒泡——因此 window 层的范围导航从未收到
它们，侧栏方向键在弹窗内一直无效。`FocusScope` 现在在 scope 元素自身的 keydown 上执行所属范围
的导航与 Left/Right 范围切换，晚于内部控件、早于 popup 拦截。可用时仍有带可访问名称的报告问题
按钮，图标栏态下仅显示图标。标题和操作组允许换行；窄面板标题去掉重复的内层列边距。

只缩小侧栏仍没有足够阅读宽度；内容上方的导航条带试过三种形态——内嵌边距中的分段条带、
分组下划线行、贴边条带——每种读起来都像外来的控件条。面板自己的侧栏改为折叠，如同应用侧栏
收为图标列。图标栏的代价是分类只剩图标，直到悬停或由辅助技术读出；标签在完整宽度回归。
嵌套编辑器的尺寸、焦点管理和滚动继续由
现有弹窗与表单负责，包括[内容区居中规则](2026-09-26-settings-editor-dialog-placement.zh.md)。

## 验证

[`DesktopSettingsModal` stories](../../../../packages/components/src/stories/DesktopSettingsModal.stories.tsx)
添加只读合成 Role 目录，不连接传输或写入真实账户。
[`desktop-settings-layout.spec.ts`](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
验证 400、500、707、900、1180px 下实际面板几何、分类一致性、图标栏滚动、键盘选择、
选中项可见与单列导航、缩放草稿保留、中文暗色操作、
焦点循环、Escape 返回，以及 707×394 下正文滚动且 Cancel/Save 保持可见。

十项浏览器测试全部通过。恢复修复前的主弹窗后，500px 几何测试失败：Add role 右边界为
508.125px，面板右缘为 460px。短窗口中导航列也能将末项滚入视野内。
组件类型检查和根格式化通过；全仓验证结果在 PR 中与这些行为检查分开报告。

[桌面窗口 Spec](../../../../specs/desktop-windows.zh.md) 仍为 draft。
本次变更不能证明真实保存、派发流程或打包 Electron 的渲染，不改变 Role 目录及授权契约。
