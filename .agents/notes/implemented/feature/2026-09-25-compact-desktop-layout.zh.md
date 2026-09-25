# 桌面窗口在移动断点以下仍保留桌面布局

Status: implemented
Translation: current

[English](2026-09-25-compact-desktop-layout.md) | 中文

## 摘要

Electron 窗口此前无法缩窄到 768px 以下：`useIsMobile()` 把所有低于
`MOBILE_LAYOUT_BREAKPOINT` 的视口都当作手机，而主进程用 `minWidth = 768`
掩盖了这一点。现在断点只作用于非桌面类设备：桌面类窗口——Electron 外壳或桌面
浏览器——在任何宽度保持桌面渲染器，低于断点时进入紧凑呈现；手机、平板和未识别
设备仍按宽度切换（手机旋到足够宽就拿到真正的桌面渲染器，而不是被拉长的移动栈）。
紧凑呈现下导航侧栏和会话右侧面板不再占据分栏，改为浮层；该状态同步进
`compactDesktopLayoutAtom`，使无法调用 hook 的消费者读到同一状态。唯一的代价是：
跨越紧凑边界时侧栏和已打开的右侧面板会重挂载一次，组件内的瞬时状态（如滚动位置）
会重置——持久化 atom 不受影响。

## 根因

两个耦合的假设：`checkIsMobileDevice()` 对任何 `innerWidth < 768` 都返回 true，
不区分平台；`MAIN_WINDOW_MIN_WIDTH` 又设为 `MOBILE_LAYOUT_BREAKPOINT`，使渲染器
在 Electron 里从未真正观察到 `isMobile === true`。仅调低最小宽度会暴露桌面布局
依然放不下的问题：导航侧栏约需 280px，会话列下限 280px，会话右侧面板要
280–500px。代码库其实早已知道宽度 ≠ 布局——`agent-config-dialog` 有意直接监听
视口而不是 `useIsMobile()` 来适配窄窗口，settings 的 `AGENTS.md` 也禁止用视口
断点推导列宽。

## 决策

- **桌面类钉住家族，其余设备走断点。** `checkIsMobileDevice()`：`'desktop'` 类
  或 `isDesktopLayoutShell()` → 任意宽度 desktop，桌面浏览器缩窄与 Electron
  窗口行为一致；其余设备类都走视口断点——窄的手机/平板拿触屏优先的移动渲染器，
  手机旋过断点则拿到真正的桌面渲染器。原先 `deviceClass === 'mobile'` 的钉死
  逻辑被移除：它本为让横屏手机留在移动 UI，但产品意图是对称规则——移动端够宽
  就变桌面，桌面端永远不会变移动。对 Electron 零回归：`minWidth = 768` 时渲染器
  本就不可能在那里看到 `isMobile === true`。
- **`useIsCompactDesktop()`** = 桌面家族且视口低于断点。任意桌面类窗口都会到达；
  `ForceDesktop` 上下文也可以。
- **一份全局状态，桥接一次。** `MainLayout` 在 layout effect 中把 hook 结果写进
  `compactDesktopLayoutAtom`。命令层和 atom 消费者读
  `navigationSidebarVisibleAtom`（实际在屏可见性），而
  `navigationSidebarHiddenAtom`（持久化偏好 + Zen）继续服务
  `create-workspace-runtime` 这类应用可见性消费者。
- **抑制而非折叠。** 进入紧凑时若侧栏在屏则置 `compactSidebarSuppressedAtom`，
  拉宽即恢复；显式 toggle/show 或点击遮罩清除该标记，遮罩关闭写入真实的持久化
  折叠。持久化偏好永不为呈现而改写。
- **浮层而非分栏。** 紧凑导航侧栏是可关闭的浮层（`min(18rem, 85vw)`，桌面
  chrome，无拖拽分隔条）。会话右侧面板接管顶栏以下区域，可调整分栏折叠停放，
  `sidebarOpen` 与记忆宽度原样保留；关闭状态的面板按侧栏契约继续挂载在折叠的
  分栏内。
- **`DESKTOP_WINDOW_MIN_WIDTH = 400`** 取代断点成为窗口下限——它保护的是窗口
  chrome（红绿灯按钮、标题栏按钮），不是布局契约。持久化边界钳制与构造参数
  共用它。

## 曾考虑的方案

- **只调低 `minWidth`。** 否决：<768px 会在拖拽调整中触发真实的移动端重挂载，
  或得到列宽溢出的桌面布局。
- **到处用容器查询。** 列宽适配确实该归它（各界面内部已在用），但 `MainLayout`
  的渲染器切换是全局的——一个窗口不可能只挂半个移动栈。家族归身份、适配归局部
  查询，让各关注点落在正确的层级。
- **保持 `useIsMobile` 宽度驱动，在每个消费端特例 Electron。** 50+ 个调用点；
  hook 自身的注释先例已经把"布局家族"和"窄宽适配"分开，修原语就修了全部。

## 证据

- `tests/mobile-layout-selection.test.tsx`：手机从 `mobile:full` 旋过断点进入
  `desktop:full`、client hints 的宽手机拿 desktop、宽平板仍 desktop、窄平板翻转
  mobile、桌面窗口——Electron 或桌面浏览器——在 `desktop:compact` ↔ `desktop:full`
  间随缩放切换。
- `tests/compact-desktop-layout.test.ts`：进入紧凑会抑制在屏侧栏且不写持久化
  偏好，退出恢复，toggle 唤出浮层，紧凑下的折叠可跨越边界持久化。
- 既有 `desktop-session-detail-layout`（11 项）与 `layout-state`（12 项）套件原样
  通过；components/shared/electron 的 `tsgo` 无错误。

## 局限

- 紧凑呈现已在 atom/hook 边界和 typecheck 验证；本次未在真实 Electron 窗口里
  走查浮层视觉表现。
- UA 无法解析为 `'desktop'` 的窄屏桌面会回落到断点（其下为 mobile）——UA 检测
  仍是启发式的。
- 手机旋转现在会在手势中途重挂载渲染器（越过断点 mobile → desktop）。这正是当初
  身份钉死存在的原因；接受这次重挂载是因为足够宽的视口确实改变了可用的 UI。

Spec：[桌面多窗口](../../../../specs/desktop-windows.zh.md)。
