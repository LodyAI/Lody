# 工作区全量导出与导入

Status: draft
Translation: current

[English](workspace-export-import.md)

工作区 owner 想把整个工作区备份下来，换一台设备或换一套存储后再合并回去；Lody 自己也要把
旧 loro-repo（TS）/ 旧 Flock 数据搬进 native loro-repo-rs。现有 `lody export` 只产出给人看的
Markdown/JSON，丢了删除记录、时钟和 peer，不能导回去；`lody migrate --from-oss` 只覆盖
“OSS 本地 → 云”这一个方向。本 Spec 定义一套无损、可校验、可合并的工作区包（bundle），作为
备份、换设备和今后所有存储迁移的共同底座。

本文是待审草稿；实现情况与限制见文末“证据”。owner 已定以下几点（2026-11-19 确认），下文不再讨论：

1. 导出和导入只允许工作区 owner 和 admin。
2. 加密（E2EE）工作区由有权限的成员设备在本机解密后导出明文包。
3. 导入是合并进一个已存在的工作区，不限于空工作区或新工作区。
4. “全量”只含导出者本来能读的数据，读不到的记为覆盖缺口。
5. 包与来源工作区是否加密无关：格式相同，任何包都能导入普通或加密工作区，不需要额外确认。
6. 包本身不再做口令加密。
7. 机器配置不跨工作区导入。
8. Roost 会话支持导出，可以不含签名：按读出的内容导出，导入时由导入者重新写入。
9. Prompt Shortcuts 进入第一版。
10. 相同 ID 的会话不覆盖目标，跳过或建冲突副本。
11. 跨工作区导入不改写导入的会话和 schedule，改为在目标工作区加导入栅栏（2026-11-19 选定）。

以下几处不是 owner 原话，而是本文的推荐或推定，在正文中逐处标明：Roost 有损导入的去重和跳过
规则、同 ID 会话按是否同源区分并默认跳过（推荐）、Prompt Shortcuts 的可见性规则（主控按 owner
的隐私原则推定）。

## 场景与职责

```mermaid
flowchart LR
  subgraph Source[来源]
    L[旧 TS Repo / SQLite / IDB]
    N[native engine]
    E[E2EE 工作区：本机解密]
  end
  Source --> X[导出器：按 room 原始字节 + blob]
  X --> B[(工作区包：清单 + 分块 + 哈希)]
  B --> I[导入器：校验 → 预演 → 逐 room 合并]
  I --> T[目标工作区：native engine，按目标模式加密/上传]
```

- **导出器** 从一个“来源适配器”逐 room 读出原始 CRDT 字节（Loro snapshot、Flock 文件），
  外加被引用的 blob，写成包。它不把数据转成 JSON 再重建。
- **包** 是自描述、版本化、可分块流式处理的文件，清单列出每个条目的格式、大小和哈希。
- **导入器** 先完整校验包，再做不写入的预演（dry-run）得出影响报告，最后逐 room 用 CRDT
  合并写入目标；目标是加密工作区时由目标现有密钥重新封装。导入期间不经过 renderer。
- **领域编解码器（codec）** 是每类 room 唯一需要写的代码：声明 room 识别、格式版本、引用关系、
  导入校验和（必要时）格式转换。迁移、备份、换设备共用同一套 codec。

## 导出范围

“全量”指**导出者有权读取、且属于工作区可协作数据**的全部 room；不是服务器上所有字节。

