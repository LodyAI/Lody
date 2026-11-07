# SET-15 补齐 GitHub 连接与仓库管理设置

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                   |
| -------- | -------------------------------------- |
| 阶段     | 第三阶段                               |
| 优先级   | P2                                     |
| 状态     | 已完成（首版）                         |
| 依赖     | [SET-06](./06-phase-one-acceptance.md) |
| 当前授权 | 已授权按 09 → 13 → 14 → 15 → 16 推进   |

## 目标

增加 GitHub 集成的状态与仓库管理入口，复用已有云端认证边界。

## 当前依据

已有 GitHub PR 读取和评论调用；它证明会话中的 PR 能力存在，不能证明 App 已有 GitHub App 安装、授权或仓库管理页面。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/cloud/github/pullRequests.ts`
- `apps/mobile/src/screens/PullRequestScreen.tsx`
- `apps/mobile/src/screens/SettingsScreen.tsx`
- [packages/cloud-runtime/src/models/pull-request.ts](../../../../packages/cloud-runtime/src/models/pull-request.ts)

## 工作内容

- [x] 查明 GitHub 连接由个人还是工作区拥有，核实 GitHub App／OAuth 安装、回调、仓库列表及管理权限。
- [x] 首版显示真实连接状态、可访问仓库与权限说明；授权／重授权／移除仅按公开支持能力接入。
- [x] 回调使用现有路由和认证流程，失败或取消返回设置；不把凭据带入 URL 或诊断。
- [x] 核对连接变化后 PR 等消费者的缓存失效与错误反馈。

## 验收标准

- [x] 取消授权、过期授权、无仓库权限和账号切换均不会显示为已连接。
- [x] 仓库访问范围来自真实授权；移除或权限撤销后消费侧停止访问。
- [x] 测试 fixture 不调用真实 GitHub 授权或发评论，必要线上验证单独记录范围。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不要求用户在 RN 中粘贴长期 Token，不用现有 PR 成功作为仓库管理完成证据。

## 关联任务

[SET-14](./14-project-visibility-management.md) · [SET-20](./20-roadmap-closeout.md)

## 2026-10-17 协议预查

已在[官方公开客户端契约](https://github.com/LodyAI/Lody/blob/main/packages/cloud-api/src/index.ts)找到工作区仓库状态查询、仓库启用设置和 GitHub App 安装 state；个人操作授权另有 `missing`／`authorized`／`expired` 状态与偏好设置。App 仓库范围与个人身份必须分别显示。

现有 LodyKit 的 GitHubCloud 已有 Keychain → 官方 JWT → Convex 调用边界，可复用认证过程，不向 RN 投影凭据。安装返回目标目前公开为 web／desktop，iOS 回跳尚未确认；未确认前不伪造已授权或添加不工作的回调。本轮已按此边界接入状态、仓库列表、操作和返回刷新。尚未调用真实授权或改动仓库权限。

## 实施记录

- 开始日期：2026-10-17。
- 独立展示个人身份 missing／expired／authorized 与个人操作偏好；工作区 GitHub App 仓库列表、启停状态与权限说明分别呈现，部分查询失败不冒充已连接。
- 管理权限来自按工作区限定的 Better Auth 组织成员角色；角色未确认时停用管理。原生写前再次校验当前角色和仓库，修改后读回；无效或过期个人身份不能开启个人操作。
- GitHub App 管理使用官方 installation state 和 `returnTarget: web`。在浏览器完成后回 App 重新读取；未实现或声称 iOS OAuth 回调。个人身份授权／续期仍在官方网页完成。
- 现有仓库、分支、提及和 PR broker 每次读取当前认证；请求禁用 URL 缓存，设置变更触发目录刷新。Token 只留在原生，RN 只收到字段白名单投影。
- 协议参考：[官方 CloudApi](https://github.com/LodyAI/Lody/blob/main/packages/cloud-api/src/index.ts)、[Better Auth 组织接口](https://better-auth.com/docs/plugins/organization)。
- 验证：原生和页面行为检查覆盖成员／管理员、过期身份、读回与安装 URL 参数边界。iPhone 英文浅色／深色交互验收通过，fixture 不发真实授权或评论。
- 未跑项：真实 GitHub 安装、个人网页授权及真实撤权；iPad。

- 验收证据通过上方总计划关联，对应本任务的英文浅色／深色截图与录像。
