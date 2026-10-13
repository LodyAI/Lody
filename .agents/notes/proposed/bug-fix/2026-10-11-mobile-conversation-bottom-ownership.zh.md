# 区分原生边缘运动与对话跟随意图

Status: proposed
Translation: current

[English](2026-10-11-mobile-conversation-bottom-ownership.md)

## 摘要

移动端快速滚动至对话底部时，原生边缘运动可能与引擎的底部校正相互竞争。当前控制器还会在没有对话输入证据时，仅凭浏览器向下位移恢复跟随，导致后续 composer 尺寸变化移动原本处于阅读状态的对话。模型探针确认了弹性越界反复校正、触摸惯性提前吸附和无输入恢复跟随三条路径。提议分别建模逻辑位置、原生运动和用户意图；本次未修改产品代码，原生 iOS 验证仍待完成。

## 发现与证据

后续[实现与验证](../../implemented/bug-fix/2026-10-11-mobile-conversation-bottom-ownership.zh.md)
在 PR #1445 中记录了已完成的控制器、composer 修复和浏览器证据；
本提案保留原始定位及真机验收工作。

本提案延续[滚动引擎决策](../../implemented/architecture/2026-09-27-conversation-scroll-engine.zh.md)，尤其是 10 月 7 日的延迟触摸修复与 I8 不变量，以已有[滚动意图](../../../../specs/conversation-scroll.zh.md)为目标，不修改其产品约定。

- `controller.ts` 的 `onScrollEvent` 对任意向下位移，在距底部 4px 内恢复 follow，没有检查 `movement` 或有效对话输入。随后非 read 分支启动校正事务。`setIntent(follow)` 立即清空 momentum，原生序列却可能仍在运行。
- host 读取 DOM 原始 `scrollTop`，控制器与适配器均未区分弹性越界和内容位置。Safari 在回弹时会报告超出滚动范围的位置，见 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/scrollTop)。越过底部的采样与截断后的 follow 目标不符，因而触发绝对写入。引擎仍是唯一程序写入者，反馈路径的另一方是原生滚动。
- 任意滚动位移都会创建 `gesture`；`writePhase` 在布局变化时记录历史最大位置，也包括 viewport 变化。`rearmAtGestureBottom` 只检查末次向下位移与历史最大位置，没有用户输入来源检查。布局产生的历史底部不能证明用户意图。
- 会话输入为 `ChatComposer` 开启了 `autoResize`。非空草稿每次变化时，effect 都会把真实 textarea 高度设为 `auto`，读取 `scrollHeight`，再恢复到限制后的高度。这可能短暂扩大相邻对话 viewport，使其位置被 clamp，随后最终布局恢复。模型确认：未被观察到的 clamp 在恢复后成为 `unknown`，替换 read 锚点；实际移动端 DOM 是否产生该序列仍未验证。键盘抬升同样改变 composer 布局，两者均不应恢复 follow。

## 可复现的模型结果

使用已有 `ScrollSim` 驱动真实 `ScrollController`：40 条高度与估计均为 100px 的行，600px viewport，默认顶部和底部各 24px。稳定后的最大位置是 3448px。编译命令：

```sh
tsc --target es2022 --module commonjs --moduleResolution node --strict \
  --skipLibCheck --outDir /private/tmp/lody-mobile-scroll-probe \
  --rootDir packages/components packages/components/tests/support/scroll-engine-sim.ts
```

1. 覆盖 host 读取，在位置上叠加弹性偏移，绝对写入时清除此偏移。touch start/end 后分别注入 +24、+18、+12、+6px，在独立任务中调用 `onScrollEvent`。四次均写回 3448px。这证明控制器对弹性采样的响应，不代表已复现用户手机的 compositor 震荡。
2. 释放 follow 并移动至 3348px；开始、结束触摸，在 `scrollend` 前移动至 3445px。控制器切为 follow 并写回 3448px。
3. 跳至第 30 行，未提供 pointer/touch 输入便注入 3445px。控制器从 read 切到 follow。viewport 从 600px 缩至 560px 后，位置变为 3488px。这证明误恢复会传递到后续 composer/键盘尺寸变化，不表示 focus 必然移动到该位置。
4. 在 3368px 阅读，暂时把 viewport 扩到 720px 并应用原生范围截断，再于事件到达前恢复至 600px。引擎把 3328px 当作新 read 锚点，后续 commit 仍保持在那里。这是对 textarea 临时测量的建模，不是应用布局序列的实测。

