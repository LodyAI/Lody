# SET-02 建立偏好设置页并迁移现有行为选项

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                            |
| -------- | ----------------------------------------------- |
| 阶段     | 第一阶段                                        |
| 优先级   | P0                                              |
| 状态     | 已完成                                          |
| 依赖     | [SET-01](./01-section-contract-and-baseline.md) |
| 当前授权 | 已授权执行 SET-02；本轮随 SET-05 接入首页       |

## 目标

让首页只保留“偏好设置”入口，把通知和会话行为集中到一个能继续扩展的原生分组页面。

## 当前依据

通知页已经支持推送权限状态和实时活动；队列／引导行为和快捷回复已经存在，但目前直接铺在首页。本机快捷回复不是工作区 Prompt Shortcuts。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/SettingsScreen.tsx`
- `apps/mobile/src/screens/NotificationSettingsScreen.tsx`
- `apps/mobile/src/screens/QuickRepliesScreen.tsx`
- `apps/mobile/src/features/settings/queued-message-behavior.tsx`
- `apps/mobile/src/features/settings/quick-replies.tsx`
- `apps/mobile/src/features/settings/quickReplies.ts`
- `apps/mobile/verification/ui/notifications.py`
- `apps/mobile/verification/ui/quick-replies.py`
- `apps/mobile/verification/ui/queued-message-behavior.py`

## 工作内容

- [x] 新增页面 apps/mobile/src/screens/PreferencesScreen.tsx，复用 definePage、现有页面运行时和 NativeGroupedList。
- [x] 页内分为“通知与实时活动”和“会话行为”；前者进入现有通知页，后者包含队列／引导选项和快捷回复入口。
- [x] 将原有处理器与订阅迁到实际拥有选项的页面，保持存储键、默认值、失败提示和卸载清理。
- [x] 补齐 en／zh-Hans 文案；未登录仍能访问本机偏好，通知保留现有权限和登录条件。
- [x] 先保证新页面独立可验收，再由 SET-05 接入首页并移除重复选项。

## 验收标准

- [x] 偏好页的两个分组、菜单当前值、文字和触控区域正确。
- [x] 队列／引导选项沿用原 provider，修改后返回与重启恢复正确。
- [x] 通知、快捷回复入口能打开原页面并返回，原有登录条件保留。
- [x] 进入和返回二级页面使用原生导航；交互返回取消时选择态正确。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。本项不改变发送、快捷回复编辑或通知服务逻辑，其完整业务流程不作为本次入口迁移的 UI 验收条件；只有静态分组搬迁不新增实现快照。

## 范围边界

不新增启动选项、团队默认值或通知类别；后续个人能力差异归 SET-19。

## 关联任务

[SET-05](./05-home-sections-and-connection.md) · [SET-06](./06-phase-one-acceptance.md) · [SET-13](./13-prompt-shortcuts.md) · [SET-19](./19-personal-settings-gap-review.md)

## 实施记录

- 开始日期：2026-10-16。
- 范围：新增原生分组偏好页，复用本机偏好和通知／快捷回复页面；已随本轮首页重排接入产品入口。
- 验证与证据：签名构建、check、bundle、27 个相关行为检查、31 个 runner 检查已通过；偏好页浅色已有冷启动持久化检查，本轮正式首页到偏好、通知、快捷回复的入口与返回在浅深色均通过。
- 2026-10-17 范围纠正：用户指出回归面过大，停止外围 UI 回归；本项只保留分组、入口、返回与本机偏好读写检查。
- 后续边界：SET-05 已将首页现有通知／聊天行换成单一偏好入口，首页重复行与处理器已移除。

## 实现与入口

- `PreferencesScreen`：页面 ID 为 `preferences`，默认原生 push，透明导航栏和 NativeGroupedList。
- “通知与实时活动／Notifications & Live Activities”分组保留 `notifications` 行，push 原 NotificationSettingsScreen；权限及账户条件仍由原页面拥有。
- “会话行为／Chat Behavior”保留 `queued-message-behavior` 原生菜单和 `quick-replies` 导航行；菜单只接受 queue／guide，并调用现有 provider。
- 新增 en／zh-Hans 三条页面文案。没有新增存储键、账户同步、通知分类或新的导航管理器。
- Debug 新增 `preferences-preview`；原 `queued-message-behavior-preview` 改为打开真实偏好页。独立预览使用 formSheet，子页仍为 native push，与后续 Settings sheet 中的消费方式一致。
- QuickRepliesPreviewScreen 的 Settings 按钮现在进入偏好页，再进入原快捷回复编辑页；冷启动检查仍使用真实 UserDefaults 和 composer／outbox。

## 验证范围

收窄后的完成条件，不新增 section 数组快照：

1. `queued-message-behavior`：未登录时操作本机偏好；queue／guide 菜单；原生通知页显示登录条件；取消／完成边缘返回；guide 写入本机后进程重启恢复，最后恢复 queue。
2. 快捷回复仅核对从偏好页打开原编辑器、原生返回后偏好值保留；不重跑聊天发送、失败重试及编辑器全部操作。
3. 浅色与深色审阅偏好页分组、文字、当前值和导航。已通过的相关 Node 行为检查沿用，不重复执行。

```sh
pnpm verify:simulator --name 'SET-02 Preferences' -- pnpm verify:build --json
pnpm verify:simulator --name 'SET-02 Preferences' -- pnpm verify:ui --app '<签名 Debug app 路径>' --case queued-message-behavior --require-video --fail-fast --output .artifacts/settings-set-02/preferences
```

证据保留在 `.artifacts/settings-set-02/`：`build.json`、构建日志、`check.log`、`bundle.log`、`behavior-tests.log`、`runner-tests.log`，以及 UI 的 `environment.json`、`results.json`、截图／AX 树和每个 case 的 `run.mp4`。只跑英文 en／en_US，浅色和深色。

## 超出本项的草稿与检查

以下工作是在扩大验收范围时产生的，仍留在未提交工作树中单独标记，不计入 SET-02 的交付或完成条件：

- `LodyGroupedList` 的受控开关回退修复：拥有者立即拒绝修改时，控件可能保留请求值。这是既有共享控件问题，与本项分组和入口迁移无关。
- 通知故障 fixture、开关手势 helper，以及 notifications、model-memory、quick-replies、share-probe 的外围验证调整。Share Extension 尚未运行；不继续为本项执行。
- 已运行的额外检查保留原始结果：通知浅色通过，model-memory 浅深色通过，create-parity 的 20 张目标状态差异比例为 0；快捷回复完整 UI 检查未通过，不据此声称整体回归通过。见 `.artifacts/settings-set-02/`。

## 当前限制

- 偏好页现已从普通首页的“个人 → 偏好设置”进入；本轮设置范围验收已通过。
- 通知页面实现、发送 provider 和快捷回复存储未改动，不存在数据迁移；共享原生开关修复另列为超范围草稿。
- 现有快捷回复页没有“恢复默认”操作；本任务只验证已有行为，Debug 重置按钮仅用于隔离测试数据。
- 离线服务只能证明本地交互与权限反馈，不能证明 APNs 投递或真实系统设置授权。

- 2026-10-17：首页已接入；本轮 `settings-baseline` 直接检查正式入口、通知／快捷回复子页及返回，不运行完整聊天业务检查。

- 完成日期：2026-10-17。`settings-baseline` 英文浅色／深色各覆盖六个状态及本次迁移入口，检查耗时分别为 257.65 秒／256.33 秒；截图与导航视频在 `.artifacts/settings-reorder/ui/`。
