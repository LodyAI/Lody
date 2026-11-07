# SET-08 完善机器设置的展示与管理边界

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                           |
| -------- | ---------------------------------------------- |
| 阶段     | 第二阶段                                       |
| 优先级   | P1                                             |
| 状态     | 已完成（展示／改名；背景矩阵已补验）           |
| 依赖     | [SET-05](./05-home-sections-and-connection.md) |
| 当前授权 | 用户授权继续；iPad 按既定决策暂缓              |

## 目标

让机器页清楚表达机器身份、状态及可管理范围，并补齐实际协议支持的高价值操作。

## 当前依据

远程设置已列机器并允许有权限者改名，运行时测试覆盖 owner 校验。本轮补机器身份、在线状态与缓存语义；继续复用现有编辑页和写入协议。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/RemoteSettingsScreen.tsx`
- `apps/mobile/src/screens/RemoteSettingEditorScreen.tsx`
- `apps/mobile/src/ui/Screen.tsx`
- `apps/mobile/src/screens/WorkspaceEditorScreen.tsx`
- `apps/mobile/src/screens/QuickReplyEditorScreen.tsx`
- `apps/mobile/src/features/settings/remote-settings.ts`
- [packages/cloud-runtime/src/runtime/settings.ts](../../../../packages/cloud-runtime/src/runtime/settings.ts)
- [packages/cloud-runtime/src/models/settings.ts](../../../../packages/cloud-runtime/src/models/settings.ts)
- [packages/cloud-runtime/src/runtime/machine-presence.ts](../../../../packages/cloud-runtime/src/runtime/machine-presence.ts)
- `apps/mobile/src/cloud/catalog/machines.ts`
- `apps/mobile/tests/native/settings.test.mjs`
- `apps/mobile/tests/settings/remote-settings.test.mjs`
- `apps/mobile/src/screens/debug/MachineSettingsPreviewScreen.tsx`
- `apps/mobile/verification/ui/machine-settings.py`
- `apps/mobile/verification/ui/settings-form-backgrounds.py`

## 工作内容

- [x] 目录来自工作区 meta 的 `e/machine-*`，名称和 OS 来自 `m/machine-*`；在线状态来自既有 90 秒 TTL presence。机器总数不参与在线判断。
- [x] 同名机器显示完整 ID、OS 和状态；所有者可改名，其他机器显示只读说明；离线或读取失败保留快照、更新时间并明确状态不可确认。
- [x] 本仓公开适配器目前仅确认名称编辑。移除／断开／重新授权未确认正式接口及版本条件，本轮暂缓，不能据此声称服务端不支持。
- [x] 读写继续沿原 data runtime，以当前认证用户和 meta 中 `ownerUserId` 校验所有权；保留 fresh bootstrap 冲突检测、未知结果提示和不自动重放。
- [x] 用户指出键盘展开后输入卡片与 Sheet 底色同为白色，并要求排查其他设置子页：三个编辑页宿主显式使用分组背景，Screen 仅增加标准 style 传递，其他调用方默认不变。

## 验收标准

- [x] 同名机器可辨认；离线缓存带清楚状态，失败不被标记为 live。
- [x] 非所有者写入被既有运行时拒绝；机器页 UI 覆盖冲突保留草稿、取消重开和保存读回。共享写入行为检查覆盖不确定结果不自动重放。
- [x] 机器行打开既有临时编辑表单，取消／保存后可重开；本轮未修改原生选择态，不另跑交互 pop。没有新增管理动作。
- [x] 五类编辑表单在键盘前后、浅深色均能区分输入卡片与页面背景。2026-10-18 SET-20 使用匹配源码的签名 Release 包补验通过，旧 SDK 阻塞不再是当前待办，详见文末。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不远程运行系统命令，不新增机器心跳保活，不承诺尚未确认的机器管理 API。

## 关联任务

[SET-09](./09-agent-management.md) · [SET-14](./14-project-visibility-management.md) · [SET-20](./20-roadmap-closeout.md)

## 实施记录

- 开始日期：2026-10-17。
- 协议／范围结论：展示和改名沿已有模型、presence 订阅及原编辑表单，没有新增 live replica、wire 字段或原生代码。原编辑页补充分组背景；扩展管理操作暂缓，待确认正式 API、权限和版本条件后另行接入。
- 验证与证据：pnpm check、pnpm bundle、13 项设置展示及运行时行为检查已通过；独立机器页英文浅深色 UI 检查通过，分别 106.83／82.28 秒，截图和视频已审阅，证据目录 `.artifacts/settings-set-08/ui-r3/`。
- 2026-10-17 当时未解决：跨表单视觉矩阵未完成；SDK 升级的原生构建尚未稳定。该阻塞已在下方 SET-20 记录关闭。未真实连接云端或修改机器，iPad 暂缓。既有九份本地草稿已逐一校验保留，SDK 升级的源码和依赖变更另行保留；本批次仅交付本任务的设置改动。

## 用户追加：设置子页的背景层级排查

2026-10-17 用户要求一起排查设置子项。沿 Settings → 二级页 → 表单的实际调用链核对，保留系统语义色和原生滚动边缘，不改变全局 sheet 的透明策略。

| 页面                                                                                     | 结论与本轮处理                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 机器／Agent／MCP 编辑                                                                    | 同一 RemoteSettingEditorScreen 使用 FormGroup，但 Screen 原本透明；补充分组页底色，卡片保持原色。                   |
| 工作区通用                                                                               | WorkspaceEditorScreen 同源问题，补充分组页底色；关联 [SET-07](./07-workspace-general.md)。                          |
| 快捷回复编辑                                                                             | QuickReplyEditorScreen 同源问题，补充分组页底色；关联 [SET-02](./02-preferences-page.md)。                          |
| 账户、偏好、外观、通知、快捷回复列表、远程设置列表、关于、开源许可、诊断、项目历史及归档 | 源码均由 NativeGroupedList 自己管理页面和分组行背景，未发现同样的透明表单宿主；不改动这些列表，不重跑各自业务流程。 |
| App 图标                                                                                 | 原生 LodyAppIconGrid 自己设置 grouped 背景，不涉及表单输入卡片。                                                    |
| 许可正文                                                                                 | 纯文本阅读页，没有输入卡片，不套用分组表单修复。                                                                    |

独立 `settings-form-backgrounds` 场景已接入，只打开上述五类真实编辑表单，检查字段卡片在键盘前后的浅深色区分后取消，不保存、不选图标、不发网络请求。修复前的浅色键盘展开截图中，卡片和页面均为 `(255,255,255)`，既有像素检查可复现失败；修复后机器表单为白色卡片／`(242,242,247)` 页面，差值 13，深色差值 41。其余表单只完成源码排查与修复，尚未通过运行验收。

### 验证环境记录

- 本机默认 iOS 27.0 runtime 虽在 inventory 中，但创建时报告 runtime path not found；本轮通过 `LODY_VERIFY_RUNTIME` 选择已安装的 iOS 27.2，仍沿托管 Simulator 和共享 DerivedData。
- 机器页完整英文浅深色检查已通过，含键盘展开前后卡片区分：`.artifacts/settings-set-08/ui-r3/`。
- 五类表单检查期间，工作区并行发生 Expo 58／RN 0.88 升级。旧 Debug app 在 Worklets 原生接口处报错；已运行普通 prebuild、pods 并尝试保留签名重建。重建与另一流程的 prebuild／pods 重叠，依赖头文件被替换而失败；不修改、回滚或混入该升级的源码。
- SDK 升级后的 pnpm check 已再次通过。后续表单矩阵待匹配的新原生 App 完成后继续；当前不能将尚未跑完的矩阵记为通过。
- 第二次构建仍与另一流程的 pods／codegen 更新重叠，`RNCSafeAreaProviderComponentView.mm` 缺少 `react/renderer/components/safeareacontext/ComponentDescriptors.h`。本轮停止抢跑重建，不修补 SDK 升级代码或回退其依赖；构建日志分别是 `.artifacts/settings-set-08/build-after-upgrade.log` 和 `build-after-upgrade-r2.log`。

### 2026-10-18 SET-20 补验收口

- SET-10 已记录五类矩阵通过，但其本地原件现不在 checkout；本轮重新运行 `settings-form-backgrounds`，替换本项过时的“待 SDK 构建”状态，保留以上历史故障记录。
- 复用 SET-19 正常签名的 Release 包，核对可执行文件、Hermes bundle、Info.plist 与其来源哈希一致，签名复验通过；本轮没有生产代码改动。仍使用共享 DerivedData、托管 Simulator 租赁和 iOS 27.2 runtime。
- 英文浅色／深色分别 140.47 秒／119.62 秒通过，检查部分为 122.95 秒／111.92 秒。机器、Agent、MCP、工作区、快捷回复均打开真实编辑页，检查键盘前后并取消返回，没有保存或调用云端。
- `.artifacts/settings-set-20/ui/{light,dark}/settings-form-backgrounds/` 保存原始 PNG／AX JSON、check.log 与 run.mp4；24 张关键截图逐张审阅，两段 1206×2622 视频抽检首／中／尾。录像结尾回到五类表单选择场景，表示全部取消完成。
- 浅色卡片／页面色差为 8–13，深色为 40–41；视觉审阅确认仍可区分，不把像素阈值本身当成视觉结论。此项只关闭背景矩阵，不补做真实云端、iPad、物理设备或全业务回归。发布入口见 [SET-20](./20-roadmap-closeout.md)。
