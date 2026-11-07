# 会话图片相册：原生 lightbox 左右翻页

## 问题

消息列表里的图每次只能看一张。`ChatImageCell` 自己 `present(ChatImagePreview)`，相册范围就是那一个 cell。用户一条里的多张图、助手 `image_group` 拆开的多行、跨轮的图，都不能横滑。

Composer 草稿预览已经是 `QLPreviewController` 多文件。非图附件走 Quick Look。缺的是 transcript 里的图相册。

PanelUI `ImageViewer` 的产品行为对（同一 root 下左右翻、放大不翻页、关闭再量缩略图），但不能直接用：它是 Reanimated + Uniwind 的 RN 组件，Trigger 必须是 RN 树里的 view；聊天是 `LodyChatView` 的 `UICollectionView`；云图用 Keychain Bearer，RN `<Image uri>` 过不了鉴权。缩略图本身已是 aspect-fit，也不需要它的 cover 展开动画。

## 目标

点列表里任意一张图，打开同一套原生 lightbox，可在**当前已加载 transcript** 的全部图之间左右翻。转场继续系统 zoom 和下拉关闭。外观对齐 PanelUI：毛玻璃、inset contain、连续圆角、左上关闭、多图计数。

## 决定

| 项             | 选择                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实现           | 扩展 `ChatImagePreview`，不引入 `panelui-native` / Uniwind / RNGH                                                                                             |
| 相册范围       | 当前 snapshot 里所有能当图画的条目，按列表顺序                                                                                                                |
| 未加载历史     | 不计入，不自动拉更早页                                                                                                                                        |
| 非图           | 仍 Quick Look / `SessionFilePreview` / `ChatAttachmentPreview`                                                                                                |
| Composer 草稿  | 仍 `QLPreviewController`，不并进这本相册                                                                                                                      |
| 转场           | `overFullScreen` + `preferredTransition = .zoom`。模糊层不跟着 zoom 形变：打开/关闭时单独把 backdrop alpha 从 0 插到 1，避免全屏 modal 闪黑、材质从缩略图拉满 |
| 下拉关闭       | 系统 zoom 交互关闭，不自绘竖直 dismiss                                                                                                                        |
| 翻页容器       | 不用 `UIPageViewController`（和 modal pan 抢手势）                                                                                                            |
| 缩略图裁切     | 保持 aspect-fit；不做 cover → contain 飞行                                                                                                                    |
| 打开后列表变化 | 仅相册入口：重算 items；当前 id 还在则留在该页，消失则关闭                                                                                                    |
| 展示 API       | 单张和相册是两个入口。`ChatImagePreview` 不要求调用方先组 list                                                                                                |

## 所有权

`ChatImagePreview` 只负责呈现：zoom、缩放、chrome、鉴权下载。它不知道 transcript。

相册收集留在 `LodyChatView`。消息列表点图走相册入口。别处要看一张图，走单张入口，不必扫列表、也不必包成 `[item]`。

`ChatImageCell` 不 present。它提供 zoom source view，以及单张/相册都要用的 `ChatImage` / 本地 URI / 下载材料。

RN 不参与 lightbox。Debug 仍用现有 Fixtures 灌图。

## 相册条目

从 `dataSource.snapshot().itemIdentifiers` 顺序扫描 `rows`：

1. `kind == "image"` 且 `row.image != nil` → 一条。id = `row.id`（`entryId:itemId:image:n`）。
2. `kind == "attachments"` 里每个 `attachment.image != nil` → 一条。id 与无障碍 id 一致：`entryID + ":attachment:" + (localID ?? id)`。

其它 kind、没有 `ChatImage` 的附件格，不进相册。缩略图加载失败但行上仍有 `ChatImage` 的，要进相册；打开后走现有重试。

```swift
struct ChatImagePreviewItem: Equatable {
  let id: String
  let image: ChatImage
  let localURI: String?
  let placeholder: UIImage?
}
```

`placeholder` 在打开时从可见 cell 拷一份，飞行和首帧用；原图仍按现有 Bearer 路径拉。workspace / session 由调用方传入（聊天里用当前的 `imageWorkspace` / `imageSession`，单张图的 `storageSessionId` 覆盖 session）。

## 展示入口

两个 present，都要求 `presenter.presentedViewController == nil`。

**单张** — 直接给图，没有翻页、没有 `n of m`。手势只剩缩放、双击、单击显隐 chrome、点图外关闭、系统下拉关闭。

```swift
ChatImagePreview.present(
  from: UIViewController,
  image: UIImage?,
  name: String,
  url: URL?,
  sourceView: UIView?
)
```

`url` 为 nil 时只显示传入的位图（fixture、本地已经在手的图）。有 url 则先显示 `image` 再拉原图。调用方不必构造 `ChatImagePreviewItem`。

**相册** — 消息列表用这条。

```swift
LodyChatView.openImageGallery(id: String, source: ChatImageCell?)
```

内部：从 snapshot 收 items → 找不到 id 则 return → `pauseTracking()` → present `ChatImagePreview(items:index:workspace:session:sourceView:)`。`sourceView` 按**当前页 id** 问 chat view。

`ChatMessageAttachmentsCell` 按 attachment id 交出对应 `ChatImageCell`。助手行用 `cellForItem` 得到的 `ChatImageCell`。

实现上单张可以是 `items.count == 1` 的同一套 VC，但对外入口不能逼调用方组数组。`count == 1` 时不装横滑、不计页码、VoiceOver 不是 adjustable。

## 转场

`ChatImagePreview.preferredTransition = .zoom` 的 source provider：

