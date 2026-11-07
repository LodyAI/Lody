# Lody iOS 设计语言

视觉稿：https://claude.ai/code/artifact/29ac4d3e-bb55-46a1-926f-c3101f5a96c2

定位是「系统 App + 一个记号」：骨架完全交给 UIKit，自己的表达只花在四处——会话状态语言、聊天页消息呈现、靛蓝强调色、排版与密度。

本文覆盖除**聊天页**外的全部页面。聊天页另行讨论。

## 分层

```
src/theme/tokens.ts     纯数据，零 RN 依赖，可被 node test 直接跑
src/theme/*.ts          palette / motion / fontScale —— hook 层
src/ui/*.tsx            RN 原语，把原生 view 包成产品语义组件
modules/lody-kit/       Swift 按功能目录 + 单一 index.ts 类型化 props
```

`ui/` 和 `kit/` 是两层封装。kit 出裸 props 和 id 数组；`ui/` 包成接受闭包、自己管测高与 id 映射的产品组件。业务页只认 `ui/`。现在 `MachinesScreen` 直接拼 `sections` 喂 `NativeGroupedList`，缺的就是中间这层。

不建 workspace package，`src/theme/tokens.ts` 即可。

## 色彩

强调色取自 app icon 水母伞盖的靛蓝。青绿只留在图标和空态插画，不进 UI。

- `accent` `#3B4FD9` / `#7B8AFF` —— 唯一手写双值的色
- 其余全部 `PlatformColor`

两条规则：

1. **强调色只表达两件事**：可点（按钮、链接、Tab 选中）和「进行中」。
2. accent 两个值对 `systemBackground` 的对比度都要 ≥ 4.5:1，写成测试。

`theme.ts` 现在的两套色（导航 hex + `usePalette`）合并成一个文件、一个导出。

## 状态语言

状态永远是「色 + 形」成对出现，不靠颜色单独承载。渲染入口只有 `ui/StatusDot`，列表、聊天页、设置页共用。

| 状态                          | 色             | SF Symbol                     |
| ----------------------------- | -------------- | ----------------------------- |
| 进行中 `running`/`processing` | accent         | `circle.fill` + 脉冲          |
| 等待确认 `waiting`            | systemOrange   | `exclamationmark.circle.fill` |
| 需要关注 `error`              | systemRed      | `xmark.octagon.fill`          |
| 待命 `idle`/`pending`         | secondaryLabel | `circle`                      |
| 已完成 `completed`            | secondaryLabel | `checkmark`                   |
| 已归档                        | tertiaryLabel  | `archivebox`                  |

`sessionStatus()` 拼进 `subtitle` 的字符串全部删除，状态走独立的 leading accessory 槽位。

## 排版

业务代码不再出现裸 `fontSize`。所有文本走 `ui/AppText` 的语义角色，值对齐 iOS 默认字号——因为一半 UI 在原生 `UICollectionViewListCell` 里，两边差一档会在并排时露馅。

| role        | 字号 / 行高       | 色             | 用途                           |
| ----------- | ----------------- | -------------- | ------------------------------ |
| `title`     | 20 / 26           | label          | 分区标题、Sheet 标题           |
| `body`      | 17 / 25           | label          | 消息正文、列表主标题、输入框   |
| `secondary` | 15 / 21           | secondaryLabel | 行副标题、说明文字             |
| `meta`      | 13 / 18           | secondaryLabel | 时间、状态、footer             |
| `eyebrow`   | 11 / 14 · +0.08em | secondaryLabel | 标识、分组头                   |
| `mono`      | 13 / 20           | label          | 路径、分支、ID、代码。仅此四类 |

缩放：`allowFontScaling={false}` + 自己 clamp 到 `14/17` ~ `23/17`。项目规则的「按默认字号验收，不适配超大辅助字号」由此成为代码。

间距标尺只有六档：`4 8 12 16 20 24`。`Screen.tsx` 的 `padding: 24, gap: 20` 改成 `16 / 12`，对齐系统分组列表边距。

