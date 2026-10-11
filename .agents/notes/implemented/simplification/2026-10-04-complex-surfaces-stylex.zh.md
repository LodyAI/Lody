# 逐步将复杂组件界面迁移至 StyleX

Status: implemented
Translation: current

[English](2026-10-04-complex-surfaces-stylex.md)

## 摘要

`@lody/components` 中一些大型页面仍通过 utility 类和行内样式定义外观。此次迁移将既有 StyleX 做法用于十个页面或面板，同时保留现有外观与行为。组件继续使用语义化的模块本地样式，在匹配时复用产品表面和 token，并在没有等价项时保留原值或动态样式。首批迁移涉及 29 个组件模块；浏览器检查中，44 个抽样状态的文本和布局保持一致，小范围像素差异记录于下文。替换会改变外观的既有 primitive 和包装组件覆盖继续保留。

## 决策

在组件模块内使用模块级 `stylex.create` 定义样式，并以语义角色命名，例如选中行、弱化标签或面板表面。当前结果有匹配项时，组合使用已有的 `@lody/ui` 区域表面与产品 token。token 集合中没有等价项时，保留 CSS 变量、尺寸及其他原值。动态几何和外部渲染引擎所需的样式留在现有运行时边界。UI primitive 已文档化的 props 能复现当前外观时，使用这些 props。

用户明确要求保留原有外观，优先于移除既有 primitive 视觉覆盖。没有像素等价的公开 API 时，保留原 utility 覆盖；本轮不改成竞争的调用方 StyleX 类、不替换控件，也不扩大设计系统。例外包括 Send/Stop 材料、12/14px Spinner 尺寸和颜色、Skeleton 材料、标注选中态及 Textarea 填充、文件操作文字规格，以及 Dialog/Drawer/Field 排版或分隔线。原生元素和调用方布局仍在迁移范围内。这些例外属于后续 primitive 工作，不新增 token 规则或公开 API 保证。

内部 utility 会覆盖 StyleX 的旧包装组件，保留原有调用方布局覆盖，包括 TreeView padding、BaseHeader、ResizableHandle、DrawerContent 和横向 scrollbar。Dialog 内容通过已有公开布局 `style` prop 保留零 padding 和 gap。这些边界避免在本轮改变 CSS 层叠或 primitive 内部实现。将边框和动画简写展开为受支持的完整属性声明：已安装的 StyleX 0.19 转换会静默忽略部分简写。alpha 替换会改变渲染像素时，保留原 Tailwind color-mix 表达式。保留 `cn()` 的实际合并结果，包括分享卡片任意字号覆盖后被移除的行高类。

主题条件保留在 CSS 中，包括 `.dark`、`.dark-scope` 和 `.light-scope` 排除。hover、focus 与 Radix 状态样式保留为 CSS，不增加 React state。标签胶囊配色继续由 `shared/tab-pill-strip.tsx` 单独负责；既有 class 导出由两个会话标签栏共同使用的 StyleX 定义生成。

渐进迁移以当前外观和行为为参照。此次只改变样式归属，不改变产品意图，因此无需修改 Spec。当前范围包括十个完整页面或面板；所列子组件属于相应界面的实现单元，不额外计作页面：

