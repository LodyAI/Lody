# 保持窄窗口中的桌面设置可用

Status: implemented
Translation: current
PR: [#1198](https://github.com/LodyAI/Lody/pull/1198)

[English](2026-10-01-narrow-settings-panel.md)

## 摘要

桌面设置在面板只有 420px 宽时仍保留固定 240px 导航列，挤压 Role 名称并裁切新增角色按钮。
面板现在在宽度不超过 720px 时，在内容上方使用单行横向滚动的分类 Tab——条带本身即是 Tab
轨道、贴边不留内边距，两端带滚动箭头——并允许标题操作换行。
两种导航共用过滤后的分类与选择处理，调整窗口尺寸保留页面和打开的编辑器草稿。
浏览器回归测试用合成目录数据验证实际几何与嵌套编辑器交互；打包 Electron 和真实云工作区
不属于本次验证范围。

## 根因与决策

500px 桌面视口中的 `84vw` 面板为 420px，禁止收缩的 240px 侧栏只给内容区留下 180px，
还需扣除内边距。不换行的标题与操作行超出剩余空间，又被面板裁切。桌面设备在窄窗口中
保留桌面 renderer 是有意行为，见
[紧凑桌面决策](../feature/2026-09-25-compact-desktop-layout.zh.md)。

[`desktop-settings-modal.tsx`](../../../../packages/components/src/components/settings/desktop-settings-modal.tsx)
拥有具名 inline-size 容器和两种导航。容器查询选择布局，不重挂载页面。紧凑导航是贴边面板的
`Tabs` 条带：条带本身就是托盘，不留内边距，承载账户与所有可用分类——保留能力、成员数量和
原生壳过滤。两端箭头翻页浏览溢出分类，边缘渐隐提示遮挡；选中分类或导航尺寸变化时
露出当前项。只滚动导航，不滚动正文。方向键无法离开 Base UI 弹窗——popup 在 portal 边缘拦截
composite 键（方向键、Home/End）的冒泡——因此 window 层的范围导航从未收到它们，侧栏方向键在
弹窗内一直无效。`FocusScope` 现在在 scope 元素自身的 keydown 上执行所属范围的导航与
Left/Right 范围切换，晚于内部控件、早于 popup 拦截；Tab 条带的 composite 在两者之前自行处理
Left/Right。可用时仍有带可访问名称的报告问题按钮。
标题和操作组允许换行；窄面板标题去掉重复的内层列边距。

只缩小侧栏仍没有足够阅读宽度；把所有导航行放到内容上方会挤占短窗口的滚动空间。
曾考虑下拉选择器，但相邻分类也需多一次点击才能发现；内嵌边距中悬浮的分段条带与分组下划线行
都尝试过并被否决。让托盘本身成为条带保留了控件的辨识度而不留内边距；代价是较远分类
需要横向滚动，由箭头和渐隐边缘提示。嵌套编辑器的尺寸、焦点管理和滚动继续由
现有弹窗与表单负责，包括[内容区居中规则](2026-09-26-settings-editor-dialog-placement.zh.md)。

## 验证

[`DesktopSettingsModal` stories](../../../../packages/components/src/stories/DesktopSettingsModal.stories.tsx)
添加只读合成 Role 目录，不连接传输或写入真实账户。
[`desktop-settings-layout.spec.ts`](../../../../packages/components/tests/e2e/desktop-settings-layout.spec.ts)
验证 400、500、707、900、1180px 下实际面板几何、分类一致性、溢出渐隐、键盘选择、
选中项可见与单行导航、缩放草稿保留、中文暗色操作、
焦点循环、Escape 返回，以及 707×394 下正文滚动且 Cancel/Save 保持可见。

十项浏览器测试全部通过。恢复修复前的主弹窗后，500px 几何测试失败：Add role 右边界为
508.125px，面板右缘为 460px。短窗口中横向导航也能将最后一项保持在面板内。
组件类型检查和根格式化通过；全仓验证结果在 PR 中与这些行为检查分开报告。

[桌面窗口 Spec](../../../../specs/desktop-windows.zh.md) 仍为 draft。
本次变更不能证明真实保存、派发流程或打包 Electron 的渲染，不改变 Role 目录及授权契约。