1. 问 chat view：当前页 id 的缩略图。
2. 缩略图必须 `window != nil`。
3. 助手行：cell 的 `photo`。附件格：tile 的 `photo`。
4. 与现网一样：cell 已改去显示另一张 URL 则返回 nil。
5. 不在窗口（滚走、复用成别的 id）→ nil，系统淡出，不飞到错误格子。

翻页后 source 跟着当前页变。关闭（按钮、escape、点图外、下拉）都走同一套。

Reduce Motion 交给系统 zoom；翻页不用弹簧，直接对齐页。

## 手势

每页一个 zoom `UIScrollView`（`minimumZoomScale = 1`，`maximumZoomScale = 4`）。`count == 1` 不装外层横滑。`count > 1` 时在 pan began 锁模式，中途不改：

| 条件                      | 模式                               |
| ------------------------- | ---------------------------------- |
| 当前页 `zoomScale > 1.01` | 图内平移；不翻页                   |
| `                         | dx                                 | >   | dy  | ` 且 fit | 翻页；松手按位移和速度投影，一次最多一页 |
| 竖直为主                  | 不开始翻页，交给系统 zoom 交互关闭 |

双击：fit → 2.5×（焦点在点击处）；已放大 → 1。与单击互斥（双击识别失败才单击）。

单击：点在图的 fit 矩形上（含当前缩放）→ 开关 chrome；点在图外且不在 chrome 上 → 关闭。

换页时该页缩放重置为 1。只保有当前页 ±1 的 page view。

几何（fit 矩形、一次一页的 snap、点是否落在图上）放纯函数，不碰 UIKit，测放在 `modules/lody-kit/verification/chat`。

## 外观

静止态对齐 PanelUI，用 UIKit 语义色和系统材质，不用 Tailwind token。

- 图 contain 在盒子里：左右 inset 16；上下 `max(safeTop, safeBottom) + 16`，保证相对屏幕中心对称。`inset = 0` 不在本期。
- 连续圆角 16。缩放时圆角在屏幕上的大小保持（边框半径随 scale 反除）。
- 背景 `systemThinMaterial` 再叠 10% 黑（PanelUI blur 50 + `bg-black/10`）。Reduce Transparency 改为黑 60%，不画模糊。
- Chrome 对齐 PanelUI：关闭钮在 leading，44 圆，`systemBackground` 80% + `.label` 的 xmark。多图时 `n of m` 胶囊在顶栏水平居中（左右用等宽占位，不是贴 trailing）。文件名只做无障碍 label，不画底栏 caption。chrome 随单击显隐；打开时显示。
- 页与页之间留 16pt 缝，翻页时能看见两张图。
- 预览根 view `accessibilityIdentifier` 仍为 `chat-image-preview`。

系统 zoom 形变的是整页 VC。目标形态是圆角图 + 四周材质，而不是现在的满屏黑底。若实测形变把材质方块从缩略图拉满，优先保证飞行主体是图：VC 背景透明，材质单独 fade，图 view 才是 zoom 内容。验收以观感为准，不锁死 blur 的实现类。

## 加载与错误

每页沿用 `ChatImageCell` / 现 `ChatImagePreview` 的顺序：

1. fixture `ui-verify-image`：合成位图，不发网。
2. `localURI` file URL：本地图，不发网。
3. 否则 thumbnail URL（768）失败再 original download URL，`Authorization: Bearer` from Keychain。
4. 打开时已有 placeholder 则先显示，原图到达后替换并重新 fit。
5. 失败且没有位图：重试按钮。有位图则留着，重试藏起来。

不在 lightbox 里做上传进度。上传中的用户格仍可打开已有 placeholder。

## 无障碍

- 图本身：label 为文件名，value 为缩放百分比（现网 `photo` 元素）。
- 多图时外层再加 adjustable，value 为 `n of m`；increment / decrement 翻页。
- escape 与 magicTap 关闭。
- 关闭按钮、计数、caption 在 chrome 隐藏时不接收 VoiceOver。
- Android 不存在。

## 文件拆分

- `ChatImageCell.swift`：格子、缩略图加载；对外提供 zoom source view（现有 `photo`）。
- `ChatImagePreview.swift`：相册 VC、pager、chrome、转场。
- `ChatImagePreviewGeometry.swift`：fit / snap / hit-test。
- `ChatMessageAttachmentsCell`：按 id 返回 tile；打开仍 callback 到 chat view。

单文件不超过现有风格的体量；preview 不再塞进 cell 文件。

## 验证

无登录 Debug 场景。不引入新的依赖登录路径。

现有必须仍过：

- `verification/ui` 的 `image-preview`（send-transition 里的本地附件）：打开、下拉关闭。
- `modules/lody-kit/verification/chat/image-preview.py`：Image Fixture 打开、双击放大/还原、按钮关、下拉关、标题两行几何不变；MCP 两张仍 inline，点第一张能打开并关回。

新增行为（同一套 MCP Fixture 或独立 debug 场景，可加进现有脚本）：

- 打开 `preview-image:photo:image:0`，横滑到第二张；chrome 为 2 of 2；关闭后若第二张仍可见，zoom 回到 `…:image:1`。
- 放大后横滑不换页（仍 1 of 2，文件名仍是第一张）。
- send-transition 混合附件：两张 png 可互滑；点 txt 仍不是 `chat-image-preview`。

截图：打开、翻页后、放大。视频：横滑翻页、放大后不翻页、下拉关闭。

## 不做

- 接入 PanelUI / Uniwind / 用 RN overlay 盖在 `NativeChat` 上
- 从 inbox 或未打开会话扫图
- 相册内编辑、保存到相册、分享 sheet（需要再说）
- 视频、GIF 动图控件（仍当静图或走文件预览的现有分流）
- 把 Composer 草稿并进 transcript 相册
- 跨会话相册
- Android