`motion.ts` 按意图命名：`settle` / `glide` / `pressIn` / `fade`。

## 信息架构

首屏从项目列表改为**会话收件箱**。项目是写代码时的组织单位，不是手机上找东西的方式——它降级成搜索关键词。导航从三层变两层。

- 删除 `features/machines/ProjectSessionsScreen.tsx`
- Tab 从「电脑」改名「会话」，目录 `features/machines/` → `features/sessions/`
- 没有筛选器。搜索栏同时匹配会话标题和项目名
- 已归档不进收件箱，只能搜到

### 收件箱

三个固定分区，分区本身就是排序：

1. **需要你** —— `waiting` + `error`。分组头用 warning 色，是整页唯一的彩色分组头；空时整组不渲染
2. **进行中** —— `running` + `processing`
3. **最近** —— `completed` + `idle`，限 20 条，滚到底加载

行的副标题格式：`状态 · 项目 · 相对时间`。已完成的行省掉状态词（图标已经说了）。时间用相对时间（刚刚 / 3 分钟前 / 昨天 / 9月2日）。

导航栏：左上工作区菜单（`account.workspaces.length > 1` 时才显示），右上 `+`。footer 显示连接状态，断线时整行转 warning 色。

### 新建会话

`present()` 的 pageSheet，detents `[.medium, .large]`，默认 medium。

**创建和第一条消息是同一个动作**：发送即创建，没有「创建」按钮，也没有创建完落进空会话那一步。对齐 Lody 桌面端「新建对话」。

- **删掉「名称」字段**，标题由首条消息推导
- 底部就是聊天页的 `ui/WellInput`，同一个组件、同一个发送按钮
- 互斥选择用 `UISegmentedControl`：类型（本地 / GitHub / 对话）、工作方式（本地文件 / 新工作树）
- 电脑和项目是多选一长列表，用列表行 + chevron
- 表单跟类型变形：选 GitHub 时项目换成仓库 + 起始分支、工作方式隐藏；选「对话」时两者都隐藏
- 关闭用 `xmark.circle.fill`（已有 `NativeCloseButton`），不是「取消」文字
- 模型与运行模式 MVP 只读，显示助手默认值
- 创建失败不重试写入：发送按钮转 spinner，失败弹 toast 并保留草稿，以同步后的列表为准

**待确认**：服务端是否支持无标题创建会话。若不支持，回退为客户端用首条消息前 N 字生成标题。

### 设置

现有结构已经对了。三处改动：

- 新增「连接」分组，显示电脑在线状态（`StatusDot` 第三次复用）
- 版本号补 build 号，等宽
- 删掉「关于」里的营销文案；登录错误从 section footer 移到 toast

## 组件清单

### `src/ui/`

| 组件                       | 替换掉                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `AppText`                  | 全部裸 `fontSize`                                                   |
| `StatusDot`                | `sessionStatus()` 拼进 subtitle 的字符串                            |
| `ListState`                | `placeholder` 字符串 + section footer 塞错误 + 裸 `<Text>` 三套机制 |
| `Button`                   | 现在 25 行硬编码的 `ui/Button.tsx`                                  |
| `WellInput`                | `SessionScreen` 里内联的输入框                                      |
| `ToastHost` + `toastStore` | `setError` → section footer 的 hack                                 |
| `Segment`                  | 新增，包 `UISegmentedControl`                                       |

`MarkdownBody` 属于聊天页，本轮不做。

### `modules/lody-kit/`

1. **`NativePress`** —— RN `Pressable` 在 iOS 上没有原生按压手感
2. **行 leading accessory** —— SF Symbol 名 + tint 走 props 进原生，状态才能脱离字符串
3. **`plus` / `xmark.circle.fill` 用 `UIBarButtonItem`** —— 干掉 `＋` 和 `↑` 全角文字字符
4. **`NativeSegmented`** —— `UISegmentedControl`
5. **`NativeMenuButton` 保留**，工作区切换继续用

## 实施顺序

