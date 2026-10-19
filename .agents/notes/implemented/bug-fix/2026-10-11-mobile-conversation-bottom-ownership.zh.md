# 移动端对话底部滚动的控制权

Status: implemented
Translation: current

[English](2026-10-11-mobile-conversation-bottom-ownership.md)

## 摘要

快速向下滚动会与引擎反复写回底部竞争，composer 布局变化也可能在没有对话手势时恢复跟随。
控制器现在以真实滚动范围内的逻辑位置采样弹性越界值，只凭对话输入恢复跟随，并等待原生
滚动结束后再补齐底部附近的偏差。composer 在真实 flex 布局之外测量内容，避免短暂扩大
viewport 导致阅读位置丢失。模型、React 接线与 Chromium、WebKit 布局验证覆盖了这些路径；
iOS 原生惯性效果仍未验证。

## 定位与决策

本实现采用[原始分析](../../proposed/bug-fix/2026-10-11-mobile-conversation-bottom-ownership.zh.md)
中的控制器与 composer 修复方案，保留其真机验收边界。

本修复部分替代[滚动引擎决策](../architecture/2026-09-27-conversation-scroll-engine.zh.md)中的
立即按 4px 恢复跟随和清理输入证据的行为，保留锚点所有权、有界事务和相对布局补偿。
它实现既有[对话滚动意图](../../../../specs/conversation-scroll.zh.md)：布局变化本身不能要求跟随。

- `onScrollEvent` 原先仅凭位置和方向恢复跟随；进入 follow 又清掉惯性证据，后续原生位移
  便被当作 unknown 并写回底部。超出最大值的弹性 offset 会继续触发 reset，父组件提交也能触发。
- 控制器现在在分类、锚点、覆盖判断、写后读回及稳定判断中使用范围内的逻辑位置。
  范围外回弹本身不能释放 follow，也不会仅因越界而触发修正写入。
  相对布局补偿为 `scrollBy` 单独保留原始 host offset：从目标位置减去截断后的 offset，
  会让阅读锚点漂移一个回弹距离。写入仍需存在逻辑补偿，或滚动范围变化使弹性 offset 进入
  有效范围；弹性越界本身不能触发写入。
- wheel 和导航键监听在两个方向上提供输入证据，排除编辑目标、嵌套滚动和 wheel 缩放。
  触摸惯性与按住指针保留既有分类。准确到达边界时恢复跟随，但不清掉原生输入证据，也不增加修正。
  距边界 4px 内以及记住的旧底部都等到 `scrollend` 再恢复跟随。
  wheel/key 必须能沿输入方向滚动 viewport；未确认的证据以注入的帧时钟计算，
  在首个动画回调 100ms 后过期。Chromium 的 wheel/key 位移可能经过多个回调才开始，
  在一两个回调后就过期会拒绝真实原生滚动。回调只处理输入过期，不测量、不运行事务或写入 offset。
  方向资格同时参考最近接受的位置和当前 offset，因为 passive wheel 可能在原生位置已到边界后才交付。
  导航键改在冒泡阶段监听，让行内控件先阻止默认行为，排除按钮上的 Space。
  body 按键必须由真实 viewport 位移确认后才释放 follow：Chromium 与 WebKit 在点击消息后，
  虽然焦点仍为 body，也会滚动对话；没有点击时 body 按键不移动它。
  这堵住了“未产生滚动、没有 scrollend，却误分类后续布局位移”的路径。
- unknown 位移和 clamp 清除已记住的手势底部。scroll 事件先采样当前 viewport 高度再判断 clamp，
  因为浏览器先派发滚动步骤，再交付 ResizeObserver。滚动帧不再采样内容 rect 和计算后的
  padding，resize/事务路径仍保留这些测量。对话外的 focus、pointer 输入和
  `beforeinput` 清理旧证据，composer 已有焦点时继续输入也生效。
  显式导航和隐藏 viewport 同样清理之前的输入证据。
