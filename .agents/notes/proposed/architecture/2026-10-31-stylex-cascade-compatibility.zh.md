# 为旧层叠合同评估有限的 StyleX 提取路径

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[English](2026-10-31-stylex-cascade-compatibility.md)

## 摘要

将公开组件的 Tailwind 缺省样式移到更早的 StyleX 层，可能改变调用方样式的胜负，即使默认截图相同。独立 namespace 提取到 Tailwind 之前的 utilities 本层后，两次隔离客户端构建中的 66 对真实 AdaptiveTabStrip 画面一致，普通 StyleX 控制也保持一致。真实 Slot 与规则顺序反例仍阻止通用替代；开发、热更新与实际 App renderer 尚未验证。这仍是部分原生缺省样式的提案，未改变生产配置、依赖或锁文件。

## 证据与限制

[迁移 Note](../../implemented/architecture/2026-10-22-tailwind-to-stylex-migration.zh.md) 负责已实施迁移与库存。工作区证据为 `packages/components/artifacts/visual/leaves156-acceptance.html`，包含原始截图、失败及内嵌可复现实验。这些是隔离源码与编译输入的真实浏览器结果，不计产品迁移信用。

| 实验                                                                                | 实际结果                                                            | 限制                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 原生 `utilities.priorityN` 子层                                                     | 九个零特异性祖先用例全部变化                                        | utilities 内未分层的规则仍优先于其子层。                                                                              |
| 独立 import namespace 与类前缀；原生 metadata 提取到 Tailwind 之前的 utilities 本层 | 十三个 Adaptive 用例的完整记录字段与 PNG 全同，普通 StyleX 控制不变 | Radix Slot 的 grid 父／flex 子由 grid 变为 flex，高度 55 变为 28px。                                                  |
| 同样提取但放在 Tailwind 之后                                                        | 修复上述 Slot 方向                                                  | 反向 Slot 失败，直接调用方宽度 840 变为 0，保留的 366px 查询 active 最小值 180 变为 0；十三个 Adaptive 用例无一相同。 |
| 两条路径重用普通 atom 名称                                                          | Adaptive 用例相同                                                   | 共享 atom 被提升到 utilities；普通 StyleX 控制 overflow 从 visible 变为 hidden，尽管 PNG 相同。                       |

有限客户端构建原型用一个私有 96 行 extractor 处理一个固定原生 owner。Storybook 与真正
SessionTabBar 的生产 Vite consumer 均成功构建，2,401 份输入稳定，八个 Root 源码／配置／
锁文件 guard 不变。66 对 PNG 字节全同；仅替换对应 class 载体后，全部记录的普通／自定义／
pseudo 字段、属性、状态、几何与动画快照一致；46 个普通 StyleX 控制无需这种规范化即可
全同。普通与未分层 CSS 规则的条件、相对顺序不变，native atom 没有进入普通 collector。
工作区证据为 visual artifact 目录下的 `leaves159-field-comparison.json`、
`leaves159-css-asset-audit.json` 和独立的 `root159-native-route-independent-verification.json`。
这些结果不计生产迁移信用。

Extractor 必须先于 React／docgen 源码变换；严格原始源码等式拒绝了原来的后置接线。
七个常量 atom 让全部 StyleX 调用都静态折叠，因此没有验证动态 runtime alias。原型明确拒绝
dev／HMR、build-watch 与 SSR；生成文件和私有编译缓存尚未建立多个开发服务器并发时的
安全归属。source map、直接声明的 compiler 依赖和实际 Electron renderer 成对运行仍是
采用前的缺口。第二个客户端构建是 standalone consumer，不是 Electron App；已有
renderer-only 验证路径能固定 main／CLI 字节，而不触发 ACP 前置构建。

原五张 direct-caller 图的夹具 Tailwind 候选清单漏了 `items-end`，继续保留为拒绝证据。证明样式表只增加该规则后，仅修正并重采这五个状态，原六十个健康状态未重采。

锁定的 0.19 unplugin 不能视为两个隔离 collector：实例共享全局规则 store。类型声明中的 `legacyDisableLayers` 没有传给原生处理器，关闭 layers 后仍增加优先级 selector。实验直接调用原生处理器，同时设置 `useLayers: false` 与 `legacyDisableLayers: true`，不转换 selector、不提高特异性。Babel 的缺省 import-source 行为也需要显式隔离，不能认为设置自定义 source 就会排除普通 StyleX import。

## 提议的下一边界

只为明确识别、且全部调用方与状态合同已证明的原生缺省样式，评估一个小提取路径。为其使用独立编译身份和 atom 前缀，保留普通路径，并验证最终真实 CSS 顺序。公开 raw selector、Slot 行为以及 state／query utility 继续使用现有路径，直到各自的顺序合同有等价替代。

在集成构建改动前，需证明实际应用、Storybook 和 standalone 输出遵守相同边界，审查碰撞、变量、注册与每条保留规则，重跑真实调用方回归和普通 StyleX 控制。默认截图、empty-caller guard，或十三个原生用例通过，都不能批准任意公开 Slot 迁移。目前没有选择全局提取顺序，也没有退役任何兼容 API。