1. `tokens` · `palette` · `AppText` —— 纯收敛，零视觉变化，对比度校验落成测试
2. `StatusDot` + kit leading accessory —— 第一个看得见的改进
3. 信息架构：收件箱取代项目列表，删 `ProjectSessionsScreen`，Tab 改名，目录重命名。净删代码
4. `ListState` + `ToastHost` —— 干掉错误处理的三套机制
5. `NativePress` · `Button` · barButton 图标
6. 新建会话重做 —— `Segment` + `NativeSegmented` + 发送即创建
7. 设置页「连接」组 —— `StatusDot` 第三次复用，验证状态语言通用

聊天页重构不在本轮。

## 验证

每步之后：`pnpm check`、`pnpm test`、`pnpm bundle`。第 2、3、5、6 步涉及原生改动，需正常签名的 iOS 模拟器构建。

行为验收：

- 收件箱三分区排序正确，空分区不渲染
- 搜索匹配项目名，能搜到已归档会话
- 状态点在浅色、深色、色盲模拟下都能区分（形状不同，不只是颜色）
- 新建会话：发送即创建并进入会话；取消手势结算为 `cancelled` 且释放 session
- 断线时 footer 转 warning 色，恢复后回落

## 实施记录（2026-09-06）

7 步已完成，与设计稿的偏差如下。

**未实现，等服务端**

- 「类型」分段（本地 / GitHub / 对话）与「工作方式」分段（本地文件 / 新工作树）。当前 `createSession` RPC 只接受 `projectId` / `machineId` / `agentConfigId` / 可选 `branch`，没有对应字段。因此 `NativeSegmented` 也未建。等 RPC 支持后再补。
- 无标题创建。服务端仍要求 `title`，采用了 spec 里的回退方案：`draftTitle()` 取首条消息第一行前 24 字。

**实现方式与设计稿不同**

- **发送即创建**拆成两步：创建会话 → 进入会话页并带上草稿 → 会话首次 `live` 时自动派发一次。用 `autoSent` ref 保证跨重连不重放，符合「不自动重放写入」。失败时草稿留在输入框，不重试。
- **电脑与项目的选择**用通用的 `pickerPage`（`present` 的 pageSheet）而不是内联控件，两处复用一个组件。
- **`StatusDot` 组件未建**。用到状态的两处（会话行、设置连接行）都是原生 list row，只需要 `stateSymbol` / `stateTint` 映射；RN 组件留到聊天页真需要时再建。
- **`Button` 同时接受 `label` 和 `children`**，避免为改 API 去动 15 个调用点。
- **`inbox.ts` 用相对路径 + `.ts` 后缀导入**。它被 `node --test` 直接加载，Node 不解析 `@/` 别名。

**新增的原生文件**

- `ios/LodyTint.swift` —— 语义色名与 hex 的统一解析，`LodyGroupedList` 和 `LodySymbolButton` 共用
- `ios/Chrome/LodySymbolButton.swift` —— SF Symbol 按钮，`prominent` 时是填充胶囊（发送按钮），否则是裸字形（bar button）
- `ios/Press/LodyPressable.swift` —— 按压缩放 + haptic

**验证**：`pnpm check` ✓、29 项测试 ✓、Hermes bundle ✓、正常签名的 iOS 模拟器 Debug 构建 ✓。模拟器行为验收尚未跑。

## 模拟器验收（2026-09-06，iOS 26.5，真实账号数据）

用 `axe` 驱动真机行为，逐条确认。

**验收通过**

- 收件箱按分区渲染，空分区不出现；当前工作区所有会话后端状态都是 `idle`，故只有「最近」一组
- 搜索 `afilmory`（项目名，不在任何会话标题里）筛出 2 条 —— 「搜索兼顾项目名」的核心行为成立
- 行的无障碍标签是「标题, 状态 · 项目 · 时间」，VoiceOver 一次读全
- 点会话进正文、返回、点遮罩关 sheet，都干净结算，无卡死
- 新建会话 sheet 起手是半屏 detent，身后能看见收件箱；关闭是 `xmark`
- 项目选择器：路径等宽、选中带勾、标题「选择项目」
- 设置页「连接」组显示「3 台电脑 · 已连接 · 同步于 刚刚」，状态点是 accent
- 浅色与深色各过一遍，accent 在两侧都可读

