# 把 Mermaid 图上的滚轮还给页面

Status: implemented
Translation: current

[English](2026-09-09-mermaid-diagram-gestures.md)

## 摘要

Streamdown 把每一张渲染出的 Mermaid 图包进一个平移/缩放画布，其非 passive 的 `wheel` 监听器会调用
`preventDefault()`，因此只要指针恰好停在图上，滚动会话就会戛然而止并转为缩放该图；
`controls.mermaid.panZoom: false` 只隐藏该画布的按钮，并不移除它的监听器。消息中的图现在是静态预览：
`markdown-renderer.tsx` 在捕获阶段接住滚轮并重新派发一个不可取消的副本，使会话自身的滚轮监听器仍能
看到该手势，同时用 `!important` 覆盖把 `touch-action` 与光标还给页面。画布行为移到了全屏查看器，在那里
触控板捏合（带 ctrl 的滚轮）围绕指针缩放，按住鼠标键可拖拽。触摸平移仍交给浏览器的滚动，这也是触摸屏
上的双指捏合被刻意省略而非做一半的原因。

## 决策

两个界面，各一条规则。消息中的图只负责打开查看器，别无其他；查看器是唯一的画布。

Streamdown 的画布是从外部被中和，而不是被移除，因为该包没有提供关闭它的方式：

- `wheel` 在 markdown 根节点上、于捕获阶段被拦截，位置高于承载监听器的画布元素。拦截器从不调用
  `preventDefault()`——被恢复的行为正是浏览器自身的滚动。
- 仅用 `stopPropagation()` 还会把该手势对更上层会话的滚轮监听器一并隐藏：释放「贴底」
  （`use-sticky-scroll.ts`）与放弃大纲跳转（`view.tsx`）都监听在滚动视口上。因此会从 markdown 根节点
  重新派发一个不可取消的 `WheelEvent` 副本，其传播路径不包含该画布。
- `touch-action: none`、平移变换与 `grab` 光标都是画布上的内联样式，因此 `MARKDOWN_BASE_CLASSNAME`
  用 `!important` 覆盖这三者。把变换钉住，可以让画布残留的指针拖拽在视觉上失效，而无需拦截
  `pointerdown`——拦截会把该事件对 markdown 之上的「点击外部关闭」与选区 handler 隐藏。

在查看器中，带 ctrl 或 meta 的滚轮会被接管（否则 Chromium 会把它用于缩放窗口）并围绕指针缩放。锚定点
通过滚动该表面来还原，其度量基于图的盒模型而非滚动偏移，因为该表面会把放得下的图居中，而这个偏移并不
与缩放成正比。按住鼠标或触控笔按键可平移；移动过图之后的释放不算作「点击图外」从而不会关闭。

双指触摸捏合未实现。自定义捏合需要从浏览器手中夺走 `touch-action`，这意味着要为该查看器本就要服务的
手机场景重新实现惯性平移。触摸改用控制栏缩放。不变量见
`packages/components/src/components/ai-gui/mermaid-diagram-rendering.md`。

## 替代方案

- **给 `streamdown` 打补丁。** 在包内遵守 `panZoom: false` 才是语义上正确的修复，而本仓库已经带有十一
  个补丁。但它唯一的构建产物是一个单行压缩的 `dist` chunk，因此 unified diff 会把整个 bundle 重述一遍，
  根本无法评审。
- **用自定义 `plugins.renderers` 条目替换 mermaid 块。** 能完全掌控，但同时也要接管懒渲染、流式与错误
  路径，以及图的复制/下载菜单，而这些都没有导出。
- **给画布加 `pointer-events: none`。** 没用：pointer-events 只影响命中测试，而以后代为 target 的事件，
  其传播路径仍会经过该画布。

## 证据与限制

`tests/markdown-mermaid-fullscreen.test.tsx` 在 jsdom 中渲染真实的 Streamdown 块。新的滚轮用例断言
`defaultPrevented === false`，并断言消息之上的监听器仍收到一次相同 `deltaY` 的事件；把拦截器从
`markdown-renderer.tsx` 中移除后，该用例会在 `defaultPrevented` 上失败，因此它守护的是所报告的缺陷，
而不是复述实现。查看器用例断言普通滚轮不被干预、带 ctrl 的滚轮被接管并把缩放读数从 100% 移到 122%、
拖拽会改变 `scrollLeft`/`scrollTop`，以及释放不会关闭查看器。`computePinchZoomFactor` 与
`computeAnchoredScrollCorrection` 是纯函数，并就可逆性、档位边界与锚定点做了单元测试。

该文件中全部 16 个测试通过，`tests/markdown*` 中的 105 个也通过，`packages/components` 类型检查通过。
三处 CSS 覆盖会编译为 `!important` 声明，通过对 `src/tailwind/index.css` 运行 Tailwind CLI 验证。

Chromium 通过 Playwright 针对本地 Storybook 驱动真实的 `MermaidStyleReview` story，并为该 story 加了
滚动容器，因为 Storybook 预览会裁掉自身溢出。修复后，图上 300px 的滚轮使该容器滚动 300px——与旁边散文上
的对照滚轮相同——图报告 `touch-action: auto`、无变换、`zoom-in` 光标。在预览上拖拽后其变换仍为 `none`，
释放则打开查看器。在查看器中，带 ctrl 的滚轮把缩放读数从 121% 移到 148% 而不缩放窗口，普通滚轮把表面
从 69 平移到 177 且不改变缩放，150 x 120 的拖拽平移到水平极限并在竖直方向恰好移动 120px，查看器保持
打开，随后被 Escape 关闭。

在同一会话中仅回滚 `markdown-renderer.tsx` 即复现了报告：图上的滚轮让容器停在 0，而对照仍滚动 300，
`touch-action` 为 `none`，拖拽让预览停在 `matrix(0.9, 0, 0, 0.9, 100, 60)`——既被位移，又保留着被吞掉的
滚轮带来的缩放。

首次 CI 运行在没有失败测试的情况下失败：测试时序的变化暴露了一个无关套件中潜伏的 teardown 竞态，记录于
[act 之外的 React commit](../testing/2026-09-09-react-commit-teardown-leak.md)，并在同一个 pull request
中修复。

后来的一个决策部分取代了本决策：消息中的图现在可以通过点击激活为画布，全屏入口移到了该块的操作栏。
下文的滚轮规则不变——参见
[点击把 Mermaid 图变成画布](../feature/2026-09-10-mermaid-click-to-activate.md)。

限制：未验证触摸；`touch-action` 的修复是计算样式观察，不是手指在手机上的实测，双指捏合按设计缺席。
未运行完整的 `pnpm check`——该 worktree 必须先初始化 submodule 才能安装，而该套件覆盖范围远超改动文件。
两次完整的 `packages/components` 运行各失败一个无关测试，且两次不同（先是 `markdown-streaming-reparse`，
后是 `avatar-cache`）；两者单独运行都通过，因此是负载抖动而非回归。环境中的 `NODE_ENV=production` 会把
React 解析到生产构建，其中缺少 `act`；该套件以 `NODE_ENV=test` 运行。
