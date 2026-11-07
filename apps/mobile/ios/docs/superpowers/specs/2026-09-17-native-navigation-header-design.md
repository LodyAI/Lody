# 原生 Navigation Header

## 问题

会话页的导航栏由两方写同一个 `UINavigationItem`:LodyKit 设 `titleView`(两行标题,numericText 过渡),react-native-screens 通过 `Stack.Screen` / `Stack.Toolbar` 设 `title` 和右侧 items。screens 在任何 header prop 更新时先执行 `titleView = nil`,再重设全部 items。改名时 `Stack.Screen.title` 与 `navigationTitle` 同帧变化,SwiftUI host 被移出 window,标题过渡丢失。KVO 延迟到下一次 layout 再装回去,只掩盖了显示,救不回动画。

## 目标

导航栏内容由 LodyKit 单一所有者写入,可接到任意 screen 替代 RN screens 的 header 控制。RN 只描述内容,不再通过 screens 写 `navigationItem`。

## 决定

| 项               | 选择                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 所有者           | `LodyNavigationHeader`,按 `UINavigationItem` 一份(associated object),持有 `title` / `titleView` / `rightItems` / `leftItems` 四个槽                                                                                                 |
| 写回             | 幂等 `apply()`;KVO 四个 key,值偏离所持槽时同步写回。同步而非延迟:UIKit 在 `titleView = nil` 时同步移出 view,只在 layout 时加回,延迟写回必然丢一帧                                                                                   |
| 槽为 nil         | 不拥有,screens 的值放行(sheet 关闭按钮、静态路由标题)                                                                                                                                                                               |
| suspended        | 页面 willDisappear 时 `true`,KVO 不写回;交互返回取消后恢复并 `apply()`。沿用 chat 现有 `titleDisappearing` 语义                                                                                                                     |
| RN 接口          | `NativeNavigationHeader` 零尺寸原生 view,props `items` / `leftItems` / `title`,接受 screens 的 `HeaderBarButtonItem[]` 类型;facade 按索引路径生成 id、剥离函数、JSON 传入,`onAction({ id })` 查表回调                               |
| 支持的 item 字段 | `button` / `menu` / `spacing`;`title` `icon.sfSymbol` `accessibilityLabel` `accessibilityHint` `badge.value` `disabled`;菜单 `action`(title subtitle icon disabled destructive state)/ `submenu`(displayInline items)。其余字段忽略 |
| badge            | iOS 26 `UIBarButtonItem.badge = .string(_:)`                                                                                                                                                                                        |
| 重建             | JSON 字符串不变不重建 items                                                                                                                                                                                                         |
| 宿主查找         | responder chain 上的第一个 `UIViewController`,与 `LodyChatView` 同法;`didMoveToWindow` 绑定,离开 window 释放自己写过的槽                                                                                                            |
| chat 标题        | `LodyChatView` 通过同一 `LodyNavigationHeader` 持有 `title` 和 `titleView`;`Stack.Screen options.title` 删除,pop 时 fallback 文本来自被持有的 `title`                                                                               |
| 标题动画守卫     | 旧标题非空且新标题非空才动画,不看 `window`;screens 重置在两种先后顺序下都保留过渡                                                                                                                                                   |
| 覆盖页面         | `SessionScreen`(push / iPad detail 两种宿主都改为 `NativeNavigationHeader`,删除 `useSheetHeader`)、`PullRequestPreviewScreen`(Debug,承接 `pull-request.py`)                                                                         |
| 顺序             | 右侧 spec 按视觉从左到右书写,Swift 写入 `rightBarButtonItems` 前反转                                                                                                                                                                |
| 不动             | `ChatPreviewScreen` 保留 `Stack.Toolbar`;`PadHomeScreen` 侧栏、`ProjectHistoryScreen` 仍用 screens items,后续按需迁移                                                                                                               |

## 文件

- 新增 `modules/lody-kit/ios/Chrome/LodyNavigationHeader.swift`:所有者、KVO、JSON → `UIBarButtonItem` / `UIMenu`
- 新增 `modules/lody-kit/ios/Chrome/LodyNavigationHeaderView.swift`:ExpoView 宿主
- 新增 `modules/lody-kit/src/chrome/NativeNavigationHeader.tsx`:facade,id 分配,`onAction` 分发
- `ChatNavigationTitle.swift` / `LodyChatView.swift`:改用所有者槽,移除临时 `hold`
- `LodyKitModule.swift`、`src/index.ts`:注册与导出
- `SessionScreen.tsx`、`PullRequestPreviewScreen.tsx`:替换 screens header
- 新增 Swift 文件后执行 `pnpm --filter @lody-ios/mobile pods`

## 验证

- native `chat-title`:JSON → items 数量、badge、菜单层级、`onAction` 回传 id;模拟 screens 重置(`titleView = nil`、`title` 覆盖、`rightBarButtonItems = nil`)后三者同步恢复;标题过渡在两种顺序下都有中间帧
- `verify:ui title-rename.py`(chat-preview 场景):`--ui-verify` 下标题过渡探针在 accessibilityValue 报告中间帧数与脱离 window 的 tick 数;Rename Session 走 RN → screens 重置 → native 全链路
- `verify:ui pull-request.py`:Debug 场景改为原生 items 后即为回归(按 label 点 `PR #31…` 和 `更多`)
- `pnpm check`、`pnpm verify:build`