**修掉的 5 个真 bug**

1. `src/app/index.tsx` 仍重定向到 `/(tabs)/machines`，冷启动直接 Unmatched Route。`typedRoutes` 类型未重新生成，typecheck 没抓到。
2. `LodySymbolButton` 用 `Events("onPress")` 与 RN 内建冒泡事件 `topPress` 撞名，抛 `Invariant Violation` 白屏。改名 `onSymbolPress`。
3. 列表默认图标 tint 是 `.systemBlue`，与 accent 靛蓝并排有色差。加 view 级 `accent` prop，所有行统一。
4. 行标题的 `action && !disclosure → accent` 启发式把选择器选项也染成蓝色。删掉这条规则，标题永远是 `label`（destructive 除外）。
5. `:unassigned` 项目没有工作目录、根本建不了会话，却出现在选择器里，且三个同名无法区分。已过滤。

**顺带补的**

- 行支持 `subtitleMono`，路径与分支用 `UIFont.monospacedSystemFont`，兑现「路径归 mono」

**未覆盖**

- 真机触感（`LodyPressable` 的 haptic 在模拟器只能确认不崩）
- 新建会话的完整链路（发送 → 创建 → 进入会话 → 首次 live 自动派发一次），未真实创建会话以免污染账号数据
- `waiting` / `error` / `running` 状态的视觉，当前账号没有处于这些状态的会话

## 修正：导航栏按钮必须是原生 UIBarButtonItem（2026-09-06）

**先前的做法是错的。** 把 `NativeSymbolButton` / `NativeCloseButton` 塞进 `headerRight` / `headerLeft`，是在 header 里托管一个 RN 视图去模仿 bar button，尺寸、位置、liquid glass 分组、溢出菜单全部拿不到系统行为。

正确做法是 expo-router 57 的 `Stack.Toolbar`：

```tsx
<Stack.Toolbar placement="right">
  <Stack.Toolbar.Button
    icon="plus"
    tintColor={colors.accent}
    onPress={create}
  />
</Stack.Toolbar>
```

- `Stack.Toolbar.Button` —— `icon` 直接吃 SF Symbol 名，`variant` 支持 `plain / done / prominent`
- `Stack.Toolbar.Menu` + `Stack.Toolbar.MenuAction` —— 原生 `UIMenu`；选中态用 `icon="checkmark"`
- `placement` 取 `left` / `right` / `bottom`；`Spacer` 可切分 liquid glass 分组

已改的三处：收件箱的「新建会话」和工作区菜单、`PresentedPage` 的 sheet 关闭项。

**因此删掉的**

- `NativeMenuButton` 与 `LodyMenuButton.swift` —— 工作区切换改用 `Stack.Toolbar.Menu` 后完全没有调用方

**因此保留的**

- `LodySymbolButton` 只服务 `ui/Composer` 的发送按钮。那是内容区里的控件，不是 bar button，需要 SF Symbol 填充胶囊而项目没有 `expo-symbols`。
- `NativeCloseButton` 只服务 Debug 页透明覆盖层里的关闭按钮，同样在内容区内。

**规则**：导航栏里的任何 action，一律走 `Stack.Toolbar`。`headerLeft` / `headerRight` 不再出现在这个代码库里。

## iOS 26 玻璃 Sheet

`src/ui/platform.ts` 导出唯一的版本常量：

```ts
export const isIOS26 = Number.parseInt(String(Platform.Version), 10) >= 26;
```

`nativePresentationOptions` 在 `isIOS26` 且样式是 `formSheet` / `pageSheet` 时，把 `contentStyle.backgroundColor` 设为 `transparent`，系统的玻璃材质就显出来。iOS 26 以下仍用实色——那些版本 sheet 背后没有材质，透明会直接看穿被遮的页面。

