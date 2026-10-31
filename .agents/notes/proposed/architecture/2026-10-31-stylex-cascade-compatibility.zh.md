# 为旧层叠合同评估有限的 StyleX 提取路径

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[English](2026-10-31-stylex-cascade-compatibility.md)

## 摘要

将公开 Tailwind 缺省样式移到更早的 StyleX 层，可能改变调用方胜负，即使截图相同。独立有限 native 提取到 Tailwind 之前的 utilities 本层后，原 54 对 Storybook 与十二对 standalone consumer 保持一致。最终隔离提议为每个客户端 compiler 分配私有 CSS，保留开发 atom 以服务在途 response，并静态折叠真正有类型的 shim；实际 Electron 的 native 行像素相同，但整 App 像素 OPEN 仍保留。不支持通用 Slot 替代、App SSR 或此 owner 的保状态 HMR。最终状态矩阵和完整 consumer 类型仍在审查，Root 生产配置、依赖与锁文件未改变。

## 证据与限制

[迁移 Note](../../implemented/architecture/2026-10-22-tailwind-to-stylex-migration.zh.md) 负责已实施迁移与库存。工作区证据为 `packages/components/artifacts/visual/leaves156-acceptance.html`，包含原始截图、失败及内嵌可复现实验。这些是隔离源码与编译输入的真实浏览器结果，不计产品迁移信用。

| 实验                                                                                | 实际结果                                                            | 限制                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 原生 `utilities.priorityN` 子层                                                     | 九个零特异性祖先用例全部变化                                        | utilities 内未分层的规则仍优先于其子层。                                                                              |
| 独立 import namespace 与类前缀；原生 metadata 提取到 Tailwind 之前的 utilities 本层 | 十三个 Adaptive 用例的完整记录字段与 PNG 全同，普通 StyleX 控制不变 | Radix Slot 的 grid 父／flex 子由 grid 变为 flex，高度 55 变为 28px。                                                  |
| 同样提取但放在 Tailwind 之后                                                        | 修复上述 Slot 方向                                                  | 反向 Slot 失败，直接调用方宽度 840 变为 0，保留的 366px 查询 active 最小值 180 变为 0；十三个 Adaptive 用例无一相同。 |
| 两条路径重用普通 atom 名称                                                          | Adaptive 用例相同                                                   | 共享 atom 被提升到 utilities；普通 StyleX 控制 overflow 从 visible 变为 hidden，尽管 PNG 相同。                       |

原 159 客户端构建原型用一个私有 96 行 extractor 处理一个固定原生 owner。Storybook 与真正
SessionTabBar 的生产 Vite consumer 均成功构建，2,401 份输入稳定，八个 Root 源码／配置／
锁文件 guard 不变。66 对 PNG 字节全同；仅替换对应 class 载体后，全部记录的普通／自定义／
pseudo 字段、属性、状态、几何与动画快照一致；46 个普通 StyleX 控制无需这种规范化即可
全同。普通与未分层 CSS 规则的条件、相对顺序不变，native atom 没有进入普通 collector。
工作区证据为 visual artifact 目录下的 `leaves159-field-comparison.json`、
`leaves159-css-asset-audit.json` 和独立的 `root159-native-route-independent-verification.json`。
这些结果不计生产迁移信用。

159 extractor 必须先于 React／docgen 源码变换；严格原始源码等式拒绝了原来的后置接线。
七个常量 atom 让全部 StyleX 调用都静态折叠，因此没有验证动态 runtime alias。该版本明确拒绝
dev／HMR、build-watch 与 SSR；生成文件和私有编译缓存尚未建立多个开发服务器并发时的
安全归属。在该边界，source map、直接声明的 compiler 依赖和实际 Electron renderer 成对运行仍是
采用前的缺口。第二个客户端构建是 standalone consumer，不是 Electron App；已有
renderer-only 验证路径能固定 main／CLI 字节，而不触发 ACP 前置构建。

增加 31 行的 owner-only 整页刷新扩展（164）能通过普通编辑／删除／失败检查，却在真实
跨 response 窗口失败：owner 旧 JS 已在途，页面稍后收到新 CSS，HMR 连接此时断开。
旧 center atom 已不在新样式表，实际 alignment 变为 `normal`。原 HTTP payload 和真实
浏览器图保留在 `leaves164-acceptance.html`。独立 initial-spacing 像素 OPEN 为 55 原始／
32 阈值像素；已定位在记录内的 native item 和 trailing plus glyph，不代表证明了绘制原因。

