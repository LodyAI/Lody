# SET-12 补齐记忆管理入口

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 阶段     | 第三阶段                                                 |
| 优先级   | P2                                                       |
| 状态     | 已完成（首版）                                           |
| 依赖     | [SET-06](./06-phase-one-acceptance.md)                   |
| 当前授权 | 2026-10-18 用户授权调查、实现、验收后单独 commit 并 push |

## 目标

按官方实际记忆模型展示可访问记忆及来源设备，再按协议支持范围增加管理操作。

## 当前依据

已核实官方机器级记忆身份与关联协议，并沿现有 native-owned runtime 接入。这里管理电脑提供方的身份关联；Swift／runtime 的缓存或模型选择偏好不是同一功能。

实现复用设置入口、现有 Flock／Streams 读写和原生凭据边界，公开协议与实际生效链路见下文。

- `apps/mobile/src/screens/SettingsScreen.tsx`
- [packages/cloud-runtime/src/models/settings.ts](../../../../packages/cloud-runtime/src/models/settings.ts)
- [packages/cloud-runtime/src/runtime/settings.ts](../../../../packages/cloud-runtime/src/runtime/settings.ts)
- `apps/mobile/src/cloud/settings.ts`

## 工作内容

- [x] 查明公开 schema／接口、导入来源、机器归属、所有权、分页以及内容敏感性；将证据写回本任务。
- [x] 确定首版最小范围：列表、来源与状态、详情；只有确认写接口后才纳入修改／删除／导入。
- [x] 通过现有 runtime 与原生凭据边界接入；按账户／工作区／机器隔离缓存。
- [x] 在无数据、离线缓存、无权限、来源设备失联时显示明确状态。

## 验收标准

- [x] 同名记忆可按稳定 ID 和来源设备区分；账户切换不显示上一用户内容。
- [x] 详情只展示有权限内容；读取失败不伪装成空列表。
- [x] 若纳入删除／导入，检查确认、取消、失败与重复提交边界。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

首版覆盖本人的电脑身份关联；不读取或删除提供方正文，不导入手机外部私有记忆文件。团队电脑授权、provider 创建／编辑和角色绑定编辑保留后续范围。

## 关联任务

[SET-11](./11-agent-roles.md) · [SET-20](./20-roadmap-closeout.md)

## 官方协议与权限

2026-10-18 通过 GitHub API 与官方源码核对 `LodyAI/Lody` main 的 `a15cdae4301d541eacbafdc83f08d22a50f56777`。Spec 标记 draft，因此同时核对实际实现，没有将文档里的能力视作已部署保证。

- [memory-provider.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/shared/src/memory-provider.ts)：身份只有 ID、名称、说明和角色资料；请求支持 `list/create/update`，没有读取正文或删除 provider 数据的接口。v1 提供方为 `nowledge-mem`。响应分 ready／not_installed／not_running／error，列表没有分页；iOS 对响应字段、数量和长度设界限，目录输入仍使用既有 8 MiB 上限及分页游标保护。
- [machine-flock.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/shared/src/machine-flock.ts) 与 [memory-association-write.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/lib/memory-association-write.ts)：关联位于 `<workspace>:mf:<machine>` 的 `['memory', providerId, memoryId]`，值包含 machineId、providerId、memoryId、name 和可选 description；导入按稳定键幂等，保留已有自定义资料。解除关联仅删除此行，不改角色或已接受轮次，不删除提供方数据。
- [use-visible-machine-metas.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/hooks/use-visible-machine-metas.ts) 与 [visible-machine-index.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/lib/visible-machine-index.ts)：官方团队机器可见性来自 Cloud `machines.listVisibleMachines`，自己的旧机器允许 metadata owner fallback。iOS 尚未接这个团队授权查询，因此本轮严格限定当前账户自己的机器；metadata 中出现机器不等于团队授权。
- [rpc.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/loro-streams-rpc/src/rpc.ts) 与 [machine-rpc-server.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/loro-streams-rpc/src/machine-rpc-server.ts)：`machine/memory` 经既有 Streams 请求／响应流，验证 workspaceId、machineId、版本与过期时间；没有此方法专属的逐用户 ACL。客户端机器可见性和最终 Streams grant 共同构成权限边界，不能声称 metadata owner 比较是服务端行级授权。
- [workspace-machine-rpc-facade.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/packages/components/src/providers/workspace-machine-rpc-facade.ts)：离线、未知在线状态或没有 `memoryProviders >= 1` 的 daemon 不应收到 provider 请求。iOS 复用官方 presence 和能力版本，拒绝读取未授权机器；不走本地电脑文件或 shell。

