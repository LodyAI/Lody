# 离屏数据运行时 POC

## 实现范围

- Swift `DataRuntime` 持有一个活动 WKWebView。RN 通过 `subscribeCatalog` 订阅工作区目录；每个订阅有独立 owner，旧 owner 的取消不会关闭新订阅。
- WebView 加载随 App 打包的代码，负责 Flock 副本、Streams bootstrap、long-poll、游标和网络重试。长效登录凭据保留在 Keychain，Swift 只向当前 WebView 交付短期工作区 grant。
- 主框架事件及异步回调校验当前 WebView 身份，已被替换的进程不能覆盖新进程的数据。网络失败标为 offline，不当作 JS 卡死。
- Swift 每 2 秒调用 JS ping，启动超时 20 秒、心跳超时 8 秒。Timer 运行在 common run-loop mode，滚动不暂停检测。60 秒内最多自动重建 3 次，随后熔断；手动重新同步开启新的重试预算。
- 切后台保留 WebView，暂停 watchdog 判断；前台恢复心跳宽限，同一 WebView 继续运行，只有进程丢失才重新 bootstrap。注销仍停止运行时。iOS 26 在用户发送时申请 `BGContinuedProcessingTask`，按发送、接收和完成报告真实阶段；回复完成、等待用户确认、失败或系统到期后释放。申请失败不阻止前台发送，不自动重放写入。
- RN 保留用于展示的投影，重建或网络故障期间它可能过期。恢复会重新读取服务端，不自动重放写操作。

现在可从项目 → 会话 → 消息页读取 Session 正文并发送纯文本。一个活动会话由 WebView 中的 Loro WASM 副本管理；Swift 记住订阅，在进程恢复后重新 bootstrap。关闭消息页释放该订阅，不停止目录。RN 使用稳定消息 ID 渲染增量文本，按 `userTurnId` 关联排列回复；非文本块显示类型占位。

发送依次写入 Loro 用户历史、Flock `latestUserMsgId`，再发送 `session/dispatch-turn` RPC。两种 CRDT 增量均使用 uint32 大端长度封装。上传、机器接收、生成完成是不同状态；响应不明确时保留草稿并阻止再次点击发送。恢复不重放写操作。

仍不包含 CRDT 磁盘副本、离线写入、完整工具卡片、附件发送、权限交互、Agent Role 配置、完整 loro-repo 适配或后台常驻保证。会话使用上次输入的执行配置；有 Agent Role 时拒绝发送，避免绕过其绑定。目录本轮输入上限 8 MiB / 100 页，会话 32 MiB，超过限制需重新同步。会话网络错误有手动重新同步入口。

## Safari 调试

Debug 构建在 iOS 16.4+ 对每次创建的运行时 WebView 设置 `isInspectable = true`。重新编译并安装 App，进入工作区后，在 Mac Safari 的「开发 → 模拟器或设备 → Lody Data Runtime」中连接。WebView 继续离屏运行，无需添加到界面。真机需要开启 Safari 的 Web 检查器；模拟器默认开启。Release 构建不开放检查。

进入后台保留 WebView；系统回收进程或看门狗重建后需重新连接。断点暂停超过心跳期限仍会触发看门狗，调试入口不改变恢复策略。

## 自动检查

```sh
pnpm check
pnpm test
pnpm bundle
swiftc -module-name LodyCore packages/lody-core/Sources/LodyCore/RuntimeHealth.swift apps/mobile/modules/lody-kit/verification/watchdog/main.swift -o /tmp/lody-watchdog-check
/tmp/lody-watchdog-check
```

JS 检查使用真实 Flock/Loro WASM 与受控 Streams 响应，验证副本更新、游标推进、独立解帧、历史先于派发持久化、流式文本、重复增量去重、因果排序和退订。Swift 检查注入单调时间，验证启动/心跳期限、重启预算和前台宽限，不依赖 sleep。

## 模拟器验收记录（2026-09-06）

使用 Lody iOS Acceptance（iOS 26.5），正常签名 Debug 构建，真实用户通过既有 App 登录态读取官方工作区。

- 离屏 WebView 直接访问 Streams：成功显示 6 个项目、9 个 Session 元数据。
- Debug 按钮注入 `while (true) {}`：Swift 看门狗替换 WebView，重新 bootstrap 后恢复同一目录。专用 Debug 页面保留 `heartbeat_timeout` 重建原因。
- 定位当前 Lody 数据 WebView 的 WebContent PID 后实际 SIGKILL：App 进程存活，新一代 WebView 自动恢复目录。未终止其他 App 的 WebContent。
- 连续模拟故障后进入 `failed / restart_limit`，手动重新同步恢复 `live` 和相同目录。
- 后台停留超过心跳期限再返回，自动重建并恢复 `live / foreground`，没有把挂起计作超时失败。

## 消息链路验收（2026-09-06）