下一隔离扩展（168）在每个开发服务器的私有 history 保留已成功发布的 atom，用精确
import alias 指向其 UUID CSS 文件。同一在途 response 窗口此时仍为 center；真实编辑／
删除、编译失败、快速连改、双 server 隔离及 pending close 检查通过。十二个新冷启动对照的
PNG 字节与字段全同，八个普通控制不变；production 当前七 atom CSS 与 159 字节全同。
新结果不关闭 164 原 OPEN。最初 production 路径仍写同一个固定生成文件，不能认为并行
production 归属已安全；采用前所有 client 模式都需私有输出。Vitest 的 SSR transform
也会导入此 owner，需要显式 compile-only macro，但不代表支持 App SSR。直接固定的
compiler 依赖、完整 consumer 类型边界和实际 App 成对运行仍在审查。这些实验尚未使
Root 生产路径采用该方案。

原五张 direct-caller 图的夹具 Tailwind 候选清单漏了 `items-end`，继续保留为拒绝证据。证明样式表只增加该规则后，仅修正并重采这五个状态，原六十个健康状态未重采。

锁定的 0.19 unplugin 不能视为两个隔离 collector：实例共享全局规则 store。类型声明中的 `legacyDisableLayers` 没有传给原生处理器，关闭 layers 后仍增加优先级 selector。实验直接调用原生处理器，同时设置 `useLayers: false` 与 `legacyDisableLayers: true`，不转换 selector、不提高特异性。Babel 的缺省 import-source 行为也需要显式隔离，不能认为设置自定义 source 就会排除普通 StyleX import。

## 最终有限提议仍在审查

冻结 171／180 补丁为十一文件／348 改动行，仅处理 AdaptiveTabStrip 九个默认值、
七个 distinct atom。所有 client 模式都有私有 CSS 文件，只替换一个 owned CSS import
中的引号路径；普通规则、layer 与位置不变。binding-aware 静态编译折叠全部四个调用，
删除已无引用的真实类型 re-export；canonical load guard 拒绝 runtime 逃逸。
compiler 是直接固定版本依赖，lock 仅三个 importer 项变化，无新增 package resolution。
Vitest 显式 transform-only，不代表 App SSR。该 owner 的开发更新有意整页刷新；私有
生命周期 atom history 保留旧在途 JS reader。普通 StyleX HMR 仍保状态。并发 client 输出、
optimizer 复用、原 TSX source map 与普通 HMR 已实际验证；164 原失败继续保留。

最终 renderer-only 与 Storybook 构建通过，4,589 输入固定。实际 onboarding summary
使用真正 TourApp／SessionTabBar，但静态 camera 有裁切、pointer-inert 且只呈现浅色；
不代表真实会话交互或暗色 App。180 等自然有限动画完成后，可见 native 行零像素差，
已采完整几何同，整 App 仍有 39 原始／零阈值像素 OPEN。静态 camera opacity 保持设计的
0.48，没有暂停或强制动画。171／177 旧 OPEN 及一次先恢复后退出的 harness 错误单列。
修正运行在全部自有 App 进程退出后才恢复 1,222 renderer 文件，335 个 main／CLI／lock
字节不变。components 类型与七 owning 测试通过。最终 54／12 状态矩阵重跑及完整
Electron 类型仍在检查；实际集成前，这些隔离结果在 Root 的迁移信用为零。

## 提议的下一边界

只为明确识别、且全部调用方与状态合同已证明的原生缺省样式，评估一个小提取路径。为其使用独立编译身份和 atom 前缀，保留普通路径，并验证最终真实 CSS 顺序。公开 raw selector、Slot 行为以及 state／query utility 继续使用现有路径，直到各自的顺序合同有等价替代。

在集成构建改动前，需证明实际应用、Storybook 和 standalone 输出遵守相同边界，审查碰撞、变量、注册与每条保留规则，重跑真实调用方回归和普通 StyleX 控制。默认截图、empty-caller guard，或十三个原生用例通过，都不能批准任意公开 Slot 迁移。目前没有选择全局提取顺序，也没有退役任何兼容 API。
