# SET-19 补齐移动端适用的偏好与外观缺口

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                   |
| -------- | ------------------------------------------------------ |
| 阶段     | 第三阶段                                               |
| 优先级   | P2                                                     |
| 状态     | 已完成                                                 |
| 依赖     | [SET-06](./06-phase-one-acceptance.md)                 |
| 当前授权 | 2026-10-18 已授权盘点、最小实现、验收、独立提交并 push |

## 目标

在结构整理后，逐项评估截图提及的主题、语言、界面和会话文字设置，补有实际用途的移动端能力。

## 当前依据

已有本机外观、通知／实时活动、发送行为、快捷回复和 en／zh-Hans 文案。本轮确认全局主题保持跟随系统；语言遵循系统每 App 首选语言，启动 catalog 与原生 Bundle 使用同一选择。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/lib/i18n/index.ts`
- `apps/mobile/src/lib/i18n/boot.ts`
- `apps/mobile/src/lib/theme/appearance.tsx`
- `apps/mobile/src/screens/NotificationSettingsScreen.tsx`
- `apps/mobile/modules/lody-kit/ios/Chat/ChatMarkdownTheme.swift`
- `apps/mobile/locales/en.json`
- `apps/mobile/locales/zh-Hans.json`

## 工作内容

- [x] 按现有用户需求盘点主题跟随系统、语言、会话文字等差异，写清当前默认行为和实际需求。
- [x] 优先采用系统已有的每 App 语言／文字行为；仅在明确需要时新增 App 内设置与持久化。
- [x] 逐项记录本机范围或账户同步范围，不把“个人”标签误当成已存在的云端同步能力。
- [x] 每次只接入一项已有明确使用场景的能力；若改共享聊天渲染，覆盖聊天与相关预览。

## 验收标准

- [x] 修改后真实消费页面生效，重启恢复和取消行为正确；旧偏好不丢失。
- [x] 系统自动深浅色和辅助功能行为保持有效；UI Verify 仍只运行英文浅色／深色。
- [x] 语言若纳入，原生／RN 文案和导航标题切换行为一致，未支持的即时切换不伪装生效。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不新增桌面 Terminal 显示设置、不为大字号引入特殊 remount 方案、不一次铺满偏好选项。

## 关联任务

[SET-02](./02-preferences-page.md) · [SET-03](./03-appearance-page.md) · [SET-20](./20-roadmap-closeout.md)

## 实施记录

- 开始日期：2026-10-18。
- 协议／范围结论：用户确认主题只跟随系统、语言使用 iOS 的每 App 首选语言。本轮只补语言选择一致性和系统设置入口，不新增手动主题、语言存储或聊天字体选项。
- 验证与证据：check、test、bundle、正常签名 Release 构建通过；英文浅／深色 queued-message-behavior 通过，耗时 127.57 秒／118.58 秒，保留 14 张已审阅关键截图和 2 段视频。
- 验证边界：中文仅做 Bundle／catalog 的非 UI 检查；未验中文界面、真机、iPad 或真正跨语言切换。当前模拟器公开设置入口可能保留原页，已提供并验证完整系统路径。

## 现有行为盘点与本轮范围

| 能力                   | 实际生效链路与当前行为                                                                                                                                                     | 范围／决定                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 深浅色                 | app.config.ts 的 automatic → RN useColorScheme／UIKit traits → palette、原生语义色；无全局强制主题                                                                         | 系统拥有。按用户确认，保持跟随系统，不加手动开关                                                                                                                     |
| 深色背景、强调色、图标 | AppearanceProvider → LodyKit → UserDefaults 的 darkBackground／accentColor；自定义颜色广播给 RN 和原生；图标由 UIApplication 管理                                          | 本机偏好与系统图标，不同步账户。沿用现有实现                                                                                                                         |
| 语言                   | withLocales 生成 en／zh-Hans 原生资源，声明 CFBundleLocalizations 和英文开发语言；Swift 从 Bundle.main 读取；旧 RN 只读 expo-localization 的首个 Locale.preferredLanguages | 系统每 App 首选语言，iOS 重启应用后生效。修复 RN 与原生回退不一致；偏好页显示当前实际语言并通过 Linking.openSettings 打开 iOS 设置，指明 Apps → Lody → Language 路径 |
| 会话文字               | ChatMarkdownTheme、输入框及 Markdown 预览使用 UIFont.dynamic；正文随系统文本级别刷新。共享 dynamicScale 当前限制在 14/17 到 23/17；列表等系统控件使用各自 Dynamic Type     | 不新增独立字号、字体或大字号 remount；本轮不修改渲染和既有缩放上限，也不宣称覆盖全部辅助功能字号                                                                     |
| 发送行为、快捷回复     | Provider 启动从 LodyKit 读 UserDefaults，操作写回，再进入 composer／outbox；快捷回复只在无本地内容时从当前语言生成默认值                                                   | 本机持久化；更改系统语言不覆盖已保存的快捷回复内容。没有账户同步接口                                                                                                 |
| 通知、实时活动         | 通知权限由系统拥有；实时活动启用值在 App Group UserDefaults，受系统能力和登录身份约束                                                                                      | 沿用现有链路，不扩充类别或通知设置                                                                                                                                   |

### 官方依据和可复现缺口

- [Apple Bundle.preferredLocalizations](https://developer.apple.com/documentation/foundation/bundle/preferredlocalizations)：系统结合用户语言优先级与包内可用语言进行选择。
- [Apple Locale.preferredLanguages](https://developer.apple.com/documentation/foundation/locale/preferredlanguages)：原始偏好列表；应用最终语言由 Bundle 结合所支持语言决定。
- [Expo Localization](https://docs.expo.dev/guides/localization/)：iOS 的每 App 语言可在系统设置中选择，系统修改后重启应用，启动时选择文案即可。
- 本地 expo-localization 58.0.4 的 LocalizationModule.getLocales 返回 Locale.preferredLanguages，未筛选应用支持的语言。原 RN 对日语首选、简中次选直接回退英文；Foundation 实际为 `[ja-JP, zh-Hans-CN, en]` 选择 zh-Hans，因而会与原生文案混用。
- LodyKit 公开只读 initialLocale，取 Bundle.main.preferredLocalizations.first；入口在路由与静态标题加载之前设置 RN catalog。系统持久化语言，没有新增 UserDefaults／云端设置键，没有模拟即时切换。
- [React Native Linking.openSettings](https://reactnative.dev/docs/linking#opensettings) 使用系统公开入口，使用公开入口，实际落点由系统决定；不使用私有首选语言深链。当前模拟器会保留设置上次所在页面，因此页脚明确给出 Apps → Lody → Language 路径。打开失败显示反馈，返回不会改动现有偏好。

### 影响面

生产改动仅涉及 LodyKitModule 的只读属性、typed facade／导出、i18n 启动、PreferencesScreen 和两份文案目录。所有 definePage 静态标题及原生字符串共享系统启动选择。没有新增 Swift 文件、依赖、云端写入或数据迁移。

验证复用 queued-message-behavior 的真实偏好页和离线入口，增加当前语言、系统设置跳转和返回保留检查；启动语言边界另有回归检查。只运行英文浅／深色 UI，中文回退仅以 Foundation 与 catalog 的非 UI 行为验证。

### 系统设置实际链路

- [Apple WWDC19 官方说明](https://developer.apple.com/videos/play/wwdc2019/403/)明确推荐从 App 跳转系统设置，由系统持有语言选择并在修改后重启应用；自定义资源加载应读取 Bundle 的匹配结果。
- 本地 RN 的 RCTLinkingManager.openSettings 调用 UIApplicationOpenSettingsURLString。iOS 27.2 模拟器的设置入口保留此前页面位置，并非每次定位到 Lody；不将“打开成功”当作已到首选语言页。
- 实际沿 设置 → Apps → Lody 进入，已确认系统显示 Preferred Language → Language、English／简体中文两项，文案解释默认选第一个应用支持的系统语言。设备本身已有 en-SG、zh-Hans-SG、ja-SG 偏好，无需为产品加入第二套语言设置。
- 最终 UI 检查断言打开的是系统 Settings，必要时沿产品显示路径进入 Lody，打开系统语言列表并返回取消，再回 App 确认语言和旧发送偏好不变。英文浅／深色均覆盖，不切到中文界面。

## 最终验证与交付

- 2026-10-18 完成。未增加手动主题、App 内语言选择／存储、字体选项、依赖或云端写入；现有偏好没有迁移。
- `pnpm check`、`pnpm bundle`、`pnpm test`（433 个应用检查、31 个 UI runner、16 个 simulator、12 个 build、4 个 DOM WebView）全部通过。启动回退回归以及系统设置打开失败的处理都有实际行为检查。
- `pnpm verify:build --configuration Release` 使用共享 DerivedData 和正常签名，最终 native assets 已由 bundle 生成，最后一次构建复用它们。包内原生属性和 Hermes 标记、源文件与产物 SHA256 已记录在 `.artifacts/settings-set-19/source-probe.json`，最终 UI 使用该签名包。
- 浅深色均从实际 SettingsScreen 打开偏好页；读回当前语言的 VoiceOver 值与 44 pt 目标；修改旧偏好、通知页取消／完成返回、进程重启后读回；打开系统 Settings，沿页脚路径到达 Lody 的系统语言列表，取消选择并返回后仍保留语言与旧偏好。
- 证据与日志在 `.artifacts/settings-set-19/`。14 张用于验收的截图均逐一审阅；两段 1206×2622 视频已审阅首中尾，深色中段对应显式冷启动，补看邻近帧确认恢复；视频结尾按检查关闭偏好页回到 Debug。
- 保留开工前已有的 10 个用户改动路径，逐文件 SHA256 核对；只提交本项文件。没有新增工作树。

- 已发布验收：[https://app.lobehub.com/acceptance/9f549d8a-ff29-4bb4-8ee8-ef3c56e5d62e?r=1](https://app.lobehub.com/acceptance/9f549d8a-ff29-4bb4-8ee8-ef3c56e5d62e?r=1)，第 1 轮 2/2 项；14 张截图、2 段视频和解释／执行文字完整上传，未丢弃验收项。