Sheet 里的分组列表要配合两件事，两件都不是显而易见的：

1. **列表自己的底去掉**（`transparent` prop → `collection.backgroundColor = .clear`），否则 `systemGroupedBackground` 会把玻璃盖死。
2. **行必须显式取回不透明卡片色。** 在玻璃上下文里 UIKit 把 `secondarySystemGroupedBackground` 解析成 vibrant 半透明填充，sheet 背后的文字会直接透过行读出来。行用手写的 `#FFFFFF` / `#1C1C1E` 双值（仍随深浅色切换）。

最终观感：行是干净的实心卡片，组与组之间和空白区露出玻璃。

踩过的坑：`setTransparent` 里漏掉 `collection.reloadData()`，导致 prop 在 `sections` 之后到达时 cell 已经渲染完，改动完全不生效——两次构建截图一模一样，看起来像效果无效，其实是根本没跑。

## Sheet 内的导航必须是嵌套栈

`present()` 走的是扁平的根 Stack：`router.push('/presented/<id>')`。sheet 是这个栈上的一个 modal，**之后再 push 一个 push-style 页面，会落在呈现 sheet 的那个 navigation controller 上，也就是 sheet 后面**。所以「在 sheet 里 push 下一层」不能靠 `present`。

正确做法是 sheet 自己持有一个嵌套的原生栈，用 `react-native-screens` 的 `ScreenStack` + `ScreenStackItem`——**稳定 API，不是 `react-native-screens/experimental` 的 gamma Stack**：

```tsx
<ScreenStack style={StyleSheet.absoluteFill}>
  <ScreenStackItem screenId="create-form" headerConfig={{ title: '新建会话', … }}>
    {form}
  </ScreenStackItem>
  {picking ? (
    <ScreenStackItem
      screenId="create-picker"
      stackPresentation="push"
      headerConfig={{ title: '选择项目', … }}
      onDismissed={() => setPicking(null)}
    >
      <PickerList … />
    </ScreenStackItem>
  ) : null}
</ScreenStack>
```

这套模式来自 Folo 的 `src/lib/navigation`：路由按类型分组，连续的 `push` 归一组；遇到 modal / formSheet 就开新组，而这个 modal 组内部**再嵌一个 `ScreenStack`**，把它之后的 push 全放进去。sheet 因此可以堆叠，也可以在内部继续 push。

三层关系值得记住：`expo-router` 的 `<Stack>` 是 react-navigation navigator 的包装、只能当布局文件用；react-navigation `native-stack` 是纯 JS 的路由状态层；`react-native-screens` 的 `ScreenStack` 才是真正的 `UINavigationController`，可以嵌在任意位置。

配套改动：

- `createSessionPage` 的 `presentation.headerShown` 设为 `false`——嵌套栈画自己的 header，否则两条导航栏
- `PickerScreen` 从 `definePage` 降级成纯组件 `PickerList`，不再是可 `present` 的页面
- 两个屏的 `headerConfig` 都要 `translucent: true` + `backgroundColor: 'transparent'` + `hideShadow: true`，否则 header 会盖一层不透明底并画出分隔线，把玻璃切断
- 关闭项用 `ScreenStackHeaderRightView` 包 `NativeCloseButton`（Swift 里就是 `UIButton(type: .close)`，系统关闭按钮本体）

**规则**：需要在 sheet 内部分层的流程，用嵌套 `ScreenStack`；`present` 只用于从根栈打开一个新的呈现。

## Composer 输入框不设 lineHeight

RN 在 iOS 的多行 `TextInput` 上把 `lineHeight` 映射成 `NSParagraphStyle.minimumLineHeight`，多出的高度全加在文字**上方**——表现为上 padding 比下 padding 大、光标被拉长。17pt 的自然行高约 20.3，设成 25 就会偏 5pt。多行输入框只设 `fontSize` 与对称 padding。
