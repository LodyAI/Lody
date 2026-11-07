# SET-17 补齐已发布分享管理

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                   |
| -------- | ------------------------------------------------------ |
| 阶段     | 第三阶段                                               |
| 优先级   | P2                                                     |
| 状态     | 已完成（首版）                                         |
| 依赖     | [SET-06](./06-phase-one-acceptance.md)                 |
| 当前授权 | 2026-10-18 已授权调查、实现、验收、独立 commit 与 push |

## 目标

在设置中管理已发布的静态会话副本，复用现有分享发布流程与凭据存储。

## 当前依据

已核实官方公开 DTO、客户端调用及静态阅读协议，复用现有发布对象、Keychain 与 native-owned runtime。服务端权限实现不在公开仓库，本轮不将源码合同当作真实 Cloud 权限验收。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/cloud/session-sharing.ts`
- [packages/cloud-runtime/src/models/session-sharing.ts](../../../../packages/cloud-runtime/src/models/session-sharing.ts)
- [packages/cloud-runtime/src/runtime/sharing/runtime.ts](../../../../packages/cloud-runtime/src/runtime/sharing/runtime.ts)
- [packages/cloud-runtime/src/runtime/sharing/README.md](../../../../packages/cloud-runtime/src/runtime/sharing/README.md)
- `apps/mobile/modules/lody-kit/ios/SessionShare/LodySessionShareView.swift`
- `apps/mobile/verification/ui/session-share.py`
- `apps/mobile/src/screens/SettingsScreen.tsx`

## 工作内容

- [x] 核实我的分享／工作区分享列表、分页、访问权限、过期、撤销及删除的公开协议。
- [x] 复用现有发布对象身份与 Keychain 读取边界；列表只展示允许公开的摘要。
- [x] 明确静态副本的生成时间及其与原会话的关系，提供支持的打开、复制、撤销等操作。
- [x] 管理员可见范围必须来自服务端；不通过本地发布历史推断工作区全部分享。

## 验收标准

- [x] 私有 reader credentials 不进入列表投影、URL 日志或诊断；退出和账号切换后不显示旧分享。
- [x] 撤销／删除若纳入，读回真实状态；失败保留可重试入口，不自动重复发布。
- [x] 管理流程复用静态副本，不把分享变成持续同步；离线 UI 验证不真实发布。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

这里的“分享”指发布副本管理，与 iOS Share Extension 收件箱、单条消息导出分开。

## 关联任务

[SET-18](./18-bug-reporting.md) · [SET-20](./20-roadmap-closeout.md)

## 实施记录

- 开始日期：2026-10-18。
- 协议／范围结论：列表、详情、原生打开／复制、确认撤销；不新增发布、重置、更新或删除接口。
- 验证与证据：[验收记录](https://app.lobehub.com/acceptance/77c60b8a-ca15-4fe2-aadd-38b5470b4ca9?r=1)：3/3 项，105 份证据完整上传；英文浅深色管理／权限 4/4 流程、现有分享表单 2/2 回归通过。
- 限制：不使用真实账户、链接密钥或公开内容；不执行真实 Cloud 撤销。iPad 与物理设备继续暂缓。

## 官方协议、权限与实际链路

2026-10-18 通过官方 GitHub main 与公开源代码核对，固定提交 a15cdae4301d541eacbafdc83f08d22a50f56777。Spec 仍为 draft，因此同时核对实际客户端请求和公开 DTO。

- [公开 DTO](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/cloud-api/src/session-sharing.ts) 和 [函数签名](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/cloud-api/src/index.ts)：sessionSharing:list 使用 workspaceId 和 paginationOpts（numItems、cursor），响应 page、isDone、continueCursor；本轮每页 20 项，校验游标前进与重复身份。列表仅 active／revoked，不含未完成 draft。getManagement 可同时传 shareId 与 rootSessionId，撤销使用 shareId 与 expectedRevision；没有删除或 TTL／到期字段，不推断到期或删除能力。
- [实际设置页面](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/components/settings/share-management-setting.tsx)：列表直接来自服务端，不以本机发布记录补齐，不通过本地角色枚举扩大可见性。普通成员看到自己的副本，管理员／owner 可查看工作区分享并撤销他人分享；每项 canManage／canRevoke 来自服务端。iOS 展示服务端返回的全部已发布／撤销记录，不额外隐藏已撤销项。
- [链接管理](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/hooks/use-session-share-management.ts) 与 [分享规范](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/specs/session-sharing.md)：管理员可撤销但不能获得他人的 reader secret 或接管发布。源会话删除不删除静态副本；发布者成员资格、账户或工作区失效会禁用访问。下载出去的内容无法收回，重置不会重新绑定成员资格。
- [静态读取客户端](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/shared/src/session-share-client.ts)：链接 fragment 为 access=v1 加 32 字节 secret，读取请求使用 Authorization header、omit credentials、no-store、error redirect、no-referrer；先解析固定 deployment，再校验对象校验和与输入界限。撤销使各 deployment 失去授权，不能靠删掉源会话或客户端列表行来模拟撤销。

客户端源码和公开协议能证明请求形式与消费路径；服务端授权、成员失效和真实部署失效仍需另行使用 app-authorized Cloud 环境验证，本轮不声称已完成这些在线操作。

## iOS 实现与边界

- 设置增加已发布分享入口，复用 NativeGroupedList 与现有 push／present。列表、分页、详情各自有加载、明确失败和刷新；分页失败保留原页。账号／工作区改变会隐藏旧列表、关闭旧详情并忽略迟到结果。
- 沿 dataRuntime command → share broker → SessionSharing.run(management) → 官方 Convex 查询／mutation。长期凭据和 JWT 留在原生；请求按固定方法与参数构造。服务端摘要先在 Swift 校验／挑选字段，再校验 RN wire shape；不返回 hash、secret、URL、正文或上传能力。
- 本机持链状态仅为当前发布者、active 状态和相应 credentialVersion 的 Keychain 项。打开／复制前重查管理状态、身份和版本，原生侧构造固定 share.lody.ai URL 并调用 UIKit；复制限制本机剪贴板，不在 RN 列表或错误文本中暴露 bearer。其他设备缺少密钥或管理员查看他人分享均有明确说明。
- 撤销有确认／取消；先在相同 workspace 按精确 shareId 重读 canRevoke 与 revision，再调用官方撤销并重新查询 revoked 状态。源会话不必仍在目录中。未知 mutation 或读回结果都返回不明状态，阻止重复提交并要求刷新；不会自动发布、重置、更新、删除或重放写入。
- 首版保留现有会话分享表单的发布／更新／重置能力；设置列表不新增这些操作。没有官方删除或到期 DTO 时不添加空操作，不用本地历史推断团队全集。服务端会员范围仍是最终授权边界。

## 最终验证与交付

- pnpm check、pnpm test（431 应用、31 UI runner、16 模拟器、12 构建、4 DOM WebView）、pnpm bundle、完整 cloud-runtime 类型检查、现有分享 runtime 8 项、原生分享边界检查和正常签名 Release 构建通过。
- 管理与权限各覆盖英文浅色／深色，44 张截图与 4 段视频逐张／首中尾帧审阅；原生记录证明字段投影、原生链接分发、权限／版本拒绝、成功撤销读回、丢失 ACK 与提交后读回拒绝均不自动重放。UI 复制反馈使用合成服务，原生回调未使用真实 reader secret。
- 原分享表单补齐真实 Switch 子控件定位与有界滚动，发布重试／更新／系统分享／重置取消／轮换／撤销的浅深色回归通过。验证脚本调整没有修改已验收应用包。
- 用户开工前的 10 个路径保持原有改动，仅提交 SET-17；真实 Cloud 授权、成员失效、deployment 撤销、真实 bearer URL 打开／剪贴板、iPad 与物理设备仍未验。