| 界面 | 组件模块 |
| --- | --- |
| Usage | [`stats-setting-pure`](../../../../packages/components/src/components/settings/stats-setting-pure.tsx)、[`usage-calendar-skeleton`](../../../../packages/components/src/components/settings/usage-calendar-skeleton.tsx)、[`usage-calendar-visualization`](../../../../packages/components/src/components/settings/usage-calendar-visualization.tsx)、[`usage-stacked-area-chart`](../../../../packages/components/src/components/settings/usage-stacked-area-chart.tsx) |
| 集成设置 | [`integrations-setting`](../../../../packages/components/src/components/settings/integrations-setting.tsx) |
| 定时任务工作区 | [`schedules-workspace`](../../../../packages/components/src/components/schedules/schedules-workspace.tsx)、[`schedule-list`](../../../../packages/components/src/components/schedules/schedule-list.tsx)、[`schedule-split-view`](../../../../packages/components/src/components/schedules/schedule-split-view.tsx) |
| 定时任务详情 | [`schedule-view`](../../../../packages/components/src/components/schedules/schedule-view.tsx)、[`schedule-proposal-notice`](../../../../packages/components/src/components/schedules/schedule-proposal-notice.tsx)、[`schedule-destination-rows`](../../../../packages/components/src/components/schedules/schedule-destination-rows.tsx) |
| Browser | [`managed-preview-surface`](../../../../packages/components/src/components/sessions/managed-preview-surface.tsx)、[`session-browser-toolbar`](../../../../packages/components/src/components/sessions/session-browser-toolbar.tsx)、[`session-browser-panel-view`](../../../../packages/components/src/components/sessions/session-browser-panel-view.tsx)、[`preview-connection-status`](../../../../packages/components/src/components/sessions/preview-connection-status.tsx) |
| 文件预览 | [`session-file-content-view`](../../../../packages/components/src/components/sessions/session-file-content-view.tsx)、[`session-file-error-state`](../../../../packages/components/src/components/sessions/session-file-error-state.tsx)、[`session-file-quick-open`](../../../../packages/components/src/components/sessions/session-file-quick-open.tsx) |
| Changes | [`session-changes-sidebar`](../../../../packages/components/src/components/sessions/session-changes-sidebar.tsx)、[`session-conversation-diff-panel`](../../../../packages/components/src/components/sessions/session-conversation-diff-panel.tsx) |
| 会话对话 | [`session-chat-interface`](../../../../packages/components/src/components/sessions/session-chat-interface.tsx)、[`session-chat-input-area`](../../../../packages/components/src/components/sessions/session-chat-input-area.tsx) |
| 会话主页面与 Tabs | [`session-detail`](../../../../packages/components/src/components/sessions/session-detail.tsx)、[`session-tab-bar`](../../../../packages/components/src/components/sessions/session-tab-bar.tsx)、[`desktop-session-detail-layout`](../../../../packages/components/src/components/sessions/desktop-session-detail-layout.tsx)、[`session-side-panel-tab-bar`](../../../../packages/components/src/components/sessions/session-side-panel-tab-bar.tsx) |
| Usage 分享图片编辑器 | [`usage-share-image-dialog`](../../../../packages/components/src/components/settings/usage-share-image-dialog.tsx)、[`usage-share-card`](../../../../packages/components/src/components/settings/usage-share-card.tsx) |

此次迁移延续[共享视觉提示](../../implemented/simplification/2026-09-26-shared-cues-stylex.zh.md)、[Provider 就绪标记](../../implemented/simplification/2026-09-26-agent-readiness-stylex.zh.md)、[会话控件](../../implemented/simplification/2026-09-26-session-controls-stylex.zh.md)和[就绪标记头像外观](../../implemented/simplification/2026-09-26-agent-readiness-avatar-stylex.zh.md)中的组件本地样式归属、语义 token 复用及原值兼容原则。

## 验证

验证使用分别安装依赖的基线和候选 checkout，基线 commit 为 `9bdac2851da16cdf5bae2f22d811e721ccf58afb`，依赖 pnpm lockfile 与精确的 ACP 合同 gitlink。组件类型检查、生产 Storybook 构建，以及全部 29 个源码模块的实际 StyleX 转换通过。范围内格式和类型感知 lint 无错误或新增警告；补充显式类型消除了两条迁移警告。最终 14 个 owning 测试套件的 201 项测试全部通过，包括标注定位、resize 时序、选择、文件操作和标签行为。更广的组件运行有 552 个套件通过，仅原有 boot-shell 存储测试失败：4757 项通过、1 项失败；基线为 4758 项通过及同一项失败。数量减少一项，是因为删除了只断言 utility 类的标签宽度测试；有效行为覆盖仍保留。

过滤样式声明和属性后的 AST 对照，未发现 hook 调用及依赖、事件处理表达式或 JSX 标签拓扑变化。样式专属 prop 调整及动态 grid 列宽传递另行审阅。生产构建后最终修改仅为 StyleX 回调参数增加类型；擦除类型并归一化可选箭头参数括号后，编译声明和 JavaScript 与已构建快照一致。

浏览器对照通过合成 fixture 渲染真实组件，固定时钟，等待字体及图片就绪，减少动画，强制 light/dark 配色并采用相反的系统偏好，覆盖桌面或 390px viewport。44 个抽样状态的文本相同，匹配元素的几何位置差异为零。30 张截图 RGB 像素一致；其余 14 张有小范围像素差异，每通道最大为 3/255，整图平均绝对误差最大为 0.001815/255。这属于组件抽样验证，不代表普遍逐像素一致、完整 Electron shell、认证集成、导出 PNG 或所有交互及 viewport 都已覆盖。

Code Collab import、platform boundary 和翻译 key guard 通过。主嵌套 worktree 的 docs 检查仍有基线的 62 项子模块断链错误与 64 项警告，未注册 SHA topic。public-boundary 检查在该目录也无法解析缺失的 ACP 子模块 workspace。manifest、包组合及这些无关发现均未改变。不宣称完整根级 `pnpm check` 或 Electron 构建通过。
