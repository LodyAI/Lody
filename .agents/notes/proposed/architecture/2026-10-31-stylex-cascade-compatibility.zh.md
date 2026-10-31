# 为旧层叠合同评估有限的 StyleX 提取路径

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[English](2026-10-31-stylex-cascade-compatibility.md)

## 摘要

将公开组件的 Tailwind 缺省样式移到更早的 StyleX 层，可能改变调用方样式的胜负，即使默认截图相同。隔离实验将独立 StyleX namespace 提取到 Tailwind 之前的 utilities 本层，使十三个 AdaptiveTabStrip 用例保持一致。实验同时发现真实 Slot 与规则顺序反例，因此它只是部分原生缺省样式的候选路径，不是通用替代方案，也没有成为构建实现。实验未改产品源码、配置、依赖或锁文件。

## 证据与限制

[迁移 Note](../../implemented/architecture/2026-10-22-tailwind-to-stylex-migration.zh.md) 负责已实施迁移与库存。工作区证据为 `packages/components/artifacts/visual/leaves156-acceptance.html`，包含原始截图、失败及内嵌可复现实验。这些是隔离源码与编译输入的真实浏览器结果，不计产品迁移信用。

| 实验                                                                                | 实际结果                                                            | 限制                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 原生 `utilities.priorityN` 子层                                                     | 九个零特异性祖先用例全部变化                                        | utilities 内未分层的规则仍优先于其子层。                                                                              |
| 独立 import namespace 与类前缀；原生 metadata 提取到 Tailwind 之前的 utilities 本层 | 十三个 Adaptive 用例的完整记录字段与 PNG 全同，普通 StyleX 控制不变 | Radix Slot 的 grid 父／flex 子由 grid 变为 flex，高度 55 变为 28px。                                                  |
| 同样提取但放在 Tailwind 之后                                                        | 修复上述 Slot 方向                                                  | 反向 Slot 失败，直接调用方宽度 840 变为 0，保留的 366px 查询 active 最小值 180 变为 0；十三个 Adaptive 用例无一相同。 |
| 两条路径重用普通 atom 名称                                                          | Adaptive 用例相同                                                   | 共享 atom 被提升到 utilities；普通 StyleX 控制 overflow 从 visible 变为 hidden，尽管 PNG 相同。                       |

原五张 direct-caller 图的夹具 Tailwind 候选清单漏了 `items-end`，继续保留为拒绝证据。证明样式表只增加该规则后，仅修正并重采这五个状态，原六十个健康状态未重采。

锁定的 0.19 unplugin 不能视为两个隔离 collector：实例共享全局规则 store。类型声明中的 `legacyDisableLayers` 没有传给原生处理器，关闭 layers 后仍增加优先级 selector。实验直接调用原生处理器，同时设置 `useLayers: false` 与 `legacyDisableLayers: true`，不转换 selector、不提高特异性。Babel 的缺省 import-source 行为也需要显式隔离，不能认为设置自定义 source 就会排除普通 StyleX import。

## 提议的下一边界

只为明确识别、且全部调用方与状态合同已证明的原生缺省样式，评估一个小提取路径。为其使用独立编译身份和 atom 前缀，保留普通路径，并验证最终真实 CSS 顺序。公开 raw selector、Slot 行为以及 state／query utility 继续使用现有路径，直到各自的顺序合同有等价替代。

在集成构建改动前，需证明实际应用、Storybook 和 standalone 输出遵守相同边界，审查碰撞、变量、注册与每条保留规则，重跑真实调用方回归和普通 StyleX 控制。默认截图、empty-caller guard，或十三个原生用例通过，都不能批准任意公开 Slot 迁移。目前没有选择全局提取顺序，也没有退役任何兼容 API。