- `ChatComposer` 使用临时、隐藏且 fixed 的 textarea，复制已解析的文字及盒模型参数，测量后立即移除，
  然后一次性写入真实高度。空草稿继续跳过测量，直接使用最小高度。

## 证据与验证边界

既有模型测试扩展了弹性采样、回弹期间反复提交、准确到达边界后保留输入证据、滚动结束前不补齐几像素、
unknown 位移、活动手势被 viewport clamp 结束及旧底部恢复等场景。React 接线测试派发真实
wheel/key/touch 事件，以及 composer 的 focus、pointer 和编辑事件。
两套测试保留既有行为覆盖及模型的 40 组固定随机种子，初版模型/接线修复通过 103 个测试。

评审回归复现了行高变化叠加弹性越界时的 24px 阅读锚点漂移，以及没有原生位移时留下的
wheel/key 证据。模拟器现在让 `scrollBy` 加到真实弹性位置上，两套帧 harness 都在输入
过期的动画回调之前派发滚动步骤。覆盖底部阅读锚点上方和下方增长、顶部负向越界时内容
inset 变化、边界 wheel、body 按键、被行内控件阻止的按键、按钮 Space，以及未产生位移的
可滚动 wheel/key 输入。已确认的输入仍保留到 `scrollend`，包括准确到边界和近边界的情况。
还覆盖 offset 先于 wheel 交付，以及多个原生启动帧尚未产生位移的情况。
activity-row fixture 现在为合成的向上 wheel 提供底部 offset；在 offset 为零时向上 wheel，
不能模拟离开跟随。

前后对比在隔离 clone 中使用修复前 `4922c038c` 和 PR 版本 `4601077e2` 的真实产品代码，
配以相同的当前行为测试 fixture。12 个针对性的模型、React 接线和 composer 用例中，
修复前 11 个失败，修复后 12 个全部通过；余下那个 viewport clamp 用例在旧版就已通过。
对比排除了要求新 `onReaderInput` API 的用例，缺少新方法的错误不作为原问题的证据。
修复版本完整运行这三套测试，共 104 个全部通过。
合并 `main` 的 `a8e1cf548` 后，这三套测试与更新后的对话后端测试共同通过，共 109 个；
composer 浏览器回归在 Chromium 和 WebKit 中也再次通过。
合并没有改动滚动控制器、React 接线、composer 或测量函数。

| 相同场景 | 修复前 | 修复后 |
| --- | --- | --- |
| +24、+18、+12、+6px 弹性采样，包含父组件提交 | 4 次修正写入 | 0 次修正写入 |
| 原生位移停在距底部 3px，尚未 `scrollend` | 立即进入 follow 并写回底部 | 保持 read，不写入；`scrollend` 后恢复 follow |
| 无对话输入，浏览器移至底部附近，再缩小 viewport 40px | 恢复 follow，额外移动 40px | 保持 read，不额外移动 |
| 活动手势、短暂 viewport clamp、恢复原高度 | 阅读位置丢失 40px | 保留原阅读位置 |
| composer 获得焦点、已有焦点时编辑或对话外 pointer 输入 | 旧证据误恢复 follow | 保持 read，追加输出不移动位置 |
| React composer 测量 | 测量时真实高度变为 `auto` | 测量时保留之前的真实高度 |

复现时，在安装锁定依赖的临时 clone 中 checkout `4922c038c`，只用
`git show 4601077e2:<path> > <path>` 覆盖 `packages/components/` 下的三个测试文件，
保留旧版产品源码。运行：

```sh
NODE_ENV=test pnpm --filter @lody/components exec vitest run \
  tests/conversation-scroll-engine.test.ts \
  tests/engine-conversation-scroller.test.tsx \
  tests/chat-composer-autoresize.test.tsx \
  -t 'keeps the reading anchor when a viewport clamp|waits for the native fling|ignores elastic|never follows after|downward .* input re-arms|composer .* clears|grows through 11 rows'
```

恢复覆盖的测试文件，再 checkout `4601077e2` 并运行相同命令，即为修复后对比；
去掉 `-t` 可运行全部 104 个相关测试。

