# 为旧层叠合同评估有限的 StyleX 提取路径

Status: proposed
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[English](2026-10-31-stylex-cascade-compatibility.md)

## 摘要

将公开 Tailwind 默认值移到其他CSS层或改变class身份，会改变受支持调用方的优先级。前置utilities试验已因三个arbitrary-property反例恢复，而原位hash别名仍会破坏named cn控制。更小的纯CSS试验保留原selector、class字符串与规则位置，以真正StyleX metadata替换原声明体，十二个控制均保持。它仍是依赖Tailwind候选排序和显式绑定的声明所有权过渡提议。生产compiler、依赖及公开兼容API均未改变，试验迁移计数为零。

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

## 有限试集成与顺序反例

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
字节不变。components 类型与七 owning 测试通过。最终冻结 171 重跑的 54 个 Storybook、十二个 standalone 对照全通过，含 46 个不变普通控制；
Root 独立重读全部 pre/post Brotli 并解码 PNG，覆盖 3,022 条 scene 记录及 720 个精确 class
载体。raw class 字符串不同，含三个相同属性的直接调用方用例；不把渲染相同称为字符串
合同相同。冻结镜像的完整 Electron node／web 类型通过，未调用 CLI 前置构建。这些子集结果的生产迁移信用为零。

初始 factory 还漏掉 Windows 规范化模块 ID。最小 normalizePath 修正在虚拟文件系统中
使用真实 compiler／Vite 函数通过 Win／POSIX 行为验证，真实 macOS consumer JS／CSS
字节同；不等于 Windows 整机运行。保留的三个 compiler 测试使用明确 pending-read 信号，
不依赖调度时机。原补丁及原矩阵不变。

当前输入试集成184实际应用十三路径，两官方 renderer 均构建 9,087 modules，3,946 普通及
2,864 unlayered 规则全同。真实 App native 裁切零像素差，整页 312 原始／零阈值像素仍
OPEN。四 class、46 boot 变量、一 HTML boot style、两个关联 panel ID 差异明确单列；
不代表整页字段或动画历史等价。

188 用同一 literal caller fixture 在两个完整构建中渲染真正 Adaptive 组件。
[width:0px] 使 strip598→16px，[min-width:840px] 使 viewport598→840px，
[overflow:visible] 改变裁切及真实命中链。默认与三个 named utility 控制相同。
twMerge 保留 named default 与 arbitrary property；Tailwind 原本把后者排在对应 named
utility 之前，全部 native atom 提前会反转结果。不能以 CSS 补丁或默认成功接受这些反例。

Root 已把十三试集成路径恢复为原字节，并移除六个新增文件。compiler／依赖／lock 路径
未采用，九个 Adaptive 默认仍保留 Tailwind。真实截图见 leaves188-counterexample.html，
精确恢复见 root188-native-rejection-restoration-proof.json；171／177／180／184 的原成功、
OPEN 和失败证据都保留。

## 保留兼容selector的声明所有权

锁版后续研究见root-native-default-boundary-research.json。将独立hash atom放在原Tailwind规则
旁边，能修复之前的arbitrary-property／零特异性用例，但三个真实named控制失败：w-0宽度
0→400px、opacity-50从0.5→0.7、block变flex且命中链不同。当前cn无法把新hash识别为原utility
组；extendTailwindMerge显式登记三组可修这些合成控制，但需额外registry，且不保公开raw class
字符串。因此仅保持CSS位置不够，复用普通atom身份也仍不安全。

另一个双绑定试验保留.opacity-70／.w-full原selector及class值。原声明节点实际detach，再在相同
规则位置及context插入真正StyleX metadata声明，没有另一份生效Tailwind body掩盖新声明。
完整CSS字节不变；两个实际编译的stylex.props绑定显式映回旧class，使真正twMerge行为保持。
Chrome验证十二个静态控制，含零特异性opacity0.7、普通后代opacity1、named宽0及arbitrary宽400px。
另行真正重编译的opacity0.6被严格等价oracle拒绝。

这只证明小范围声明所有权边界，仍需Tailwind保留／排序候选、显式metadata到selector／context及
class绑定、自定义构建变换；不是StyleX现成选项或已完成产品迁移。该双绑定probe未验证动态值、variants、Slot、生产
consumers、开发更新和完整source maps；下述206仅限定验证一个静态opacity绑定。probe未改产品／配置／依赖／lockfile，真实浏览器
检查没有应用截图；精确compile／binding／browser记录位于root-native-exact-slot-probe/。

## 实际单一owner的生产与开发管线

隔离206后续验证针对MobileInlinePicker原有opacity-70调用；旧Spinner自身没有该默认值。
独立StyleX模块拥有静态声明，folded绑定保留原class字符串。bridge先detach原Tailwind声明，
再把真实compiler metadata的clone放入相同selector、layer与规则位置；普通StyleX收集器独立。
这是兼容selector下的声明所有权，不代表移除Tailwind候选排序依赖。

初版七个生产状态的完整raw对象及PNG／RGBA字节同；修正版两个真实DEV状态仅有80个明确的
debug-source行号属性变化，共505节点、九对整图同。DEV产70%，生产产.7；初版数值oracle
拒绝百分比。修正版只接受有界静态数字／百分比，并严格比较数值。其真实生产构建保留106份CSS
及绑定74字节JavaScript，但七个生产截图未在修正版重采。Before／After真实绑定测试及修正版
components类型通过。visual目录leaves206-delivery.json与leaves206-acceptance.html保留
source bank、九对原图及三个初始失败。

真实重编译为.6被生产CSS转换oracle及真实Vite update拒绝；负控没有执行完整生产build。热更新产生vite:error与CSS404，但Chromium
保留最后成功的.7样式，且没有错误overlay。这证明不发布不等价CSS，不证明整页fail closed。
原producer更强的标签保留，并由准确qualification限定，没有悄然改写。

此硬编码实验尚不是可生产采用的compiler设施：仍借用传递compiler解析及实验proof目录；正式
配置、直接锁版依赖、通用绑定所有权、完整source-map组合与真实配对Electron仍需审查。
动态值、其它属性、variants及Slot未证明。四个自有DEV进程组均退出，Root产品／配置／锁文件
未变，生产迁移信用仍为零。

## 提议的下一边界

只先在一个有限owner验证保留selector的过渡，把真正StyleX声明放在该owner附近，保原cn输入及
公开class合同；缺失或不等价的声明／context映射必须拒绝。在生效Tailwind声明下面增加无用StyleX
不算迁移。兼容selector绑定、普通StyleX atom及源码utility移除数分开记录。

生产集成前需验证真正App、Storybook及测试pipeline，named／arbitrary-property调用方、普通／零
特异性祖先、简写与变量、Slot及普通StyleX控制。必须检查优化后的最终产物，不能只看中间CSS；
selector-list优化与开发旧响应不能破坏合同。未选择全局层序变更、未退役公开兼容API，被拒绝的
十三路径试集成保持恢复。
