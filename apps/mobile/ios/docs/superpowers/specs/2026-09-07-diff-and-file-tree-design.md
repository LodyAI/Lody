# Diff 与项目文件树

## 问题

iOS 端看不到助手改了什么。`DetailBlocks.tsx` 里的 `DiffBlock` 用集合比较伪装成 diff，没有行号、hunk、高亮；一轮对话改了哪些文件没有汇总入口；项目目录只在"新建会话选目录"时能浏览，看不了文件内容。桌面端这三件事都有：diff 由 Machine 返回新旧快照、客户端用 `@pierre/diffs` 渲染；文件树和文件读取走 `local-project/control` 与 `file/preview`。

## 决定

按 1 → 2 → 3 顺序做三块页面，全部使用现有 Machine RPC 通道和 LodyKit 原生视图模式：

1. 工具调用 diff：`itemDetailPage` 内的 `DiffBlock` 换成原生 `NativeDiff`，数据源不变。
2. 本轮改动：每轮活动行下方一条"查看改动 · N 个文件"，push 到文件列表，点文件看整文件 diff。
3. 项目文件：会话标题弹窗加"项目文件"，新页面浏览目录，文件按类型分流到原生代码查看器或 QuickLook。

diff 渲染（页面 1、2）采用 [onevcat/YiTong](https://github.com/onevcat/YiTong)（Apache-2.0，iOS 16+）：`WKWebView` 承载本地打包的 `@pierre/diffs` 1.0.11 与精简 shiki，输入是 `DiffFile(oldPath, newPath, oldContents, newContents)`，直接对应 `itemDetail` 的 `oldText/newText` 和 `open-turn-diff` 的两份快照。自带语法高亮、词级 inline diff、unified/split、虚拟化滚动、自动深色。不用 Swift stdlib 自算 diff，也不把桌面端的 DOM 渲染器搬进 RN。

单文件查看器（页面 3）不用 WebView：`LodyCodeView` 是 `UITextView`（软换行、系统选区）+ MarkdownView 已带的 `CodeHighlighter`（Highlightr xcode 主题，自动映射深色）+ 自绘行号栏。SF Mono、Dynamic Type、导航栏柔边都是 UIKit 原生行为。

不做：语法高亮之外的主题定制、文件内搜索、CRDT 文件树（`code-collab/init-directory`）、编辑与写回、Markdown 富文本预览（RN 侧没有 Markdown 组件，先按代码高亮显示）、Android。

## 数据层

### 通用 Machine RPC

`modules/lody-kit/data-runtime/machine-rpc.ts` 的 `machineRpc(workspaceId, machineId, method, params, getGrant, signal)` 承接原 `projectControl` 的信封（`jsonrpc/id/rpcVersion/workspaceId/machineId/replyTo/sentAt/expiresAt`）、`${workspaceId}:rpc:req:${machineId}` 与 `…:rpc:res:…` 的流、long-poll 匹配 `reply.id`，返回原始 `{result, error}`。`local-projects.ts` 的 `projectControl` 变成其中一个调用，保留 `reply.result.type === request.type` 校验。

`code-collab/*` 与 `file/preview` 在 Loro Streams 上不是明文：请求 `params` 和回复 `result`（含 `error.data`）都包在 `code-collab-v2-content-envelope` 里，AES-256-GCM，密钥是 `sha256(label \0 salt \0 ownerSessionId)`，与 Machine 的 `deriveCodeCollabV2ContentKeyBytes` 一致。`ownerSessionId` 从已同步的工作区 Meta Flock 会话元数据读取 `parentSessionId ?? sessionId`，与官方客户端一致；业务参数 `sessionId` 仍保留当前子会话 id。共享父会话工作区的子会话不能用自身 id 封装请求，否则 Machine 会返回 owner mismatch。封装在 `sealedRpc`，WebView 用 WebCrypto（页面以 `https://lody.ai` 为 base URL 加载，是安全上下文）。

新用到的方法：

| method                                   | params                              | 用途              |
| ---------------------------------------- | ----------------------------------- | ----------------- |
| `code-collab/open-turn-diff`             | `{sessionId, turnId, path}`         | 页面 2 点文件     |
| `code-collab/open-current-diff`          | `{sessionId, path}`                 | turn 缺失时的回退 |
| `local-project/control` `type: list-dir` | `{localProjectId, relativePath}`    | 页面 3 目录       |
| `file/preview`                           | `{v: 3, sessionId, path, maxBytes}` | 页面 3 读文件     |

`turnId` 就是 transcript 里助手 entry 的 `id`（iOS 现有 `entryId`，与 `itemDetail` 用的是同一个）。`path` 是工作区相对路径，来自 tool_call 的 `path` 或 `list-dir` 返回的 `name` 拼接，不接受用户输入。`localProjectId` 从会话 `projectId`（`${machineId}:local:${id}`）切出；GitHub 项目的会话没有本地目录，不出"项目文件"入口。

上游前提已核对：三个 `code-collab/open-*-diff` 不需要 `init-directory` 或任何 Code Collab 激活，只要会话存在且能解析工作区根；`open-turn-diff` 额外需要 Machine 的 diff-store 里记录过该 turn，否则返回 `turn_unavailable`。`local-project/git-state` 只有 staged/unstaged 布尔值，没有逐文件状态，页面 3 不做 M/A 角标。

### dataRuntime 命令

`data-runtime/files.ts` 实现，`index.ts` 通过 `machineFor(sessionId, path)` 从 meta catalog 解析 `machineId` 与 `localProjectId` 后注册四个方法；`LodyKitModule.swift` 各加一行 `AsyncFunction`，`DataRuntime.sessionCommands` 白名单加 `turnDiff / fileDiff / readFile`（校验 `args.sessionId == sessionId`），`listDir` 走现有 `workspaceId` 校验。请求 payload 仍受 128 KB 与 45 s 限制。

- `turnDiff({sessionId, entryId, path})`：先 `open-turn-diff`，`turn_unavailable` 时改 `open-current-diff`，返回 `{status: 'ok', base: 'turn'|'current', path, old, new, add, del}` 或 `{status: 'unavailable', base, reason, message?}`。快照 `kind` 映射：`text` 解码为字符串；`missing` 为空串；`binary` / `too_large` 原样带 `kind` 回去，不解码。
- `fileDiff({sessionId, path})`：只走 `open-current-diff`，返回同上。
- `listDir({workspaceId, sessionId, relativePath})`：`list-dir`，目录在前、名称不分大小写排序，返回 `{entries: [{name, type}], truncated}`。
- `readFile({sessionId, path})`：`file/preview` v3，`maxBytes = 2 MiB`；返回 `{status: 'ok', path, kind: 'text'|'binary', text|base64, mimeType?, bytes}` 或 `{status: 'error', path, code, message?}`。`file/preview` 不截断，超限直接 `too_large`。

`utf8-gzip-base64` 在 WebView JS 里用 `DecompressionStream('gzip')` 解码（iOS 16.4 起可用，项目 deployment target 为 16.4）。

### 大内容留在 Swift

`turnDiff / fileDiff / readFile` 的结果由 `DataRuntime.parkContent` 截获：正文写入 `ContentStore`，RN 只收到元数据。diff 结果变成 `{status, base, path, handle, oldKind, newKind, add?, del?}`，正文是 `{old, new}` 的 JSON，`kind = "diff"`；文件结果变成 `{status, path, kind, handle, bytes, mimeType?}`，`kind` 由 Swift 判定：`binary` 且 mimeType 为 `image/*` → `image`，其余二进制 → `binary`；文本按扩展名 `.md/.mdx/.markdown` → `markdown`，否则 `text`。原生视图用 `handle` 从 `ContentStore` 取正文；`readContentText(handle)` 可取回文本。页面 1 的 `oldText/newText` 已在 RN，走 prop 直传，视图两条路都支持。

页面 2 的文件列表不发 RPC。history entry 自带 Machine 每轮记录的 `fileDiff: [{filePath, add, del}]`（与 agent 是否在工具调用里附带 diff 无关；Codex 的 `apply_patch` 就不附带），`project.ts` 把它投影成 `EntrySummary.fileDiffs`。`transcript/changes.ts` 的 `changedFiles(entry)` 以 `fileDiffs` 为底，再合并带 diff 内容的 tool_call（同一 `path` 累加 `added/removed`，`delete` → D、`write` → A、其余 M）。

## 原生层

### 依赖接入

沿用 MarkdownView 的 cocoapods-spm 流程：`plugins/withMarkdownView.js` 的包列表加 `spm_pkg "YiTong", :url => "https://github.com/Innei/YiTong.git", :branch => "lody/single-file"`；`LodyKit.podspec` 加 `s.spm_dependency 'YiTong/YiTong'`；`pnpm pods`。许可证 `modules/lody-kit/licenses/YiTong-LICENSE.txt` 与 `pierre-diffs-LICENSE.txt`，由 `native:assets` 一并复制进原生资源。

fork 分支 `lody/single-file` 加四处：`DiffDocument(file: SingleFile)` 单文件模式，WebRenderer 侧用 pierre 的 `File` 渲染，行号与高亮保留、无 +/− 列；`DiffConfiguration.fontScale` 映射到 `--diffs-font-size`；`DiffConfiguration.isEmbedded` 去掉页面 padding、卡片圆角和阴影；`DiffViewController.update` 改为 public 供 UIKit 宿主复用。开 PR 回上游，合并后切回 tag。

### LodyDiffView

目录 `modules/lody-kit/ios/Diff/`，`ExpoView` 子类，持有一个 YiTong `DiffViewController`：不做 child VC 容器，`loadViewIfNeeded` 后把 `controller.view` 作为子视图铺满，后续变化走 `update(document:configuration:)`。

- props：`path`、`oldText? / newText?` 或 `handle`、`diffStyle: 'unified' | 'split'`、`scrollEnabled`；setter 合并到一次 run loop 再渲染。fork 的单文件模式保留但 app 不再使用
- configuration：`appearance = .automatic`，`showsFileHeaders = false`（导航栏已有标题），`wrapsLines = false`，`indicators = .bars`，`isEmbedded = true`
- `fontScale = UIFont.preferredFont(forTextStyle: .body).pointSize / 17`，跟随 Dynamic Type；字号档位或深浅色变化时重渲染
- events：`onRender({fileCount, contentHeight})`、`onFail({message})`。`contentHeight` 来自 `webView.scrollView.contentSize` 的 KVO，页面 1 用它撑开 block 高度
- 滚动：`scrollEnabled` 时把 `webView.scrollView` 通过 `setContentScrollView` 交给宿主 VC，透明导航栏与 soft scroll edge 由 UIKit 处理；页面 1 内嵌时 `scrollEnabled = false`，`contentInsetAdjustmentBehavior = .never`，由外层 sheet 滚动
- 注册：`View(LodyDiffView.self) { Events("onRender", "onFail"); Prop(...) }`，RN 侧 `modules/lody-kit/src/diff/NativeDiff.tsx` 一行 `requireNativeView('LodyKit', 'LodyDiffView')`

### LodyCodeView

目录同上。`UITextView`：`isEditable = false`、按视图宽度软换行（手机上横向滚动不便，行号只标逻辑行）、`contentInsetAdjustmentBehavior = .automatic`，并通过 `setContentScrollView` 交给宿主 VC。正文用 `ChatMarkdownTheme.make` 的 code 字体（`monospacedSystemFont` × Dynamic Type 比例），`CodeHighlighter.current.highlight` 出颜色表后 `apply(to:with:)`；语言按扩展名映射表，超过 256 KB 只显示纯文本。`GutterView` 固定在左侧，按 `NSLayoutManager` 可见行片段绘制行号（只在段落起始片段画），滚动时重绘。props：`handle`、`path`；event：`onFail`。

### ContentStore

`modules/lody-kit/ios/Cloud/ContentStore.swift`：自维护 LRU（NSCache 淘汰不确定，不便验证），key 为 handle（UUID 字符串），值为 `{data, kind, path, session, mimeType}`，上限 32 MiB。`closeSession` 时清该 session 条目；memory warning 时清空，视图重新取。`ContentStore.classify` 是上面的 kind 判定。

### QuickLook

`AsyncFunction("previewContent") { handle }`：`ContentPreview` 把 `ContentStore` 里的 `Data` 写到 `tmp/preview/<handle>/<basename>`，从当前 VC `present(QLPreviewController)`，dismiss 时删除该目录；app 启动清 `tmp/preview/`。图片、PDF、视频、Office 全交给系统。

## 页面与入口

### 页面 1 · 工具调用 diff

`DetailBlocks.tsx` 的 `DiffBlock` 换成 `<NativeDiff path oldText newText scrollEnabled={false} />`，高度由 `onRender.contentHeight` 驱动；`diffLines` 删除。`CommandBlock / OutputBlock / RawBlock` 不动。`onFail` 时该 block 退回原始 JSON。

### 页面 2 · 本轮改动

- 入口：Swift `ChatTranscript.rows` 对已完成的助手 entry 追加一条 `kind: "changes"` 行（"查看改动 · N 个文件"，插在最后一条 summary 行之后），N 是 `fileDiffs` 路径与带 diff 内容的非读取工具调用路径的并集大小；`ChatCell` 以 systemBlue 显示，44 pt 可点，点击发 `onTurnChangesPress({entryId})`；`NativeChat` 透传。RN 侧 `aggregate.ts` 不变。
- `turnChangesPage`（`src/features/sessions/changes/`）：`present`，`style: 'push'`。标题"本轮改动"，section header `N 个文件`，headerValue `+add −del`。`NativeGroupedList` 一段，行字段用现成的 `title = basename`、`subtitleMono = dirname`、`badge = 'M'|'A'|'D'`、`diff = {add, del}`、`navigates = true`。文件列表由 `SessionScreen` 用 `changedFiles(entry)` 算好后作为 params 传入。
- 点行 `push(fileDiffPage, {sessionId, entryId, path})`：调用 `turnDiff`，拿到 handle 后 `<NativeDiff handle mode="diff" diffStyle />` 铺满页面；顶部一行 `+add −del · 本轮改动 | 当前工作区与基线`。底部是原生 `LodyDiffToolbar`：`UIGlassContainerEffect` 里两个玻璃胶囊（iOS 26 以下退化为 `systemChromeMaterial`），左边 `+add −del · 本轮|当前` 统计，右边 `UISegmentedControl` 切 Unified/Split，选择用 `writeLocalValue('diffStyle')` 记住。
- 列表行保持选中直到返回，返回手势取消时恢复（沿用现有 NativeGroupedList 行为）。

### 页面 3 · 项目文件

- 入口：`SessionScreen` 标题点击现有的 Alert 加"项目文件"按钮（会话页标题不是 `LodyTitleMenu`），会话 `projectId` 不含 `:local:` 或会话已归档时不出现。
- 新建 `files/FilesScreen.tsx`（`filesPage`，push）：`DirectoryScreen` 已超 300 行且服务于"选目录登记项目"，浏览模式单独成页。`listDir` 列表，目录行 `image = 'folder'`、文件行 `image = 'doc.text'`；子目录 `push(filesPage)`；`truncated` 时 footer 提示"仅显示前 2000 项"。
- 点文件 `readFile` → 按 `kind` 分流：`text` 与 `markdown` → `push(filePage, {path, handle, bytes})`，页内 `<NativeCodeView handle path />`（RN 侧没有 Markdown 组件，Markdown 先按代码高亮显示）；`image | binary` → `previewContent(handle)`，不进新页面。

### `@lody-ios/kit` 导出

`NativeDiff`、`NativeCodeView`、`NativeDiffToolbar`、`turnDiff`、`fileDiff`、`listDir`、`readFile`、`readContentText`、`previewContent`、`localProjectIdOf` 与对应类型，放在 `modules/lody-kit/src/diff/` 与 `modules/lody-kit/src/runtime/LodyKit.ts`。

## 错误与边界

- Machine 离线或超时：页面 2 列表照常（数据来自 transcript），点文件时页内显示"电脑离线，无法取回改动"+ 重试；页面 3 首屏失败显示 footer 错误与"重试"行。不弹 alert。
- `unavailable.reason`：`turn_unavailable` 自动退 current（顶部改"当前工作区与基线"）；`not_changed` 显示"该文件在本轮没有改动"；`base_unavailable` / `transient_io` 显示原因；`unsupported_binary` 提供"预览文件"按钮走 QuickLook。
- 快照 `kind`：`missing` 一侧按空文本；`binary` 提供"预览文件"按钮；`too_large` 显示"文件超过 1 MiB，无法内联显示"。
- 文件上限：文本 2 MiB（YiTong 单文件上限），二进制 5 MiB（`file/preview` 上限），超过时 `file/preview` 返回 `too_large`，列表行 toast "文件太大，无法预览"。
- `permission_denied`：显示"此会话已归档，无法读取文件"。
- 内存：`ContentStore` 32 MiB LRU，session 关闭清理，memory warning 清空。
- YiTong `didFail` → `onFail` → 页面 1 退原始 JSON，页面 2/3 显示错误态。YiTong 的 WebView 与 `DataRuntime` 的 watchdog 互不相关。

## 测试与验证

Node（`pnpm test`）：

- `tests/files-rpc.test.mjs`：信封 seal/open 往返与 keyId 校验；`turnDiff` 解 gzip、`turn_unavailable` 退 current 并标 `base`；错误透传 code/message；`readFile` 文本/二进制/错误分类；`listDir` 经 `local-project/control` 且目录在前。
- `tests/local-projects.test.mjs`：`projectControl` 仍校验 `request.type`、拒绝错误、可取消。
- `tests/changes.test.mjs`：同 path 合并 add/del，忽略读取，保留删除。

Swift（`verify:native` 的 `content-store`）：LRU 淘汰、按 session 清空、超限单体、kind 分类。

模拟器行为验收（Acceptance 模拟器，axe 驱动）：

1. 活动行 → 详情 sheet → `NativeDiff` 渲染，高亮与 +/− 正确，切深色不重载。
2. "查看改动"行 → 本轮改动 → 点文件 → diff 页；返回手势可交互取消且行选中恢复。
3. 标题 → 项目文件 → 子目录 → `.tsx` 进查看器、`.png` 弹 QuickLook。
4. 断开 Machine：页面 2 列表仍在，点文件出离线态 + 重试。
5. 首次打开 diff 到出画面的耗时可接受。

常规：`pnpm check`、`pnpm bundle`、iOS 模拟器 Debug 构建，保持签名。不快照 YiTong 的 HTML 输出。
