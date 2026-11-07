# SET-20 核对设置功能覆盖并整理交付记录

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                           |
| -------- | ---------------------------------------------- |
| 阶段     | 收口                                           |
| 优先级   | 按里程碑执行                                   |
| 状态     | 已完成（选定批次）                             |
| 依赖     | [SET-06](./06-phase-one-acceptance.md)         |
| 当前授权 | 2026-10-18 授权核对、验收、独立 commit 并 push |

## 目标

保持总计划与实际实现一致，明确每个官方入口是已支持、部分支持还是暂缓，并为选定批次提供可核查交付记录。

## 当前依据

本计划建立的是可逐项选择的路线图；第一阶段可以先完成，后续任务的真实能力依赖重新核实协议与权限。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/verification/ui/README.md`
- [docs/oss-alignment.md](../../../../docs/oss-alignment.md)
- [AGENTS.md](../../../../AGENTS.md)

## 工作内容

- [x] 按已选批次检查总计划覆盖矩阵与各任务验收记录；未实施的任务保持未完成，不由索引勾选代替行为证据。
- [x] 对已交付模块记录支持范围、协议来源、权限、验证命令／构建及截图视频路径。
- [x] 只在重新核实相关能力后更新旧对齐文档；不把过期的 docs/oss-alignment.md 状态当作当前事实。
- [x] 记录暂缓项、阻碍和恢复条件，保证首页不出现失效或虚假完成的入口。
- [x] 检查文档链接、工作树与索引，清理仅属本批次的临时文件；提交／PR／push 依用户后续要求执行。

## 验收标准

- [x] 每个 SET 任务只对应一个主文件，总计划与任务依赖双向可追溯。
- [x] 阶段一验收不等待全部后续模块；要声明“官方截图功能全部补齐”时，SET-07 至 SET-19 每项必须有完成证据或明确范围决策。
- [x] 部分支持与未知结果明确列出，未运行的检查不被写成通过。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不为完成文档打勾而扩大实现范围；本任务不默认授权发布、创建远程 issue 或独立 Codex chat。

## 关联任务

[SET-07](./07-workspace-general.md) · [SET-08](./08-machine-management.md) · [SET-09](./09-agent-management.md) · [SET-10](./10-mcp-management.md) · [SET-11](./11-agent-roles.md) · [SET-12](./12-memory-management.md) · [SET-13](./13-prompt-shortcuts.md) · [SET-14](./14-project-visibility-management.md) · [SET-15](./15-github-integration-settings.md) · [SET-16](./16-ai-usage.md) · [SET-17](./17-published-shares-management.md) · [SET-18](./18-bug-reporting.md) · [SET-19](./19-personal-settings-gap-review.md)

## 核对基线与结论

- 日期：2026-10-18；本仓基线 `7f669aec86148492e0abc54c4564d32ff3d7ecc5`。本次整理文档与复核证据，不修改生产功能、权限、存储或生成的 iOS 工程。
- [总计划覆盖矩阵](../2026-10-16-settings-reorganization.md#官方入口覆盖与缺口)逐项列出 16 类官方入口。已交付的是选定首版范围，不能宣称官方截图的全部操作均已补齐。
- 当前 Settings 工作区包含通用、机器、Agents、角色、MCP、记忆、Prompt Shortcuts、项目、GitHub、AI 用量、已发布分享。逐行对照 `SettingsScreen` 的 section、scope 条件和事件处理，均有生产目标；无工作区不显示无效操作，报告 Bug 无占位行。
- 第一阶段 iPhone 交付不等待后续模块；SET-06 的 iPad 检查仍暂缓。本次授权只收口已选批次，不把该暂缓改成全设备验收通过。

## 协议、权限与生效边界

下表记录本轮源码核对入口；公开协议版本沿各任务当时的调查，不冒充本轮重新调查了最新服务端实现。`main` 链接是原调查线索，缺固定版本的地方明确保留；没有把另一个 checkout 作为 App 依赖。

| 能力／任务                   | 本仓实际入口与消费                                                                               | 协议来源与权限                                                                                                                                  | 本次确认的范围限制                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 账户、关于、诊断／SET-04、05 | AccountScreen、AboutScreen、DiagnosticsScreen；原生 Keychain、许可和导出服务                     | 既有 AuthProvider／系统 API；退出登录有确认                                                                                                     | 账户资料只读；诊断由用户选择导出，不代表 Bug 已提交                                               |
| 偏好、外观／SET-02、03、19   | PreferencesScreen → LodyKit UserDefaults／App Group、composer；AppearanceScreen → 原生外观与图标 | Bundle 选择 en／zh-Hans；语言由系统拥有；[SET-19 官方依据](./19-personal-settings-gap-review.md#官方依据和可复现缺口)                           | 主题跟随系统；无手动主题／字号、账户偏好同步或即时语言切换                                        |
| 工作区通用／SET-07           | WorkspaceEditorScreen → AuthProvider → auth/api.ts                                               | organization/update、头像上传；显式 organizationId，服务端最终授权                                                                              | 名称／图标；无成员／生命周期操作，不推测本地管理员身份                                            |
| 机器、Agents／SET-08、09     | RemoteSettingsScreen／Editor → runtime/settings.ts；presence 与 agentUsage 投影                  | 工作区 metadata／机器 Flock、既有 Streams grant；机器所有权只读边界；[SET-09 官方字段核对](./09-agent-management.md#实施记录)                   | 机器改名、Agent name／prompt；保留未知字段及 env；额度是供应商窗口，不是工作区账单                |
| MCP／SET-10                  | runtime/settings.ts → runtime/mcp.ts → session.ts → history／mq／dispatch                        | 官方 `7246f7836d7c458818e4abaa9bd2f60096d4e7d0` 的 workspace-mcp／workspace-flock；Streams 写授权                                               | 首次默认值、既有选择和删除过滤已接通；连接秘密不进 RN；客户端乐观检查不是服务端 CAS               |
| 角色／SET-11                 | runtime/role-settings.ts → agent-roles／mention-expansion → session dispatch                     | 官方 `a15cdae4301d541eacbafdc83f08d22a50f56777` 的 agent-role v1／v2；可见角色按用户过滤，所有者编辑，Streams 最终授权                          | private 不提供工作区存储机密性；引用请求 Agent 通过 Lody MCP 创建，未证明远程会话已创建           |
| 记忆／SET-12                 | runtime/memory-settings.ts → machine/memory → machine Flock 关联                                 | 同上 `a15cdae` 的 memory-provider／machine-flock；只限自有机器、online、memoryProviders v1、Streams grant                                       | 只读身份并导入／解除关联；不读取正文；导入不启用角色绑定，不证明插件检索可用                      |
| Prompt Shortcuts／SET-13     | PromptShortcutsScreen → runtime/prompt-shortcuts.ts → 提及／发送展开                             | 本仓 protocol/prompt-shortcuts 标注官方 `e73d3109b26412186d67571992a3ba1363433645`；Cloud 目录与每资源 grant、Flock 索引／Loro 正文；所有者编辑 | 纯文本首版；复杂上下文只读且不消费，未知发布仅允许同原稿手动恢复；不复用工作区 grant 偷读私有正文 |
| 项目／SET-14                 | ProjectVisibilityScreen → WorkspaceSettingsCloud.swift                                           | CloudApi `localProjects:listVisibleLocalProjects`／`setLocalProjectSharedWithTeam`；Keychain 当前身份、原生写前查 owner、写后读回               | 注册缺失为未知；不删机器目录或会话。原任务 CloudApi 为 main 链接，未记录固定 SHA                  |
| GitHub／SET-15               | GitHubSettingsScreen → WorkspaceSettingsCloud.swift → GitHubCloud                                | CloudApi github 操作；组织内 admin／owner 管仓库，个人身份单独校验；JWT 留原生                                                                  | 网页安装 `returnTarget: web` 后回 App 刷新；无 iOS OAuth 回调。原 CloudApi 调查未记录固定 SHA     |
| AI 用量／SET-16              | AIUsageScreen → WorkspaceUsage.swift                                                             | CloudApi usage summary／timeline；服务端工作区授权，原生剔除成员明细                                                                            | UTC 服务端范围、Token／预估 USD；未知不作 0；无账单核对。原 CloudApi 调查未记录固定 SHA           |
| 已发布分享／SET-17           | PublishedSharesScreen → runtime share broker → SessionSharing.swift                              | 官方 `a15cdae` 的 session-sharing DTO 与实际客户端；服务端 canManage／canRevoke、expectedRevision；本机 Keychain 链接版本校验                   | 管理员无他人 reader secret；设置不新增发布／重置；未知撤销不重放。spec 为 draft，不等于部署保证   |

完整路径集中在 [runtime](../../../../packages/cloud-runtime/src/runtime)、`Cloud 原生实现`和`设置业务投影`。长期凭据留在 Keychain，RN 不新增 live replica；各模块具体未知结果恢复规则以任务记录为准。

## 交付与证据索引

下列是历史交付证据，不等同于本轮重新运行这些模块。2026-10-18 通过 `lh acceptance view <id> --json` 重新读取已发布的七组验收状态和必需证据类型；只核验记录完整性，没有重新审阅全部历史视频。SET-01 至 SET-08 的早期目录现已不在本 checkout，仍保留原路径作为历史定位，不把缺失原件写成当前可复查。

| 任务                                 | 已提交实现                                 | 验收／命令／构建与媒体出处                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SET-01                               | 契约与旧布局基线，见任务主文件             | 历史 `.artifacts/settings-set-01/`：check、bundle、签名 build、settings-baseline 英文浅深色六状态；原件当前缺失，不能重审旧布局                                                                                                                                      |
| SET-02 至 SET-05；SET-06 iPhone 部分 | `4cc3bd1`                                  | 历史 `.artifacts/settings-reorder/ui/`，settings-baseline；check、bundle，复用签名 Debug；入口返回与偏好持久化。iPad 未运行，早期媒体当前缺失                                                                                                                        |
| SET-07                               | `70e1764`                                  | 历史 `.artifacts/settings-set-07/ui/`：workspace-general 浅深色、9 项 cloud 行为，check／bundle；复用签名 Debug，早期媒体当前缺失                                                                                                                                    |
| SET-08                               | `9e7ceb2`                                  | 历史 `.artifacts/settings-set-08/ui-r3/`：machine-settings 浅深色及 13 项行为；原件当前缺失。五类背景矩阵本次另补，见下节                                                                                                                                            |
| SET-09                               | `4562296`                                  | [验收 3/3](https://app.lobehub.com/acceptance/d4d61a8c-4dbc-4282-acd1-8264d793b02e?r=1)；agents-settings 英文浅深色、19 项行为、check／bundle、签名构建；历史 `.artifacts/settings-set-09/ui-fixed/`，原件当前缺失，上传截图／视频仍在验收记录                       |
| SET-10                               | `4215474`                                  | [验收 2/2](https://app.lobehub.com/acceptance/5eccf834-f0a1-40f2-8265-f01da5fa0df9?r=1)；mcp-settings 浅深色、55 项行为、bundle、签名 Release；check 当时只受其他文档格式阻塞。历史 `.artifacts/settings-set-10/` 原件当前缺失；背景矩阵不是这两项公开验收的独立条目 |
| SET-11                               | `c759b57`                                  | [验收 3/3](https://app.lobehub.com/acceptance/772f0d2a-3989-4cd4-b6fd-6bd8c1baed74?r=1)；agent-roles、role-mention-chat／sheet 英文浅深色 6/6、52 项行为、check／bundle、签名 Release；`.artifacts/settings-set-11/`                                                 |
| SET-12                               | `f6c3bed`                                  | [验收 3/3](https://app.lobehub.com/acceptance/cbe06440-b213-48f0-b311-2d7e64c59055?r=1)；memory-settings／states 浅深色 4/4、29 项行为、check／runtime 类型／bundle、签名 Release；`.artifacts/settings-set-12/`                                                     |
| SET-13 至 SET-16                     | `f5e40a2`、`53656d0`、`a9a06c3`、`de0baa8` | [验收 4/4](https://app.lobehub.com/acceptance/49fe2ad2-5420-4cb5-a9a1-abb2e3f8203c?r=1)；settings-workspace 英文浅深色 8/8，8 项行为，bundle 与签名 Release；check 当时受其他文档格式阻塞。历史 `.artifacts/settings-workspace/ui/` 当前缺失，公开截图／视频仍在     |
| SET-17                               | `2f64548`                                  | [验收 3/3](https://app.lobehub.com/acceptance/77c60b8a-ca15-4fe2-aadd-38b5470b4ca9?r=1)；published-shares／states 浅深色 4/4，session-share 2/2 回归，check／test／bundle、签名 Release；`.artifacts/settings-set-17/`                                               |
| SET-18                               | 无实现提交                                 | 用户跳过，未运行验收；诊断导出不代替该任务                                                                                                                                                                                                                           |
| SET-19                               | `7f669ae`                                  | [验收 2/2](https://app.lobehub.com/acceptance/9f549d8a-ff29-4bb4-8ee8-ef3c56e5d62e?r=1)；queued-message-behavior 浅深色 2/2、启动语言边界、check／test／bundle、签名 Release；`.artifacts/settings-set-19/`                                                          |

每个任务主文件保留完整历史命令和未跑项；本轮的精简复核记录是 `.artifacts/settings-set-20/prior-coverage.json`。所有上述产品 UI 均是离线 Debug fixture／注入边界；没有用当前 Cloud 写入替代验收。

## 遗留项与恢复条件

| 项目                                   | 当前结论                                                    | 恢复条件／下一步                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| SET-06 iPad                            | 用户暂缓，未通过                                            | 用户重新选择后只补当前 Settings 宿主分组、滚动、二级返回；不以旧 ipad 实验替代                                         |
| SET-08 背景矩阵                        | SET-10 有历史通过记录，旧原件不在；本次定向补验通过         | 本次复用哈希相符的 SET-19 签名包补齐英文浅深色截图／录像；旧 SDK 阻塞关闭，不再列为待办                                |
| SET-18 报告 Bug                        | 用户跳过，未实施                                            | 用户重新选择并确认真实渠道，再做用户可编辑草稿／日志选择／取消；不自动发 issue                                         |
| 早期证据归档                           | SET-01 至 SET-08 的本地目录缺失                             | 需要重审早期布局／工作区行为时恢复原归档或重新采集；不声称历史原件现可读                                               |
| 真实云端端到端                         | 各首版均未做线上写入验收                                    | 使用 App 自己的 Device Flow 登录、受控数据与明确授权，再验服务端 ACL、读回／撤权、跨成员效果；不借桌面凭据、不自动重放 |
| MCP／Agent／角色完整配置               | 部分支持，电脑端保留                                        | 原生秘密输入边界、正式远程 capability 与相应宿主验收就绪后再选任务；不把已有协议等同于移动编辑器已完成                 |
| 团队记忆、provider 编辑、角色记忆绑定  | 自有机器关联之外未接入                                      | 先接机器可见性授权与 daemon capability，再做身份编辑／绑定；用真实 nmem／插件证明检索，导入本身不算生效                |
| 复杂 Prompt Shortcuts                  | 只读／不消费，删除等未接入                                  | 先完整保留结构化上下文与版本语义，再验展开和撤权；与本机快捷回复独立                                                   |
| 工作区生命周期、完整机器管理、个人资料 | 未纳入已交付范围                                            | 先核实公开接口、权限与破坏性操作边界，再单独选择；首页不增空操作                                                       |
| GitHub／用量／分享在线效果             | 客户端路径已接，服务端效果未验                              | 分别验真实安装／个人授权／撤权、账单口径、分享部署撤销与成员失效；不把预估当账单或 UI 提示当真实 bearer 链接验证       |
| 语言／辅助功能／物理设备               | 系统语言入口已验；未做真正跨语言 UI、全部辅助字号或真机验收 | 需要时单独覆盖；现有主题跟随系统、语言使用系统首选语言的决定保持不变                                                   |

## 本轮实施记录

- 已核对 20 个主文件、实际首页和相关消费路径；总计划将原先笼统“待核实”替换为已确认协议、已实现范围与未接入操作。
- 旧 [OSS 对齐文档](../../../oss-alignment.md)只刷新本次实际复核的 MCP、角色设置与发送偏好，不更改其他九月条目或远程 issue 状态。其余旧状态仍不是当前事实。
- 复用 SET-19 的正常签名 Release 包；`Lody`、`main.jsbundle`、`Info.plist` SHA256 与上轮 provenance 相同，工作区没有本轮产品代码变化，`codesign --verify --deep --strict` 通过。不为纯文档改动重复构建整个 App。
- `pnpm check` 通过；文档检查覆盖 20 个唯一主文件、依赖双向一致／无环、395 个本地链接与用户原有修改哈希。上述检查为支持门禁，交付判断来自逐项阅读覆盖、权限、证据和恢复条件。
- 五类表单的 `settings-form-backgrounds` 英文浅深色分别 140.47 秒／119.62 秒通过；24 张关键截图逐张审阅、两段 1206×2622 原始视频抽检首／中／尾。取消后返回场景列表，未保存或执行网络操作；背景范围已在 SET-08 关闭。
- 本次未改生产代码，没有重跑全套 test／bundle 或新建原生构建；复用包的签名、来源哈希和当前场景／表单源码另行复核。没有运行 iPad、真实 Cloud、物理设备、中文 UI 或真正跨语言切换。
- 本轮资料在 `.artifacts/settings-set-20/`：`initial.json`、`source-probe.json`、`prior-coverage.json`、`document-audit.json`、`check.log`、`ui-command.log`、`ui/`、`frames/`；验收材料在 `.acceptances/standalone-set20-settings-closeout/` 的独立轮次，本轮已发布链接如下。
- 开工前的 10 个用户改动路径记录哈希并保留；仅本任务文档进入单独提交，不创建工作树、远程 issue 或新 chat。

- [SET-20 验收](https://app.lobehub.com/acceptance/29a93192-3c71-4b20-bf7b-b516f4f5710e?r=1)：第 1 轮 3/3 项通过，61 份证据完整上传；其中 24 张截图、2 段视频及文档审阅的解释／执行文本，所有必需类型齐全，无丢弃、缺失、未执行或未计划条目。远端记录已重新读取确认。