- 真实会话历史读取成功。最终编码的测试从 iOS 输入框发送，桌面收到 CRDT 后开始执行；随后 RPC 返回 `duplicate` ACK，证明两条通知路径没有重复执行。CLI 记录同一 turn 只有一次 execution start 和一次 completed，执行约 8.1 秒。
- iOS 显示 `LODY_IOS_FRAMED_OK_0906`，用户条目为 handled，助手条目完成；消息数 9 → 11，正文位于对应用户消息之后。
- 最终构建中消息页打开时实际终止其 WebContent（无热更新），运行时从第 2 代变为第 3 代，原因 process_terminated。App 主进程继续存活，重建后恢复同一 11 条消息；CLI 执行计数仍为 1。返回前台也恢复同一会话。
- 初次测试暴露缺少 Streams 长度帧，造成桌面读取失败。已发布保留全量历史的快照，并备份/清除仅该会话的桌面派生同步游标，使本地尚未上传的回复继续同步。未删除历史。临时修复代码已移除，正式发送只写合法帧。其他曾缓存坏帧前游标的客户端可能也需要重新 bootstrap；未逐个验证这些客户端。
- 首次故障还触发 daemon 的因果等待超时。RN 投影现在通过 `userTurnId` 保证用户消息在回复之前，合成测试覆盖这一历史顺序。

## 手动复现

1. 项目页等待 `live` 和目录计数。没有账号时先通过官方授权登录。
2. 点击「POC：卡死 WebView JS」。不操作刷新，等待约 8 秒检测超时及网络重新同步；应恢复 `live`，代数增加，原因 `heartbeat_timeout`。
3. 点击「POC：模拟进程丢失」可测试同一重建入口；它是模拟故障按钮，真实进程终止另由系统 delegate 回调处理。
4. 快速连续触发四次模拟进程丢失，应显示 `failed / restart_limit`，代数停止增长。点击「重新同步项目与会话」应恢复。
5. Home 进入后台，停留超过心跳期限后重新打开 App。健康 WebView 的代数应不变，不计为失败重启；若系统实际回收了 WebContent，则前台重新 bootstrap。

此记录是模拟器与合成协议用例的证据，不是长时间真机后台、内存压力或电量验证。前台每 2 秒唤醒离屏 JS 的开销需要后续真机测量。

## 新建会话（2026-09-06）

项目会话列表的「＋」通过结果返回 Sheet 选择现有电脑/助手配置。配置从 Swift 所有的运行时副本投影，只向 RN 提供名称与标识，不投影环境变量、启动命令或凭据。创建时重新校验项目与配置；本地项目固定所属电脑，正在删除的项目不可创建；GitHub 项目要求明确分支。

创建顺序为建立空的二进制消息流，再写入 `e/session-*` 与 `m/session-*` 元数据。目录写入使用独立 Flock 增量，收到成功响应才合入本地副本；响应未知时保留原会话 ID、不重放、不发布本地幻影条目。创建成功后关闭 Sheet 并 push 消息页，第一条消息复用历史 → 派发指针 → Machine RPC 的现有链路。关闭 Sheet 后迟到的完成回调不会再触发导航。

行为测试覆盖真实 Flock/Loro 解帧、新建后空历史与首条消息、无效配置/跨机器目标、GitHub 分支、删除中的本地项目、流建立失败以及目录 ACK 丢失且禁止重放。

本轮通过 `pnpm check`、9 项行为测试、Hermes bundle 和正常签名的 iOS 模拟器构建。模拟器已验证读取现有助手配置、真实创建、目录同步和进入已连接的空会话。首条验收消息在电脑服务停止时成功保存至 Cloud；启动已安装的 Lody 桌面客户端后，电脑从持久化派发指针恢复执行。iOS 重新打开同一会话后显示预期回复 `LODY_IOS_CREATE_OK_0906`。日志确认该轮仅一次 execution start、一次 completed，执行约 23.8 秒，未重发消息。GitHub 分支创建路径目前由行为测试覆盖，尚未做真实仓库执行验收。

## App 本地启动

LodyKit 的 SQLite 保存账号展示信息、上次工作区和完整目录投影，按账号和工作区隔离，不保存凭据或消息 CRDT。启动用一次后台原生调用读取当前工作区；RN 先展示旧数据，身份校验和 WebView bootstrap 在后台进行。同步失败保留旧目录，导航栏以圆点提示离线，VoiceOver 保留状态说明；自动同步不拉起下拉刷新控件。登录失效和注销会清理本地缓存。

当前按工作区保存完整 JSON 投影，受运行时 12 MiB 输出上限约束；不是分页数据库，也不缓存消息正文。目录规模增长时应先测恢复耗时，再迁移到索引行与分页读取。Debug 日志 `LodyLocal startup_ms` 测量原生 SQLite 读取（不含 RN 渲染）。

可运行 `swiftc apps/mobile/modules/lody-kit/ios/Cloud/LocalStore.swift apps/mobile/modules/lody-kit/verification/local-store/main.swift -o /tmp/lody-local-store-check && /tmp/lody-local-store-check` 验证真实 SQLite 重开、工作区回退和清理。`simctl launch … app.innei.lody --lody-offline` 注入账号恢复失败及官方后台的 URLProtocol 网络错误，用于有本地目录时的冷启动验收；只有带该启动参数时才注册此协议。