## 实际生效链路

[message-handler.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/lib/message-handler.ts) 将远程 `memoryProvider` 和本地 `machine/memory` 都接到 [memory-providers.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/lib/memory-providers.ts)。适配器固定执行 `nmem status -j`、`nmem agents list -j`；创建为 enroll，更新为 set。调用者不能传任意命令或 env。provider 数据与插件由电脑管理。

```text
┌──────────────────────────────────────┐
│ 设置：选择自己的电脑，读取已保存关联 │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ runtime：账户／workspace／owner 重验 │
│ 机器在线 + memoryProviders v1        │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ machine/memory → daemon → nmem       │
│ 只返回身份；不返回记忆正文           │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ 确认导入／解除：重读 mf，再写长度帧  │
│ 原生 Keychain → 短期 grant → Streams │
└──────────────────────────────────────┘
```

实际会话是另一条明确链路：[agent-role-create.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/lib/agent-role-create.ts) 读取角色所选机器的 runConfig.memory `{providerId,memoryId}`；[commands/session.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/commands/session.ts) 将它带进接受的输入和创建／恢复配置；[session.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/session/session.ts) 启动进程时经过适配器写 `NMEM_AGENT_ID`；[session-execution-service.ts](https://github.com/LodyAI/Lody/blob/a15cdae4301d541eacbafdc83f08d22a50f56777/apps/cli/src/session/session-execution-service.ts) 比较新旧记忆绑定，不同时 retire 后恢复进程。导入本身不启用角色记忆，提供方 ready 也不证明 Agent 插件已安装或检索成功。

## 本轮实现与边界

- 正式设置增加记忆入口，原生列表按来源电脑显示关联、稳定 ID、提供方与状态，详情仅显示上述身份资料。未知提供方的已有关联仍可读、解除，不伪装成 Nowledge 缺失。
- 支持单个身份确认导入，以及确认／取消解除关联；不新增创建、资料编辑、批量导入或角色绑定编辑。现有角色的记忆引用保持原样，仍由电脑端设置。
- 使用既有 native-owned runtime 和机器副本，RN 不新建 replica。账户／工作区切换取消旧详情，异步读取、授权和写入前后重验作用域与 owner；权限拒绝不回落到缓存。
- 离线／未知／不支持／未安装／未运行／读取失败分别显示；只有成功 ready 列表缺失身份才标记“未找到”。网络失败可显示相同作用域的缓存关联，列表和详情均提示缓存并禁写；目录权限拒绝显示具体原因，无数据与读取失败明确区分。
- 写入前重新 bootstrap，对解除关联比较原资料，导入重新 probe/list；稳定键重复导入不覆盖自定义名称。首次导入在权威列表确认后创建缺失的机器目录，再写关联；只读列表不会创建目录。导入前提供方停止时同步显示状态与原因，不继续展示过期的可导入列表。使用 uint32 大端长度帧 append；写入结果不明禁止重复提交，要求关闭详情后刷新，runtime 不自动重放。
- 与官方桌面本地 durable + best-effort upload 不同，iOS 本轮沿既有设置路径要求远端 append 确认。断网时不承诺本地待同步写入。bootstrap 与 append 之间仍是官方 CRDT 并发语义，没有服务端 CAS。
- 首次进入及手动下拉刷新时检查提供方；不新增后台轮询。团队机器授权查询、provider 创建／编辑、角色绑定编辑保留后续范围。
- 未使用真实 Cloud 账户／机器、真实 nmem／Agent 插件或真实记忆正文。iPad 和物理设备保持暂缓。

## 实施记录

- 开始日期：2026-10-18。
- 支持门禁：`pnpm check`、`pnpm bundle`、完整 cloud-runtime 类型检查、29 项运行时行为检查、31 项 UI runner 检查及正常签名 Release 模拟器构建均通过。英文浅色／深色的管理与九种状态共 4/4 流程通过，56 张截图逐一审阅，4 个源分辨率录屏抽检首／中／尾帧。源码与包内 runtime／Hermes 资产哈希、实际请求及 Flock 行读回随证据保留。
- 额外检查整个 cloud-runtime package 时发现角色写入的 Flock Value 类型丢失；在已验证的 Flock 行写入边界补回类型，行为与现有字段保留规则不变。
- [本轮验收](https://app.lobehub.com/acceptance/cbe06440-b213-48f0-b311-2d7e64c59055?r=1)：3/3 项业务结果，130 份证据上传完成；截图、视频与按顺序的解释／执行文本齐全，没有缺失、未执行或被门禁过滤的条目。