通过缓存的 Vitest 3.2.4 和独立临时配置，四个诊断探针及已有 70 个模型测试均通过。探针断言的是当前缺陷，只是临时研究产物，不是修复后的回归测试。真实控制器及模拟器依赖图也通过 strict `tsc`。当前 checkout 没有 workspace 依赖，常规包级 runner 不可用。桌面 WebKit 布局实验在启动浏览器时中止，未宣称浏览器或原生设备验证结果。

创建 PR 前已尝试根级 `pnpm check` 与 `pnpm format`，分别因缺少 `tsgo`、`oxfmt` 中止。`pnpm run docs check` 报告 82 个已有仓库错误，没有涉及这对 Note 的错误；`git diff --check` 通过。当前没有注册 SHA 保护的文档主题。

## 修复提议

1. 分开保存原始和逻辑 offset。锚点、方向、覆盖与快照使用截断到滚动范围的逻辑位置。把弹性越界及其返回视为原生边缘运动，保持意图，不因弹性偏移本身写回。scroll、commit、resize 入口都要处理；仅截断 `readScrollTop` 仍可能让 `writePhase` 与回弹竞争。真实布局补偿仍由事务独立负责。
2. 为两个方向记录有效对话输入：touch、wheel、导航键和滚动条拖动。unknown、clamp 和自身写入可以更新观察及覆盖，但不能作为恢复 follow 的证据。历史底部匹配必须属于该输入序列；viewport/composer 变化本身不能创建候选或复活旧序列。
3. touch/fling 期间记录到达底部，但不清空原生运动证据，也不强制补齐 1–4px。支持 `scrollend` 时在其到达后收敛有效的底部到达。无该事件的平台可在逻辑位置到达底部时恢复 follow，但不校正写入，保留有效触摸证据贯穿原生序列。显式回到底部、发送和跳转命令可以接管。不要添加 timer 回退，并区分真实向上输入与回弹返回范围内底部。
4. 用不参与真实布局、不可交互的测量元素计算 composer 文本高度，匹配宽度、字体、换行与 padding，再一次性应用最终高度。保留最小高度、11 行上限、placeholder 行为、textarea 内部滚动及 focus。它消除一个可能的临时 clamp 来源，控制器修复则独立关闭误恢复 follow。

保留单一写入者、extent、锚点与有界覆盖约定。增大容差或 debounce 校正仍会留下意图错误。`overscroll-behavior-y: none` 可作为禁用回弹的产品选项，但单独使用无法修复无输入恢复 follow 或 composer 临时 clamp。

## 实施验收

扩展所属模型与适配器测试：弹性越界和返回、commit/resize 先于 scroll 采样、`scrollend` 前的触摸到达、原生序列中的新输出、真实向上脱离及显式回到底部。增加 unknown、clamp、自身写入应保持 read 的情形，跨 viewport resize 的历史底部情形，以及向下 wheel/键盘/滚动条恢复 follow。保留已有估计底部恢复、覆盖与种子序列检查。

composer 浏览器验收须测量真实相邻 viewport，在 read 与 follow 两种状态下覆盖换行输入、删除、IME 更新和键盘开关。iOS 真机验证用户报告的快速向下甩动，记录 raw/logical offset、最大范围、输入来源、意图转换与写入原因。合成测试不能证明原生惯性行为或用户报告的视觉振动已经消失。

PR：[#1465](https://github.com/LodyAI/Lody/pull/1465)。