`tests/e2e/conversation-scroll-engine.spec.ts` 的浏览器回归在真实 flex 布局中执行产品测量函数，
验证换行及中英文混排，所属回归在 Chromium 和 WebKit 中均通过（两个浏览器测试）。
Chromium 145 和 WebKit 26.0 的补充布局实验确认恢复真实高度也不能恢复旧阅读位置。
composer 高度为 240px 时，旧 `auto` 测量会把对话
viewport 从 480px 短暂扩大到 696px，让距底部 80px 的阅读位置丢失 136px；
恢复 textarea 高度不能恢复阅读位置。新的镜像测量得到相同内容高度，同时保持 viewport
高度和阅读位置不变。

最终评审回归在模型、React 接线、composer 与 activity-row 四套测试中全部通过，共 132 个，
包含模型的 40 组固定种子。独立探针把产品控制器接入 Chromium 和 WebKit 的原生 PageUp 与
wheel 输入，确认向上位移释放跟随、向下到达边界恢复跟随。探针使用合成行几何以及真实
浏览器 offset/事件，不模拟 iOS 甩动。

最初的 CI 失败来自 composer fixture 把初始高度写死为 48px，实际包含 padding 后为 52px。
修正后的不变量仍验证增长和缩小测量时真实高度不变。修正后，原先失败的 components 3/3
命令通过 185 个文件、1,755 个测试。最终评审修订再次运行同一命令，185 个文件、1,767 个测试全部通过。
合并提交 `b0bc3c54d` 的 GitHub 检查全部通过。
评审期间的完整 components 测试通过 5,105 个，发现两个 activity-row fixture 失败；
两者已修正，并在最终的 132 个回归测试中通过。

仓库格式化、类型检查和 lint 通过。完整 `pnpm check` 通过类型检查和 lint，随后在 CLI
4,002 个测试通过、两个未改动的 Roost 历史用例超时 30 秒后停止：签名前缀恢复/旧写入者隔离，
以及旧目标编辑拒绝/派生缓存重建。CLI 源码与依赖 manifest 和合并后的 main 相同，
没有修改断言或延长超时。验证在安装锁定依赖的隔离公开 clone 中运行，使用中性临时目录、
系统 Git 并清除继承的 `GIT_EXEC_PATH`，排除了之前的宿主 ESM/传输包装器失败。
这些结果不能宣称本地全量检查已通过。
i18n、Code Collab 引用、平台、进程及公开边界检查在合并 main 后分别通过。
滚动修复没有改动 manifest 或 lockfile，保留了 main 的 SDK 更新。文档检查仍有缺失子模块
及既有文档造成的 82 个基线错误，没有注册 SHA 保护主题。

WebKit 验证使用仓库锁定的 Playwright Linux 构建，布局实验的移动 viewport 为
390×844 并启用触摸能力。控制器弹性采样由模型注入，并非真实 iOS 甩动产生。
这些检查不能证明 iOS 原生动画、键盘或手势效果。
真机验收仍需覆盖快速向下甩动、底部回弹、向上打断，以及 composer 刚获得焦点和原本已有焦点时的输入。
阅读模式下的流式输出和键盘显示/隐藏必须保留锚点；follow 仍须跟踪新输出和最终 viewport 变化。

## 权衡

没有增加 timer 或布局重试。动画回调按 100ms 确认窗口清理未确认的 wheel/key 证据，
不运行事务或修正写入。窗口内的原生位移归属于有效输入，之后的位移必须有新证据。
没有原生 `scrollend` 的宿主仍可在准确到达底部或显式导航时恢复跟随，
但近底部和旧底部恢复需要该原生信号。没有通过禁用 overscroll 消除弹性采样：范围内采样直接修复
引擎控制权，不改变原生手势表现。真实行高增长时的布局补偿仍保留已记录的 WebKit 惯性中断可能，
本修复没有移除那项独立成本。

PR：[#1445](https://github.com/LodyAI/Lody/pull/1445)。
