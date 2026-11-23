# 保留跨会话虚拟窗口的原生文本选区

Status: implemented
Translation: current

[English](2026-09-20-conversation-text-selection.md)

## 摘要

会话虚拟列表会卸载原生文本选区引用的 DOM 节点，历史正文回收、流式 Markdown 和完成后的折叠也可能独立替换同一段文字。本次实现保留选区经过的完整区间，固定其历史正文引用，并在选区结束前保留正文与折叠展示。会话数据和操作控件继续更新，清除选区后恢复正常虚拟化。Chromium 已验证选区连续性和原生剪贴板内容，但 iOS 选择手柄与 Safari 仍需真机验证；资源占用随选区经过的范围增长。

## 证据与范围

会话使用 Virtua 0.49.1，缓冲范围为 800px，修改前没有传入 `keepMounted`。在包含 100 行合成数据的独立浏览器实验中，滚出窗口会断开选区起点并使选区变空。只保留首尾节点时，原生选区只包含首尾文字；保留完整区间才能得到中间内容。扩大 overscan 只会推迟问题出现的位置。

仅保留 DOM 仍不够：窗口化历史读取器会在可视区引用释放后回收正文。Markdown 重解析、搜索高亮和已完成轮次的折叠也会替换节点。因此，原生选区的生命周期必须同时覆盖数据与展示层。

本次修复恢复共享会话组件的普通文本选择行为，没有新增手势、预测交互或剪贴板格式。[窗口化读取器决策](../architecture/2026-09-10-windowed-reader-integration.zh.md)继续适用。图片分享的勾选状态和手机返回手势边缘区域仍独立存在，参见[移动端分享说明](2026-09-18-mobile-share-as-image.zh.md)。

## 实现与生命周期

- [`use-conversation-text-selection.ts`](../../../../packages/components/src/hooks/use-conversation-text-selection.ts) 在所属 document 监听原生选区和指针事件。pointerdown 或 selectstart 在原生选区建立前保留触及的轮次。pointercancel 允许长按进入系统选择流程；若随后只是无选区滚动，则释放候选状态，避免普通触摸滚动留下冻结的正文。
- 起点、终点、中间轮次，以及滚动目的位置和缓冲范围构成连续保留区间。scroll 捕获阶段先提交 `keepMounted`，再让 Virtua 处理滚动和回收。保留状态使用稳定的轮次 ID 与行 key，每次渲染重新映射虚拟索引，并计入实际的 leading row。
- 每个保留的真实历史轮次同步获取 `ConversationRange`。引用属于稳定的 fact source，不依赖可替换的乐观投影包装。当已接受的投影进入真实历史时，协调逻辑及时接上真实引用，避免可视区引用释放后正文被回收。清除选区、卸载、切换会话或删除轮次时释放引用；加载失败可在后续选择操作时重试。选区引用不会复活已删除的历史。
- [`view.tsx`](../../../../packages/components/src/components/ai-gui/view.tsx) 保留相关轮次的折叠与搜索展开输入，抑制自动跟随纠偏，并在开始选择时取消尚未结束的大纲跳转纠偏。[`markdown-renderer.tsx`](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx) 保留正文、解析输入和搜索装饰输入，用户文本块采用相同机制。真实会话事实和操作状态继续更新。清除选区后显示最新内容并释放保留状态，不强制跳回底部。
- 所选行均已挂载且正文已加载时，不干预原生 `copy`。范围不完整时取消复制并显示本地化重试提示，避免无声地复制缺失内容。实现不自行拼接纯文本，也不覆盖剪贴板格式。

## 方案取舍

预测选择意图无法修复已断开的 DOM 节点。扩大固定缓冲和只保留首尾都存在正确性缺口。彻底关闭虚拟化会失去其性能收益，切换到独立静态阅读器又会增加一套交互界面。因此选择仅在选区存续期间保留相关范围，复用现有历史引用机制。

跨越很长会话会保留较多 DOM 和正文，没有用任意上限截断原生选区。被选正文暂缓展示流式变化，变化仍写入会话模型，并在释放后显示。本次不承诺在显式破坏性操作、任意渲染器类型替换，或浏览器“全选”涉及从未挂载的历史时仍保持完整选区。

## 验证

合成数据 Storybook 场景 `NativeTextSelection` 使用真实 Loro 历史、120 个轮次、最多八个正文的缓存预算以及 leading row。场景提供清除选区和完成轮次的按钮，不包含用户会话记录。

- 六个专项行为测试覆盖完整区间保留、所选文本节点身份、释放后的真实历史回收、不完整复制恢复、触摸取消后进入原生选择、普通触摸滚动，以及乐观消息落入真实历史后的引用交接；部分场景合并在同一测试中。
- 回归范围包括相邻的行身份、轮次布局、Markdown、粘底滚动和会话 hook 测试：八个文件、92 项全部通过。
- 浏览器测试覆盖原生指针选择后跨 41 个轮次复制、反向跨回收窗口选择，以及选中早期正文时完成轮次，三项全部通过。反向选择从初始末尾开始，跨越全部 120 个轮次。测试等待可观察状态，不依赖固定延时。因 Playwright 对应版本浏览器下载未完成，使用临时启动配置运行本机 Chromium 151。
- 组件类型检查、根目录 `pnpm format` 通过，静态检查零错误（57 个已有警告）。文档检查仍为基线的 28 个错误、34 个警告，没有新增链接错误，也未修复无关文档。根目录 `pnpm check` 在 `packages/ignore` 类型检查阶段因缺少已安装依赖（`node:*` 类型与 `vitest`）中止，后续全仓检查阶段未执行。

复现命令：`NODE_ENV=test pnpm --filter @lody/components test conversation-text-selection.test.tsx chat-virtual-rows-identity.test.ts plan-turn-virtual-rows.test.ts markdown-idle-rerender.test.ts markdown-streaming-reparse.test.ts use-sticky-scroll.test.ts sticky-scroll-virtua.test.tsx conversation-view-hooks.test.tsx --maxWorkers=2`；`pnpm --filter @lody/components typecheck`；启动 Storybook 并安装 Playwright Chromium 后执行 `pnpm --filter @lody/components exec playwright test conversation-text-selection.spec.ts --workers=1`。

当前工作树通过忽略的 `node_modules` 链接使用独立临时克隆安装的依赖。由于已有 ACP 子模块清单与根锁文件不一致，临时克隆使用非 frozen 安装；本次未修改仓库清单或锁文件。未声称完成桌面打包或 iOS/Safari 真机验收。

真机待验收：长按并拖动 iOS 两侧选择手柄跨越多屏、反向拖动、松手后继续拖动、调用系统复制菜单、选中期间接收流式文本及完成事件，以及清除后的普通滚动和跟随行为。分别测试返回手势边缘区域内外，以区分独立的手势归属问题。