| 领域                                           | room / 存储                                                                              | 是否导出     | 说明                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| Workspace Meta                                 | Meta Flock（`e/m/ef…`）                                                                  | 是           | 包含删除记录；决定其它 room 是否“可见”                                                          |
| 工作区目录：项目、MCP 定义、Role、项目默认 MCP | `<ws>:wf:workspace` Flock                                                                | 是           | 只有共享定义；MCP 凭据本来就不在行里                                                            |
| Session 控制与历史                             | `session-*` Loro 文档                                                                    | 是           | 完整 oplog，含 unknown 字段和 opaque 条目                                                       |
| Roost 会话正文                                 | 当前为执行机本地 `roost-history.sqlite3`；native 下为 Roost room                         | 是（有损）   | 见下文“Roost 与 Prompt Shortcuts”。写者身份种子不导出                                           |
| 机器与 Agent 配置                              | `<ws>:mf:<machine>` Flock、`machine-*` 文档、旧 `agent-*` 文档                           | 是           | 导入规则受限，见下文；持久命令队列（`cmd` 族）不导入                                            |
| Schedule                                       | `<ws>:sr` Flock + `schedule-*` 文档                                                      | 是           |                                                                                                 |
| Preview comments                               | 旧：每会话 Loro 文档；新：Flock 行                                                       | 是           | 包内保存来源格式，导入时按目标格式转换                                                          |
| 旧 task 文档、旧 session-comment               | `task-*`、`${ws}:ti`、`session-comment-*`                                                | 是           | 只为无损，不新增功能                                                                            |
| 附件、图片                                     | 云：按 `<ws>/<session>/<id>` 存放；本地：`session-files/<ws>/`                           | 是（blob）   | 只导出被当前或历史版本引用的；按内容哈希去重。云端文件 90 天过期，取不到的记为 gap              |
| Code Collab 内容寻址快照                       | 执行机本地 `code-collab-v2/<ws>/diff-store.sqlite3`，100 天 / 1 GiB 回收                 | 部分（blob） | 从所属机器读取（本机直接读，其它机器在线时经已有的 Machine RPC 和权限）；离线或已回收的记为 gap |
| Prompt Shortcuts                               | 工作区命名空间外的 `shortcut-index:<ws>:<owner>:<private\|workspace>`、`shortcut-body:*` | 是           | 导出者自己的全部与他人的工作区共享项；导入规则见下文。E2EE 工作区当前不支持 Shortcuts           |
| 文件索引 FI/FIS                                | `<ws>:fi:*`/`fis`                                                                        | 否           | 可由 owner 重建，180 天 TTL                                                                     |
| presence、machine-monitor、ephemeral           | 临时通道                                                                                 | 否           | 不是持久数据                                                                                    |
| 机器本地运行状态                               | 自动化 ledger、schedule 运行表、operations/inbox、PR 轮询等 SQLite                       | 否           | 属于执行机，不属于工作区协作数据                                                                |
| 未提交的待发送输入                             | renderer IndexedDB `lody-session-inputs-v1`                                              | 否           | 尚未成为会话内容；导出前提示先发送或丢弃                                                        |
| 用量、通知、会话分享、成员                     | 云端服务记录                                                                             | 否           | 不是 CRDT 数据；用量可继续用 `lody export` 导出给人看                                           |

**明确不导出：** 一切凭据（provider 登录、API key、MCP 本地认证值、keychain、Streams/云
token、GitHub 凭据）；一切密钥与设备身份（E2EE 设备/epoch 密钥、ledger、恢复 vault、
host 身份密钥、配对与 custody 回执）；成员、角色、邀请和计费/套餐/用量账单；机器本地
运行状态（worktree、终端、ACP agent 的本地会话、源码目录）；缓存和 UI 偏好。

**覆盖报告：** 导出者读不到（无权限、云端已过期、机器离线、来源格式未知）的条目不静默
跳过：清单逐条记为 `gap`，写明原因。导入和 UI 都会显示“这份包不完整”。owner/admin 在普通
工作区不一定能读别人的私有机器会话（见 [单会话访问](session-access.zh.md)），所以“全量”
只含导出者能读的部分（owner 已定）。

## 包格式

包是一个 ZIP64 文件（store 模式，不再压缩），扩展名 `.lodybundle`；CLI 也可输出等价目录。
选 ZIP 是因为各平台都能流式写、随机读，便于大包只校验或只导入部分条目。

```text
manifest.json                    规范 JSON，最后写入；没有它包就是不完整的
rooms/<model>/<sha256>.<n>       room 原始字节，按 ≤ 64 MiB 分块
blobs/sha256/<ab>/<sha256>       附件、图片、diff 快照，按内容哈希命名
```

清单字段（v1）：

