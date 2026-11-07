# SET-10 完善 MCP 管理并核对使用效果

[总计划](../2026-10-16-settings-reorganization.md) · [任务索引](../2026-10-16-settings-reorganization.md#任务索引)

| 字段     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 阶段     | 第二阶段                                                 |
| 优先级   | P1                                                       |
| 状态     | 已完成（默认生效／安全删除首版）                         |
| 依赖     | [SET-06](./06-phase-one-acceptance.md)                   |
| 当前授权 | 2026-10-17 用户授权调查、实现、验收后单独 commit 并 push |

## 目标

使 MCP 列表、默认启用和后续配置操作具有明确语义，并验证它们对会话的真实影响。

## 开工时依据

已有 MCP 名称及 enabledByDefault 编辑；运行时保留 connection／bearerToken 等未投影字段，测试覆盖重名拒绝。完整连接管理和设置对会话配置的作用仍需追踪。

以下是本轮确认的调查入口；开工前重新检查工作树、调用方、导出、fixture 和配置。新增文件及协议以实施时的证据为准。

- `apps/mobile/src/screens/RemoteSettingEditorScreen.tsx`
- `apps/mobile/src/features/settings/remote-settings.ts`
- [packages/cloud-runtime/src/runtime/settings.ts](../../../../packages/cloud-runtime/src/runtime/settings.ts)
- [packages/cloud-runtime/src/models/settings.ts](../../../../packages/cloud-runtime/src/models/settings.ts)
- `apps/mobile/tests/native/settings.test.mjs`
- `apps/mobile/verification/ui/settings.py`

## 工作内容

- [x] 追踪默认启用设置与新会话／现有会话输入配置的消费路径，明确生效时机。
- [x] 整理列表的名称、连接类型摘要、默认状态和权限；保持连接秘密不投影到 RN。
- [x] 核实添加、删除、编辑 transport 和验证连接的正式协议；按可用能力逐步接入。
- [x] 不引入连接原文字段；新增和完整连接编辑保留到原生秘密表单具备后实施，不开放通用 JSON 编辑。

## 验收标准

- [x] 修改默认状态后，消费该值的会话路径体现真实结果，而不仅是列表文字变化；隔离网络边界观察真实持久化 history／mq 与 machine dispatch。
- [x] 重名、权限拒绝、连接失败、并发修改和保存失败有可恢复反馈。本轮验证目录／连接缺失与服务端拒绝；真实连通性检查见保留范围。
- [x] 只改名称／默认状态时保留连接凭据与未知字段。

执行总计划的[验证与交付规则](../2026-10-16-settings-reorganization.md#验证与交付)。新分支、错误恢复、权限与持久化逻辑要有小而有效的行为检查；只有静态分组搬迁不新增实现快照。

## 范围边界

不因整理 UI 自动运行 MCP 工具或加载远程脚本；完整连接编辑需先有经验证的安全接口。

## 关联任务

[SET-09](./09-agent-management.md) · [SET-20](./20-roadmap-closeout.md)

## 官方协议与生效链路

调查固定在官方 `LodyAI/Lody` 的 `7246f7836d7c458818e4abaa9bd2f60096d4e7d0`，通过 GitHub API 取得源文件；本机参考 checkout 是较早的 `e73d3109`，不以其状态代替本次协议结论。

- [workspace-mcp.ts](https://github.com/LodyAI/Lody/blob/7246f7836d7c458818e4abaa9bd2f60096d4e7d0/packages/shared/src/workspace-mcp.ts)：支持 stdio／HTTP；连接可含 bearerToken、headers、env、envPassthrough 及由 daemon 展开的环境变量。服务器结构含 id、name、transport、connection、enabledByDefault、createdAt、updatedAt。
- [workspace-flock.ts](https://github.com/LodyAI/Lody/blob/7246f7836d7c458818e4abaa9bd2f60096d4e7d0/packages/shared/src/workspace-flock.ts)：在工作区 Flock 的 `['mcpServer', id]` 行 set／delete；不是新建一个 Cloud CRUD endpoint。iOS 沿已存在的 `<workspace>:wf:workspace` Streams 和大端长度帧写入。
- [use-session-mcp-selection.ts](https://github.com/LodyAI/Lody/blob/7246f7836d7c458818e4abaa9bd2f60096d4e7d0/packages/components/src/hooks/use-session-mcp-selection.ts)：未保存选择时采用工作区默认值；明确的空数组保持全关；同步完成后过滤已删除的 ID。
- [session-mcp-resolver.ts](https://github.com/LodyAI/Lody/blob/7246f7836d7c458818e4abaa9bd2f60096d4e7d0/apps/cli/src/agent/session-mcp-resolver.ts)：daemon 使用发送配置中的 ID 加载工作区连接，在 ACP 启动时按 Agent HTTP capability 与 daemon 环境展开连接；配置存在不等于连接成功。当前官方实现把解析失败记录为 problem，Agent 仍可启动其内置 MCP。
- [workspace-machine-rpc-facade.ts](https://github.com/LodyAI/Lody/blob/7246f7836d7c458818e4abaa9bd2f60096d4e7d0/packages/components/src/providers/workspace-machine-rpc-facade.ts)：`mcp/list-tools` 要求 `mcpToolDiscovery` capability 及 `canUseLocalMachineRpc`；本次核对的远程 Machine RPC schema 不含这个方法。iOS 不伪造远程连通性验证。

原缺陷：iOS `sendTurn` 使用 `previous.mcpServerIds ?? []`，未读取默认值；UI 开关只能供其他客户端消费。修复后的链路：

```text
┌──────────────────────────────────┐
│ 设置：保存默认值／确认删除        │
└────────────────┬─────────────────┘
                 ▼
┌──────────────────────────────────┐
│ 工作区 Flock：mcpServer 行        │
└────────────────┬─────────────────┘
                 ▼
           ◆ 已有选择？ ◆
           │ 是        │ 否
           ▼           ▼
┌────────────────┐ ┌────────────────┐
│ 队列／上次选择 │ │ 工作区默认值   │
└────────┬───────┘ └────────┬───────┘
         └──────────┬───────┘
                    ▼
┌──────────────────────────────────┐
│ 过滤已删除 ID；缺失连接则提示     │
└────────────────┬─────────────────┘
                 ▼
┌──────────────────────────────────┐
│ 持久化 history／mq，再 dispatch   │
│ inputConfig.mcpServerIds          │
└────────────────┬─────────────────┘
                 ▼
┌──────────────────────────────────┐
│ daemon 解析连接并交给 ACP Agent   │
└──────────────────────────────────┘
```

## 本轮实现范围

- 首轮／尚无保存选择的会话采用最新工作区默认值；续聊和队列沿用既有 ID，明确空数组不重新启用默认服务器。
- 非空选择发送前读取权威目录，过滤删除的服务器；读目录失败或连接缺失在 history／mq 写入前失败。空选择不新增网络读取。
- 切换／替换 session 后，迟到的读取不能写入旧 turn；更改 MCP 集合会解除不再匹配的冻结 Role 标识。
- 列表区分“默认开启／关闭”、传输类型及尚未配置连接；编辑页解释默认值作用范围；MCP 保存／删除错误持久显示在表单内并保留草稿，重试时才清除。缺少连接不能新启用，但可以关闭原有错误默认值。
- 增加原生确认的删除，检查 name／default／transport／configured／updatedAt，在写前 bootstrap 已发现新版本时拒绝删除；未知写入结果要求关闭表单并刷新，绝不自动重放。
- 改名／默认值仍只修改对应字段；连接、凭据、未知字段原样保留。RN 投影仅增加 configured 布尔值和 updatedAt，URL、command、headers、env、token 不进入 RN／诊断。
- 写权限继续由工作区 Streams grant 在服务端执行；runtime 对工作区／账号切换重新校验。没有新增 iOS 私有角色权限规则。版本检查是客户端乐观校验，Flock 并发写仍按官方 CRDT 规则合并，不提供服务端 CAS。

## 本轮保留范围

- 新增服务器、完整连接编辑：官方 Flock 协议已确认，但当前 RN 表单不能承载连接秘密；需要后续在 LodyKit 建立原生表单和秘密处理边界。页面明确指引在电脑上的 Lody 完成。
- 工具发现／连接验证：当前正式接口属于本机 RPC；等官方提供远程能力或另行确定原生连接验证方案再接入。不因本任务执行 MCP 工具。
- iOS 尚无会话内逐项 MCP 选择菜单；本轮消费其他客户端已保存的选择和工作区默认值，不增加 composer／新会话宿主改动。
- 删除不能停止已运行的 Agent，也不承诺动态卸载其已加载工具；生效承诺是后续发送配置不再携带该 ID。

## 实施记录

- 开始日期：2026-10-17。
- 程序化检查：55 项定向行为检查、31 项 UI runner 检查通过；TypeScript、i18n、原生源登记、许可证、`pnpm bundle` 和正常签名的 Release 模拟器构建通过。全仓 `pnpm check` 仅在另一在途任务的 `docs/superpowers/specs/2026-10-17-wide-layout-design.md` 格式处失败，保留该文件。
- 离线 UI：独立可重置 `mcp-settings-preview` 场景使用生产列表／表单，注入保存失败、重名与删除冲突。英文浅色／深色 2/2 通过；共享机器／Agent／MCP／工作区／快捷回复五类表单的键盘前后背景检查也为 2/2 通过。共审阅 58 张截图（含 MCP 视频起中末帧），并确认录像完整。
- 真实云端／物理设备：不读取桌面凭据，不发送真实机器任务，不执行真实云端删除；iPad 按既有范围继续暂缓。

行为检查命令：

```sh
node --experimental-strip-types --experimental-test-module-mocks --test \
  apps/mobile/tests/native/mcp-settings.test.mjs \
  apps/mobile/tests/native/settings.test.mjs \
  apps/mobile/tests/native/session-runtime.test.mjs \
  apps/mobile/tests/native/data-runtime.test.mjs \
  apps/mobile/tests/settings/remote-settings.test.mjs
```

构建与 UI 使用 `pnpm verify:build` 和 `pnpm verify:simulator --name 'SET-10 MCP Final Acceptance'` 管理租赁环境，运行 `mcp-settings` 与 `settings-form-backgrounds`，均要求录像。完整命令、程序输出、构建信息和 UI 证据保留在 `.artifacts/settings-set-10/`；构建使用共享 DerivedData，无关闭签名或新增原生实现。

[本轮验收](https://app.lobehub.com/acceptance/5eccf834-f0a1-40f2-8265-f01da5fa0df9?r=1)：2/2 项通过，66 份证据上传完成，要求的截图、录像和行为文本均无缺失。覆盖生产表单的可恢复流程与客户端实际发送配置，不把离线边界观测写成真实 MCP 连接成功。
