# SET-01 确定分组契约并采集改动前基线

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                              |
| -------- | --------------------------------- |
| 阶段     | 第一阶段                          |
| 优先级   | P0                                |
| 状态     | 已完成                            |
| 依赖     | 无                                |
| 当前授权 | 已授权执行 SET-01；不迁移产品页面 |

## 目标

把已讨论的首页分组变成可验收的页面契约，采集改动前的真实界面，给后续迁移提供对照。

## 当前依据

首页已经使用 NativeGroupedList；登录后的账户、会话、工作区、连接、外观、通知、聊天、关于分组混用了入口、具体选项和状态。当前 SettingsPreviewScreen 主要覆盖远程设置，不代表完整首页。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/SettingsScreen.tsx`
- `apps/mobile/modules/lody-kit/src/list/NativeList.ts`
- `apps/mobile/modules/lody-kit/ios/List/LodyGroupedList.swift`
- `apps/mobile/src/screens/debug/HomePreviewScreen.tsx`
- `apps/mobile/src/screens/debug/SettingsPreviewScreen.tsx`
- `apps/mobile/verification/ui/home.py`
- `apps/mobile/verification/ui/appearance.py`

## 工作内容

- [x] 按总计划确认账户、个人、工作区、会话与记录、其他、开发六类 section，以及每个入口的归属。
- [x] 记录现有 row ID、跳转目标、选择态、偏好持久化位置和调用方；实现前重新搜索所有调用方。
- [x] 补足或复用可重置的离线首页场景：未登录、已登录但无工作区、已选工作区、同步中、离线、有缓存。
- [x] 记录账户切换与工作区切换时应保留和清除的内容；工作区数据不得沿用上一作用域。
- [x] 使用旧构建采集英文浅色／深色的首页、滚动到底部、返回和交互取消证据；记录设备与构建。

## 验收标准

- [x] 分组、行、标题、说明、点击结果和可见条件均可从总计划追溯。
- [x] 旧构建基线和缺失场景都有记录；无法采集的状态不得标成已通过。
- [x] 只在确有独立行为时补检查，不为 section 常量数组编写快照测试。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

本任务不迁移页面、不补云端功能、不修改共享 collection view 的布局。

## 关联任务

[SET-02](./02-preferences-page.md) · [SET-03](./03-appearance-page.md) · [SET-04](./04-about-page.md) · [SET-05](./05-home-sections-and-connection.md) · [SET-06](./06-phase-one-acceptance.md)

## 实施记录

- 开始日期：2026-10-16。
- 范围：分组契约、调用方和存储盘点、Debug 离线场景、原排版基线；未修改 SettingsScreen 或共享原生列表。
- 构建：`main`，`ced0e0b3d11b82c3c1d85c8be78bee10dadccd50`；构建前工作树只有本计划文档，之后增加本任务 Debug／verification 改动。
- 完成日期：2026-10-16；首轮契约与原排版基线已完成，SET-02 至 SET-05 尚未实施。
- 验证与证据：见文末；英文浅色／深色六状态均完成采集并通过行为检查。

## 已确认的目标分组

本节是 SET-02 至 SET-05 的界面契约。标题在实现时加入 en／zh-Hans；本节中文用于说明。

| section ID  | 标题与显示条件                           | 内容与说明                                                                    |
| ----------- | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `account`   | 无 section 标题，始终显示                | 已登录：头像、姓名、邮箱，进入现有账户页；未登录：欢迎信息，无假导航箭头      |
| `personal`  | 个人，始终显示                           | 偏好设置、外观两个导航入口；说明分别概括通知／会话行为和背景／颜色／图标      |
| `workspace` | 工作区，已登录显示；有工作区时附当前名称 | 有工作区时显示机器、Agents、MCP、连接 footer 和离线恢复；无工作区时只显示说明 |
| `sessions`  | 会话与记录，需要有效工作区               | 保留项目历史及已归档会话，数据归属当前工作区                                  |
| `other`     | 其他，始终显示                           | 关于、诊断；报告 Bug 等待独立任务完成后才接入                                 |
| `developer` | 开发，仅 `__DEV__` 或 `uiVerify`         | Debug；保留现有退出 Settings 后进入 Debug 的导航行为                          |

已登录但没有工作区时：工作区 section 显示明确说明，不显示机器／Agent／MCP 可点击行，不显示会话记录；不得打开空页后立即退出。未登录时不显示工作区连接状态。

首轮不增加工作区选择器，不改变现有 Settings formSheet、内部 push、关闭按钮或自动滚动边缘。账户、偏好和关于页继续使用现有页面契约。

## 现有行与迁移归属

保留二级页内的既有 row ID，更新检查的入口路径；新首页入口与旧菜单不能混用同一个控件选择器。首页外观入口用 `appearance-open`，原 `appearance` 继续代表深色背景菜单；偏好入口用 `preferences`，关于入口沿用 `about`。

新增首页入口的文案契约：偏好设置／Preferences，说明“通知与会话行为／Notifications and chat behavior”；外观／Appearance，说明“背景、强调色与 App 图标／Background, accent color, and app icon”；关于／About，说明“版本与开源许可／Version and open-source licenses”。已有入口标题沿用翻译目录；实际排版按默认字号检查，不为英文长文案增加专门布局。

| 当前 section／row ID                     | 当前交互与目标                                         | 目标归属                                         |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| `account`／`account`                     | 已登录时 push AccountScreen；未登录是信息行            | 首页账户卡片，SET-05                             |
| `sessions`／`project-history`            | push ProjectHistoryScreen，当前按登录显示              | 首页会话与记录，增加有效工作区条件，SET-05       |
| `sessions`／`archived`                   | push ArchivedSessionsScreen                            | 首页会话与记录，SET-05                           |
| `remote`／`remote-machine`               | push RemoteSettingsScreen，kind=machine                | 首页工作区，SET-05                               |
| `remote`／`remote-agent`                 | push RemoteSettingsScreen，kind=agent                  | 首页工作区，SET-05                               |
| `remote`／`remote-mcp`                   | push RemoteSettingsScreen，kind=mcp                    | 首页工作区，SET-05                               |
| `connection`／`connection`               | live／syncing 为信息；offline 点击调用 catalog.refresh | 工作区 footer／离线恢复行，SET-05                |
| `appearance-section`／`appearance`       | 原生菜单：soft／black                                  | 外观二级页，SET-03                               |
| `appearance-section`／`accent-color`     | 原生菜单：预设色／自定义 UIColorPicker                 | 外观二级页，SET-03                               |
| `appearance-section`／`app-icon`         | push AppIconScreen，前台重新读取系统当前图标           | 外观二级页，SET-03                               |
| `notifications-section`／`notifications` | push NotificationSettingsScreen                        | 偏好二级页，SET-02                               |
| `chat`／`queued-message-behavior`        | 原生菜单：queue／guide                                 | 偏好二级页的会话行为组，SET-02                   |
| `chat`／`quick-replies`                  | push QuickRepliesScreen                                | 偏好二级页的会话行为组，SET-02                   |
| `about`／`about`                         | 版本及构建号，当前不可点击                             | 关于二级页的信息行；首页改为关于入口，SET-04／05 |
| `about`／`diagnostics`                   | push DiagnosticsScreen                                 | 首页其他，SET-05                                 |
| `about`／`licenses`                      | push LicensesScreen                                    | 关于二级页，SET-04                               |
| `developer`／`debug-open`                | cancel Settings，然后 router.push('/debug')            | 首页开发，SET-05                                 |

`credit-flowdown` 只剩点击处理器，当前 sections 没有对应行。SET-05 迁移处理器时核实后清理，不新增致谢入口来匹配死分支。

### 选择态与导航契约

- `navigates: true` 的入口由 LodyGroupedList 保留选中态；拥有它的控制器返回时沿转场取消选择，交互返回取消时恢复。
- 菜单和重新同步等普通操作行立即取消选择；纯信息行不可选择。
- diffable snapshot 以 section／row 组合标识维护状态，不在 completion 中重选旧行；迁移 section 后重新核对可见检查，不新增手动选中逻辑。
- AccountScreen、AppIconScreen、远程设置、通知、快捷回复、许可、诊断等继续使用 push；原有需要结果的编辑表单继续使用 present。

### 调用方与检查调整清单

- 生产宿主：InboxScreen、PadHomeScreen 的 Settings 按钮，均调用现有 present(SettingsScreen)。
- Debug 宿主：appearance-preview、queued-message-behavior-preview、diagnostics-settings-preview，以及 QuickRepliesPreviewScreen 的设置入口。
- `home.py` 依赖归档及机器入口、Settings 关闭和返回；`project-history-entry.py` 依赖历史入口。
- `appearance.py`、`queued-message-behavior.py` 从当前首页定位具体菜单，迁移后必须先进入对应二级页。
- `quick-replies.py`、`licenses.py`、`diagnostics.py` 与通知检查继续验证生产页面，并更新需要经过首页的路径。
- `settings.py` 只覆盖远程列表及编辑，不可当成首页分组验收。
- iPad 优先复查当前 `ipad-chrome`／`ipad-sidebar` 宿主；README 已指出旧 `ipad` 面板实验不是当前业务验收，SET-06 不应只跑旧 case。

## 持久化与作用域契约

| 能力           | 当前所有者／存储                                                                                | 迁移与切换要求                                                |
| -------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 深色背景       | AppearanceProvider → LodyDarkBackground；standard defaults 的 `darkBackground`，默认 soft       | 页面迁移不换键；账户／工作区切换保留                          |
| 强调色         | AppearanceProvider → LodyAccentChoice；standard `accentColor`，镜像 App Group 同名键，默认 blue | 保留颜色事件和原生界面更新；不因退出登录清除本机外观          |
| App 图标       | 系统 alternateIconName，getAppIcon 读回                                                         | 回到前台重新读取；失败保留旧值，移除页面订阅                  |
| 发送行为       | QueuedMessageBehaviorProvider → standard `queuedMessageBehavior`，默认 queue                    | 保持 queue／guide 消费到真实发送路由；账户／工作区切换保留    |
| 快捷回复       | QuickRepliesProvider → standard `quickReplies` JSON                                             | 保留解析和默认回复，不改成工作区数据、不冒称 Prompt Shortcuts |
| 通知权限       | 系统授权状态／原生推送服务，账户身份由 PushCoordinator 处理                                     | 页面迁移只复用查询和操作，返回前台重读，不伪造本地权限        |
| 实时活动开关   | App Group `liveActivitiesEnabled`，默认 true                                                    | 保留原生活动生命周期；与本机开关和当前账户活动分别处理        |
| 工作区选择     | `workspace:<userId>`；CatalogProvider 的 choice 同时绑定 user                                   | 换账户不能沿用上一账户的选择；换工作区只展示新作用域数据      |
| 工作区 catalog | `catalog:<userId>:<workspaceId>`；SQLite、本机启动快照及 data-runtime                           | 换作用域时同步隐藏旧内容，保留分区缓存供后续恢复              |
| 远程设置列表   | `remote-settings:<userId>:<workspaceId>:<kind>`；每次 requestId／scope 防旧响应                 | 避免旧请求写回新页；缓存时间与错误并列，不冒称 live           |

退出登录的实际路径会先清账户显示，再调用 clearLocal 和 clearAuthToken；切换账户的恢复／登录路径也有清本地数据边界。clearLocal 通过 generation 串行隔离旧写入。以上是源码盘点，不等同于本任务已模拟真实凭据切换。

本任务不修改存储。后续 UI 任务必须保持本机偏好，隔离账户数据；不能为了刷新列表清空整个 UserDefaults 或凭据。

## 离线场景与可复现命令

新增 `settingsBaseline.tsx`，只在 UI Verify 中为真实 SettingsScreen 和其 push 页面注入 Auth／Catalog context 与连接状态。退出场景恢复原 context／连接，覆盖六个可独立重复进入的场景：

| verifyCase                       | 注入边界                                     | 基线关注点                                                   |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `settings-baseline-signed-out`   | account=null，无 catalog                     | 欢迎信息、本机设置、无工作区入口                             |
| `settings-baseline-no-workspace` | 已登录，workspaces=[]，无 selected           | 记录当前仍显示工作区／会话入口的缺口；不把缺口固化为通过条件 |
| `settings-baseline-live`         | 已选工作区、live、2 台已登记机器             | 首页顶部／底部，账户 push、取消返回、完成返回                |
| `settings-baseline-syncing`      | 已选工作区、syncing、无快照                  | 同步中的文字和可达性                                         |
| `settings-baseline-offline`      | 已选工作区、offline、无快照                  | 未同步与恢复操作                                             |
| `settings-baseline-cached`       | 已选工作区、offline、2 台机器与已有 syncedAt | 缓存状态，以及重新同步到注入 refresh 边界                    |

缓存场景注入的是消费侧投影，不能证明 SQLite 冷启动恢复或真实云端连接；测试既不读取用户凭据，也不连接机器或发送回合。

构建和采集命令（均从仓库根目录运行，不传个人设备 UDID）：

```sh
pnpm verify:simulator --name 'SET-01 Settings Baseline' -- pnpm verify:build --json
pnpm verify:simulator --name 'SET-01 Settings Baseline' -- pnpm verify:ui --app '<上一步 app 路径>' --case settings-baseline --require-video --output .artifacts/settings-set-01/ui
```

runner 先设定英文、默认字号和软件键盘，再通过 UI.open_case 深链进入场景；不滚动 Debug 菜单。单独场景也可用对应 verifyCase 重复进入。

## 基线证据与限制

- 设备：受管理的 `Lody SET-01 Settings Baseline Verify`，iPhone 17 Pro，iOS 27.0，UDID `7372E4B7-F3F0-4DF3-B94C-9DD8F76C4E38`。
- 工具：Xcode 27.0（27A266a），AXe 1.8.0；保留签名，使用当前 checkout 的共享 DerivedData。
- 原生构建记录：`.artifacts/settings-set-01/build.json`、`build-driver.log`、`xcodebuild.log`；`source-provenance.json` 确认 SettingsScreen 和 LodyGroupedList 与 HEAD 逐字节一致，记录 App 可执行文件及场景源码哈希。
- 运行来源与状态：`.artifacts/settings-set-01/ui/environment.json`、`results.json`；每个外观下保留六场景 top／bottom、账户返回、重试及 context 恢复的 PNG／AX JSON、`observations.json` 和 `run.mp4`。
- 基线保留旧产品排版，只有 Debug 数据边界和采集脚本是本任务新增。它不证明未来 SET-02 至 SET-05 的目标排版已实现。
- 不涵盖真实登录、Keychain 清理、云端写入、机器在线状态真实性、iPad 或真机触感。后续迁移任务分别验证其修改范围。

### 本轮验证结果

- `pnpm check`、`pnpm bundle`、签名的 `pnpm verify:build` 通过；runner 的 31 个行为测试通过，新增 Python 文件语法检查通过。
- `settings-baseline` 英文 light／dark 两次均通过，覆盖 12 个状态组合；每个组合保留 top／bottom 截图和 AX 树。
- light：场景入口 1.29 秒，检查 169.68 秒；dark：场景入口 1.52 秒，检查 164.26 秒。每个子场景另有 entrySeconds；测量包含截图／AX 采集成本，不能当作 App 页面耗时。
- light：19 张 PNG；视频 173.915 秒，1206×2622，2152 个实际编码帧。
- dark：19 张 PNG；视频 168.583 秒，1206×2622，2163 个实际编码帧。
- 已审阅六状态 top／bottom 对照图、无工作区原始截图，以及返回视频的 2 fps 抽样帧；录像可见边缘返回的中间位置、取消恢复和完成返回。保留原始视频，不声称逐帧闪烁或真机性能验收。
- 重试操作实际到达注入的 catalog.refresh；关闭场景后重新打开原 appearance-preview，确认恢复未登录 context 和无工作区入口的原始状态。
- 首次采集因脚本写死底部坐标把已滚到底判成失败；改为实际视口判断后在同一输出目录重跑，最终 results.json 两次均为 passed。未改产品代码来迁就检查。
- 按仓库内推进的范围，证据保留在本地忽略目录，不自动上传外部验收服务。

### 已记录、交给后续任务的差异

1. 已登录但无工作区时仍显示机器／Agents／MCP 和会话入口；SET-05 按本任务可见条件处理。
2. 未登录也显示“0 computers / Disconnected / Tap to resync”；SET-05 不再向无工作区用户展示此连接行。
3. 离线缓存有 syncedAt，但当前连接文案只显示重新同步提示；SET-05 迁到工作区时保留缓存时间表达。
4. 首页具体选项与管理入口层级混杂；SET-02／03／04 各自完成二级页后，再由 SET-05 统一首页。
5. HomePreviewProviders 未同步 Settings 使用的连接单例，不能单独证明首页状态；本任务新增场景显式注入并在退出恢复。

这些差异属于旧基线记录，不阻止本任务完成；本任务没有把它们改成目标行为，也没有为其固化常量快照。