- `format: "lody-workspace-bundle"`、`version: 1`。读到更高主版本直接拒绝，不猜。
- 来源：工作区 ID、导出者账户 ID 和设备 ID、Lody 与 SDK 版本、导出开始/结束时间。不记录来源
  是否加密：加密工作区解密后的内容与普通工作区的格式完全相同。
- 每个 room 条目：来源 room ID、`model`（`meta` / `flock` / `loro` / `roost`）、
  `codec`（如 `session-loro/v1`、`preview-comment-loro/v1`）、`encoding`
  （`flock-file/v1` = `Flock.exportFile()`/`exportFlockRaw` 字节；`loro-snapshot/v1` =
  完整 Loro snapshot；`roost-turns/v1` = 读出的 Roost 回合，有损）、来源版本（Loro VV / Flock 版本）、分块列表及每块与整体
  SHA-256、来源是否含未上传的本地编辑。
- blob 条目：SHA-256、长度、kind、原文件名/MIME（这些只是展示信息）。
- `gaps`：未覆盖条目及原因。
- `digest`：对清单其余部分（规范 JSON）的 SHA-256。

**无损：** room 只存 SDK 原始导出字节，所以删除记录、HLC 时钟、peer、metadata、unknown
字段和容器身份都原样保留。禁止 `scan → put` 重建 Flock、禁止 JSON 重建 Loro，这与
[迁移计划](https://github.com/LodyAI/Lody/blob/native-repo-integration/.agents/docs/electron-loro-repo-rs-migration.zh.md#5-旧数据共存和回滚)
和 [OSS 迁移规则](../apps/cli/src/lib/oss-migration/AGENTS.md) 一致。

**一致性：** SDK 没有跨 room 原子快照。每个 room 是其自身某一时刻的完整状态；导出先读 Meta，
再读 Meta 引用的 room，之后新建的 room 不进包。被引用却缺失的 room 记为 `gap`。

**校验：** 哈希只防损坏和截断，不防篡改——能拿到明文包的 owner/admin 本来就能伪造任意内容。
包的真实性不作为安全前提；安全靠导入端的权限校验（见下文）。

**包的保护：** 包不做额外加密（owner 已定），只做以下基本处理：

- 只写到用户在保存对话框里选的位置；CLI 必须给 `--out`。文件以 0600（Windows：仅当前用户
  ACL）创建，先写临时名，`manifest.json` 写完后原子改名。
- 导出前提示：包含全部对话正文和附件，任何拿到文件的人都能读。
- 不自动上传、不进云、不写入工作区数据目录或日志。

## 导入合并语义

### 流程

1. **校验：** 流式读入，逐块核对哈希，先落到本机暂存目录（0700）。任一失败即停，目标未被写。
2. **准入：** 核对导入者角色、目标工作区模式、包版本、每个 codec 都已知。未知 codec 整包拒绝，
   不当成空数据。
3. **预演：** 在与目标隔离的临时 native namespace 中，把目标当前状态与包合并，按 codec 规则
   计算“会改变哪些行/文档”，产出报告：新增、更新、被拒绝的 room 及原因、映射、覆盖缺口。
   UI 默认先展示报告，用户确认后才写。
4. **写入：** 按依赖顺序逐 room 合并，Meta 最后：blob → 正文文档（session、schedule、
   comments…）→ 目录类 Flock（wf、sr、mf）→ Meta。源工作区的标题等元数据只在 Meta 合并后出现，
   所以中断不会出现“列表里有标题、点开是空的”。现有 loro-repo 存储在写入非空正文时会把文档
   标记为存在，因此中断后可能短暂出现没有标题的条目，重跑同一份包即补齐。
5. **收尾：** 写入一条导入回执；跨工作区时给导入的会话和 schedule 加导入栅栏（见下文）。

### CRDT 合并结果

- 每个 room 调用 `importRoomState`（Loro 为 `importLoroRaw`）把包里的字节合并进目标。
  结果等同两台离线设备重新联网：Loro 按因果合并，Flock 按每个 key 的 HLC 取 LWW，删除记录
  参与比较。
- **目标里的删除不会被“复活”：** 目标中更新的删除记录在 LWW 中胜出；目标里已彻底清除正文
  但 Meta 仍有删除记录的会话，导入器跳过对应正文 room，不留孤儿。反过来，包里更晚的删除会删掉
  目标里对应的数据——这是合并的本义，预演报告会列出全部“将被删除”的条目。
- 合并是单调的：已执行、已出队的消息不会因导入旧状态而回到待执行。
- **同 ID 的会话：** owner 已定同 ID 会话不覆盖目标，跳过或建冲突副本。以下细化为**推荐**：目标已有同 ID 会话时先看两边是否同源，即两份 Loro 文档是否共享因果历史
  （版本向量里有相同 peer 的重叠操作；peer 是随机 64 位，共享即同源）。同源说明是同一个会话，
  例如恢复备份或重复导入，照常合并。不同源是真正的 ID 冲突，正常情况下不会出现；出现时推荐**默认
  跳过**该会话，连同它的 Meta 行、Preview comments 和附件，不覆盖目标，也不拒绝整个 room，预演
  报告按标题列出被跳过的会话。不选“创建冲突副本”的理由：副本要换新会话 ID，牵连 Meta 行、子
  Tab/Side Chat 的父会话、Preview comments、附件存放路径、fork 和引用，等于改写数据；而且每次
  导入都会再产生一份副本，破坏幂等。需要那份数据时，可以把包导入另一个工作区。

### 幂等与恢复

- 同一份字节再次合并是空操作（版本已被覆盖）；不会产生新的上传。
- 本机导入日志以 `(目标工作区, 包 digest)` 为键，逐 room 记录 `pending / imported / rejected`，
  fsync 后原子改名。中断后用同一份包重跑即可继续；已完成的 room 再导一次也只是空操作。
- **不留半导入状态** 的含义是：用户可见的数据只在 Meta 合并后出现；Meta 是单 room 写入，
  自身原子。SDK 不提供跨 room 事务，已合并的 CRDT 数据也无法撤回，所以“回滚”不是选项，
  “继续完成”才是。预演阶段拒绝的 room 不会写入任何字节。
- 导入完成以“目标本地持久化”为准；上传进度单独显示，失败由正常同步重试，不让导入失败。

### 来源工作区 ≠ 目标工作区

| 引用                                                  | 处理                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 实体 ID（session、项目、schedule、Role、comment）     | 保留。都是随机 UUID，两个独立工作区不会撞；同 ID 会话的处理见上文“同 ID 的会话”。保留也让重复导入幂等                                                                |
| 含工作区 ID 的 room（`<ws>:wf:workspace`、`<ws>:sr`） | 改写为目标工作区 ID；行内容不变                                                                                                                                      |
| Loro peer、Flock 时钟 peer                            | 保留，不重映射（重映射会破坏 CRDT 身份和幂等）                                                                                                                       |
| 用户 ID（作者、`SessionMeta.userId`、Role 创建者）    | 保留为历史出处，不授予任何权限；非目标成员显示为“未知成员”                                                                                                           |
| 机器（`<ws>:mf:<machine>`、`SessionMeta.machineId`）  | 机器 room 不导入；会话保留原机器 ID，显示为“机器不可用”，只读；目标工作区所有成员可见（owner 决定，见下）                                                            |
| 附件 / 图片引用                                       | blob 重新上传到目标（同工作区恢复时目标仍有的 blob 跳过）；不改写历史，在会话 HEAD 写入一张“旧引用 → 新引用”映射表，沿用 OSS 迁移的 `resolveArchivedAttachment` 方式 |

跨工作区导入后，导入的会话和 schedule 不被改写（owner 2026-11-19 选定方案 (b)）。导入器在它们的元数据上
记下“导入栅栏”：哪些用户输入、排队项和 schedule 激活来自这份包，并注明目标工作区。目标工作区的执行端
跳过这些输入和这次激活；用户在目标里新发的消息、重新启用的 schedule 照常运行。栅栏只对它注明的
工作区生效，所以把目标导出的包导回来源时，来源里的原会话和 schedule 不受影响。机器持久命令不迁移。
同一工作区内的恢复不加栅栏，因为合并本身是单调的。

**谁能看到导入的会话（owner 2026-11-19 决定：导入即共享）。** 现有可见性按“会话所在机器在本工作区可见”或“会话 owner 是自己”判断，跨工作区导入的会话两者都不满足，会对所有人隐藏。因此导入的会话按共享处理：栅栏写明的工作区里所有成员都能看到，只读；其他工作区不因导入获得可见性。来源里私有的会话导入后对目标工作区全员可读；只有 owner/admin 能导入，且包里只有导入者本人能读到的内容。栅栏仍记下导入者（`importedBy`）作为来源记录。

### 导入进 E2EE 工作区

- 导入必须在目标工作区里一台已准入的 owner/admin 个人设备上运行；写入走该设备的 protected
  native namespace，由现有 protector 用目标**当前** epoch 密钥和本设备签名重新封装。包里的
  明文不经过云端明文通道。
- 附件 blob 用新的随机文件密钥重新上传；映射表写在受保护的会话内容里，不进 URL 或明文元数据。
- 包里带来的已签名执行意图（signed execution intent）在目标里验不过签名，因此不可执行；
  导入器不重签旧意图。
- 导入只写 CRDT 内容 room。ledger、成员、设备、机器共享策略都在包外，导入器也没有写它们的
  能力——这些数据只能由各自的签名流程产生。
- 反过来，加密工作区导出的包也可以直接导入普通工作区，流程与普通包相同（owner 已定）。

## 权限与安全

**谁能用：** 本地 OSS 桌面只有本机用户，即视为 owner。云普通工作区按云端成员角色；E2EE 工作区按
**已验证 ledger** 中该设备所属成员的角色，不信服务器返回的角色字段。

**校验位置：**

- 导出：本地检查角色后才开始；云组合同时向云端申请一次导出登记（检查角色并写审计）。
  需要承认：导出只读取导出者本来就能同步到的数据，被改过的客户端绕过本地检查也读不到更多；
  所以导出的角色限制是产品策略加审计，真正的读边界仍是现有同步/解密权限。
- 导入：本地检查角色；云组合申请导入登记。真正的防线是**逐行校验**：预演算出的每一处变更都要
  通过该领域正常写命令所用的同一套授权规则（例如 Role 只能由 `canManageAgentRole` 允许的人
  修改，机器行只能由机器 owner 修改，session 共享授权只属于机器 owner）。任何一处不通过，整个
  room 被拒绝并写入报告——Flock 原始字节无法只合并一部分，拒绝整 room 比悄悄改写更安全。
  因此借导入能做到的事，不超过导入者本人用正常界面能做到的事。
- 写入经由正常同步路径，云端现有的 room 写权限照常生效。

**撤销：** 导出和导入在每个 room 前重新检查角色（云端角色订阅；E2EE 为 ledger head）。发现被撤销
立即停止：导出不写 `manifest.json`，留下的文件不可导入；导入停在当前 room，日志保留，只有仍
有权限的人能继续。已经写进本地文件或已合并的数据无法收回，这与现有撤销语义一致。

**不能借导入篡改的数据：** 成员、角色、邀请、ledger、设备身份、签名策略、计费——都不在包里，
导入器也没有对应写入口。包里出现无法识别的 room 或 codec 整包拒绝。

**审计：** 云组合由服务端记录 start/finish、操作者、工作区、包 digest、room 数和字节数，不含正文；
E2EE 工作区的审计记录同样只含不透明计数。导入另在目标工作区写一条可见的导入回执（时间、操作者、
来源工作区 ID、包 digest），所有成员都能看到“这里导入过一份包”。本地 OSS 只写本机日志。

## 入口

- **CLI：** `lody workspace export --out <file> [--workspace <id>]` 和
  `lody workspace import <file> [--workspace <id>] [--dry-run] [--yes]`。默认先显示预演报告并要求
  确认；`--yes` 用于自动化。现有 `lody export`（给人看的导出）保持不变。
- **桌面：** 设置 → 工作区 → 数据：“导出工作区…”（保存对话框、覆盖报告）与
  “导入到此工作区…”（选择文件 → 预演报告 → 确认 → 进度，可中断后继续）。非 owner/admin 不显示。
- **执行位置：** 都在 Node 侧（CLI one-shot 或桌面 data host / daemon）执行，renderer 只看进度和
  报告，不接触 engine 或原始字节。
- **本地 OSS：** 全程本地，不发任何云请求；blob 来自本地文件存储。
- **云平台：** 额外的导出/导入登记与审计走 `packages/cloud-api` DTO 和 `packages/platform` 可选
  能力端口；OSS 组合中该端口不存在，功能仍可用。附件从云 relay 读取、向目标 relay 上传。

## 与 native 迁移的关系

旧格式 → native 不再为每个领域各写迁移，而是同一条管线的特例：

```text
旧存储（冻结的 SQLite 备份 / 已 flush 的 IDB）--来源适配器--> 内存中的包条目
    --> 导入器（目标 = 同一工作区的 native namespace）
```

- 来源适配器：`legacy-repo`（只读打开一致备份）与 `native-engine`（`exportFlockRaw`、
  `exportLoroRaw`）。迁移不必真的落盘成 `.lodybundle`，但走同一份清单、哈希、日志和 codec。
- 迁移与“同工作区导入”唯一的区别：来源含未上传的本地编辑时，用 `enqueueOutbox: true` 并归属
  到原写者；已证明同步过的用 `false`。这是来源适配器报告的事实，不是导入器猜的。
- **格式变化** 由 codec 的转换步骤处理，例如 `preview-comment-loro/v1` → 新 Flock 行。转换会
  产生新的 CRDT 操作，旧的因果历史不会出现在新格式里；包始终保存原始格式，所以转换可以重做。
- 冻结、发布 room owner、不双写、Roost 不碰等规则仍由迁移协调器负责；导出/导入只提供“完整读出”
  和“无损合并”两个动作。Workspace Meta 的 native 接入（另一会话进行中）应把 Meta 的读出/合并
  写成本管线的第一个 codec（`meta-flock/v1`），而不是另造一个迁移框架。
- `lody migrate --from-oss` 长期可由“OSS 导出 → 云工作区导入”替代；在本管线覆盖其全部检查
  （append-cas、附件历史扫描、协作停止）之前保留不动。

## 分阶段实施

行数为产品代码估算，不含测试和文档。

| 阶段               | 范围                                                                                                                                                                       | 验收用例                                                                                                                                                          | 预算                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| A. 包与核心管线    | 清单/分块/哈希、ZIP 读写、导入日志、codec 接口；`meta-flock`、`flock-room`、`loro-room` 三个通用 codec；来源 `native-engine`；同工作区导入；CLI 导出/导入/预演；仅本地明文 | 删除记录与时钟往返一致（读回 register 证据而非 get/scan）；重复导入零变化零上传；中断在每个 room 边界后重跑结果相同；截断/篡改块被拒绝且目标未写；未知 codec 拒绝 | ~1,300                 |
| B. 旧格式迁移      | 来源 `legacy-repo`（一致 SQLite 备份 + IDB 导出）；`enqueueOutbox` 来源事实；Meta 迁移收敛到本管线；Preview comments 格式转换                                              | 旧库 → native 后 Loro VV 覆盖全部来源；含未上传编辑的来源进入 outbox；转换重跑结果一致                                                                            | ~700                   |
| C. Blob 与跨工作区 | 附件/图片/diff 快照 blob；跨工作区映射与导入栅栏；逐行授权校验                                                                                                             | 他人 Role、他人机器行、共享授权的改动整 room 拒绝；导入会话停协作、schedule 停用；附件映射可解析历史引用                                                          | ~1,200                 |
| D. 云与桌面        | 云登记/审计 DTO 与端口；角色校验与撤销中止；桌面设置页与进度；Prompt Shortcuts（走其云 API）                                                                               | 非 owner/admin 看不到入口且 CLI 拒绝；中途撤销停在 room 边界；OSS 组合零云请求；私有 Shortcut 只在原所有者导入时导入且仍为私有，共享项导入后仍为共享              | ~1,400（另有私有后端） |
| E. E2EE            | 设备本机解密导出；导入以目标当前密钥重新封装；附件重新加密                                                                                                                 | 导出包可在普通工作区导回；导入后其它成员设备可解密；旧执行意图不可执行；ledger/成员不变                                                                           | ~800                   |
| F. Roost           | `roost-turns/v1` 有损 codec：经现有历史读取导出回合，导入时只补建目标中不存在的 Roost 会话                                                                                 | 往返后可见正文一致；目标已有的同一会话不被改动；重复导入不产生重复回合                                                                                            | ~400                   |

阶段 A、B 可与 Meta native 接入并行；C 之后的阶段各自独立评审。本 Spec 当前没有待 owner 决定的问题。

## Roost 与 Prompt Shortcuts

**Roost（有损）：** owner 已定 Roost 支持导出、可以不含签名。Roost 回合由执行机本地写者身份
签名，当前 SDK 没有保留原签名记录的原始导出/导入。导出时读出每个回合的可见内容
（`roost-turns/v1`），导入时由导入者通过共享 HistoryWriter 重新写入。丢失原签名、原写者证明和
回合的逐次编辑过程；保留会话里能看到的全部内容。**推荐规则（实现采用）：** Roost 正文存放在执行
机本地，重写成新的 Roost 存储只在导入那台机器上可读，所以重写为该会话的 Loro 历史，并把它的
历史后端改为 Loro。重写的回合与原回合不是同一份 CRDT 数据，所以不合并：目标已有同一会话时整体
跳过，只补建目标里没有的。SDK 以后提供原始接口时再增加无损 codec。

**Prompt Shortcuts：** owner 已定进入第一版；下面的可见性规则是**主控按 owner 的隐私原则推定**
（不改变现有隐私模型）。Shortcuts 按“工作区 + 所有者 + 可见性”分开存储，只有所有者能写自己的。
导出包含导出者自己的全部 Shortcuts（含私有）和他人的工作区共享 Shortcuts。导入时保持原可见性：

- **私有项：** 只有导入者就是原所有者（同一账户）时才导入，仍为私有；否则记为缺口，不导入。
- **工作区共享项：** 导入为导入者名下的工作区共享项，报告注明原作者。
- 重复导入按原 Shortcut ID 去重。加密工作区目前不支持 Shortcuts，导入加密工作区时 Shortcuts
  一律记为缺口。

## 证据

- 意图：本文；“已定”的 1–11 条由 owner 2026-11-19 确认（前提 1–3 为 owner 本人给出；4–11
  为 owner 对七个问题的回复）。标为“推荐”“推定”的内容不是 owner 决定。这些不是对本 Spec
  整体修订的批准，Spec 仍为 draft。
- 已检查的实现：[`lody export`](../apps/cli/src/commands/export.ts)、
  [session-export](../apps/cli/src/lib/session-export/)、
  [OSS 迁移](../apps/cli/src/lib/oss-migration/README.md)、
  [E2EE 房间映射](../packages/shared/src/workspace-streams-content.ts)、
  [单会话访问](session-access.zh.md)、[E2EE 基础](e2ee-foundations.zh.md)、
  [加密附件决定](../.agents/notes/implemented/architecture/2026-10-28-encrypted-attachments.zh.md)；
  loro-repo `795bafcb` 的 client 类型 `exportFlockRaw`、`exportLoroRaw`、`importRoomState`、
  `importLoroRaw`、`flockReadRegisters`；
  分支 `native-repo-integration` 上的迁移计划 §5。
- 实现：[workspace-bundle](../apps/cli/src/lib/workspace-bundle/README.md)（导出、导入、CLI 与 daemon 入口、桌面
  设置 → 数据；其 README 列出尚未实现的部分）。
- 已执行的验证：该目录下基于真实仓库的单元测试，以及本地平台上用两个真实 daemon 的端到端运行
  （导出、预演、导入、重复导入无变化、再导出、反向导入），以及在构建出的 OSS 桌面应用里实际
  操作设置 → 数据（导出、预览、导入）。云端和 E2EE 工作区未做端到端验证。
