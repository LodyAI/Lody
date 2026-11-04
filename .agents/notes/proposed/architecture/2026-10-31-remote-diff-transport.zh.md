# 按内容寻址的远端 diff 传输

Status: proposed
Translation: current

[English](2026-10-31-remote-diff-transport.md)

## 摘要

远端客户端（Web、手机、查看另一台机器的桌面端）读取 diff 时，要向所属 daemon 请求文件
完整的新旧文本：

- 每次打开都重传两份全文；
- 文件索引任何一行变化，都会重拉整个 All Changes 批次；
- 预算没有计入 RPC 信封自身的编码开销；
- 加密工作区里，只读成员能打开文件文本，却打不开 diff。

本提案把每个 diff 拆成两部分：一份分页的清单，包含路径、统计、blob key 和不透明的逐文件
generation；以及一组不可变 blob，从三种明确的来源按字节范围读取，并在客户端缓存。两个新
方法都是纯读，对远端来说过大的文件只发 hunk。离线查看（把 diff 正文持久化到机器之外）不在
范围内。以上均未实现、未测量，节省的字节量是预期，不是实测。

## 问题

当前行为最初在 `d07ea674c` 上检查，2026-11-01 对照工作区复核：

- `code-collab/open-current-diff`、`open-turn-diff` 和 `open-all-changes-diff` 返回
  `CodeCollabV2DiffSnapshot` 文本（`packages/shared/src/code-collab.ts`）。
  - 64 KiB 以内发 plain，超过的发 gzip-base64。
  - 每份文本压缩后上限 1 MiB。
  - 响应里没有摘要，客户端无法复用已经持有的文本。
- 基准一侧（git merge-base 或 HEAD blob，或本轮的旧快照）不可变，却在每次打开、每次刷新时
  重传。
- 客户端订阅 `fi:` 文件索引 Flock。
  - 任何一行变化都会产生新的 `CodeCollabSessionFileProvider`。
  - `use-session-all-changes-diff-data.ts` 据此判定数据已过期，重新请求整个批次。
- All Changes 模式先请求整批 `open-all-changes-diff`。
  - 视口门控（`use-diff-viewport.ts`）只作用于其中 `deferred` 的项。
  - 会话和单轮模式已经通过 `loadPaths` 按文件加载。
- `CODE_COLLAB_V2_ALL_CHANGES_DIFF_LIMITS` 只计入载荷自身的 base64：
  `encodedDiffSnapshotWireBytes` 用的是 `payload.data.length`。外层 AES-GCM owner-session
  信封和 JSON 开销都没算进去。
- Electron 通过本地 `/machine-rpc` 快速通道访问同一个服务，也被套上了 1 MiB 和批次上限，
  而这些上限只是为 Streams 通道设的。
- 客户端缓存只在内存里：
  - `diff-viewer.tsx` 的 96 项解析 LRU；
  - `use-session-conversation-diff-data.ts` 的 8 项 `resolvedDiffCache`。
- 加密工作区的 `E2EE_READ_QUERY_METHODS`（`packages/shared/src/e2ee-rpc.ts`）包含
  `code-collab/open-text`、`refresh-text` 和 `file/download-chunk`，但不包含任何
  `open-*-diff` 方法。
  - 因此每次 diff 调用都要写权限，并且要经过执行 journal 的 claim / retain / finish。
  - 只读成员能读文件正文，读不了 diff。
  - 这和启动监视无关：`openText` 同样调用 `ensureWorkspaceWatch`，却按读授权。

## 已有做法

除特别标注外，均读自源码。

- **Zed** 只发送基准文本（`UpdateDiffBases`、`OpenUncommittedDiff`）。分支 blob 按 git oid
  拉取，并发 16。diff 由客户端计算，主机只推送变化了的基准。
- **Paseo** 每次变化都推送完整的预分词 hunk 快照，结果撞上了 relay 的帧预算。它自己的注释
  写着："temporary until diffs load lazily per file"。
- **Orca** 和 Lody 一样，逐文件拉取新旧全文。它只限制远端调用方（每次回复 4 MiB，按 JSON
  转义后计算），本地调用不设上限。
- **Happy** 通过端到端加密 RPC 拉取 `git diff` patch。
- **GitHub**（据其文档）小文件自动加载，超过 400 行或 20 KB 的文件要点"Load diff"才显示。

以实时仓库为准的产品，主机离线时都看不到 diff。只有把 diff 持久化在服务器上的产品
（GitHub、Codex cloud）能看到。

## 提案

### 1. 清单

新增 owner 作用域方法 `code-collab/open-diff-manifest`。

**请求**

请求沿用现在的范围输入，再加上分页参数：

- 范围，三选一：
  - `sessionId` 加 `turnId`；
  - `sessionId` 加 All Changes 范围 `branch` / `uncommitted`；
  - `sessionId` 加单个 `path`。
- `cursor?`：不透明字符串。
- `limit?`：路径数，由 daemon 收紧到上限以内。

**文件集合**

文件集合与现在的变更集一致，从不列出整个工作区：

- 单轮范围：本轮记录的文件。
- All Changes：该范围基准下、各项目成员里有改动的路径。
- 单路径：恰好一项。只有这种情况可以返回 `not_changed`。

**响应与分页**

响应为 `{ entries, nextCursor: string | null }`：

- cursor 绑定范围，以及每个成员已解析出的基准。基准在两页之间移动时，下一页返回
  `stale`，客户端从第一页重来。
- 顺序沿用现在的 All Changes：先放焦点路径，其余按改动从小到大。

**每一项的字段**

| 字段 | 内容 |
| --- | --- |
| `path` | 路径；重命名时附带原路径 |
| `add` / `del` | 增删行数 |
| `status` | `ok` \| `binary` \| `missing` \| `too_large` \| `not_changed` |
| `base` / `head` | 两侧各为 `null`（新建或删除），或 `{ key, rawBytes, format }` |
| `version` | 文件索引中发布的 generation 令牌（第 4 节） |
| `hunks` | 可选（第 5 节） |

`format` 是现有的 `CodeCollabV2TextFormat`，即 BOM 和换行，描述的是解码后的文本，不是
传输编码。

**Blob key**

- git 基准一侧用 `git:<oid>`：
  - SHA-1 仓库的 oid 是 40 位十六进制，SHA-256 仓库是 64 位。客户端按长度选择校验算法，
    对 `blob <len>\0<bytes>` 求哈希。
  - daemon 在该成员自己的仓库和基准上执行 `git rev-parse <base>:<path>`，做法与
    `resolveCurrentDiffBaseSnapshot` 通过 `projectRun` 解析的方式相同，不在会话根目录上
    解析。
- 当前磁盘文本和轮次快照用 `sha256:<hex>`，用现有的 `CodeCollabV2FileDigestSchema` 校验。

**大小上限**

远端与本地使用同一个每侧上限：`maxRawTextBytes`，即原始 10 MiB。任一侧超过上限，这一项
就是 `too_large`：只有统计，没有 key，也没有 hunks，展开时无法把文件拉进渲染进程。

**按视口加载**

清单不含文件文本，因此取代批量正文响应及其 2 MiB 预算。`use-session-all-changes-diff-data.ts`
的 All Changes 路径改成：先请求清单页，视口到哪一项才读那一项的 blob。现在它是整批加载，
只对 `deferred` 项做门控。

### 2. 读取 blob

第二个方法 `code-collab/read-blob`。

**请求与响应**

- 请求为 `{ sessionId, key, offset, length }`，`offset` 和 `length` 是原始 blob 内的字节
  位置。
- 响应为 `{ offset, length, totalBytes, encoding: 'gzip-base64', data }`。`data` 是原始
  字节先 gzip、再 base64 的结果；`length` 是 daemon 实际给出的长度。

daemon 会收紧 `length`，让编码后的响应不超过页上限（第 6 节）；它不信任客户端请求的长度。
单页可能切断一个 UTF-8 码点。

**客户端拼装**

客户端按以下顺序处理：

1. 每页先 gunzip；
2. 按 offset 拼接字节；
3. 用 key 校验整个 blob；
4. 再按清单里的 `format` 解码。

**句柄表**

daemon 只提供它在同一会话的清单里签发过的 key。

- 表项以 `(ownerSessionId, key)` 为键，绝不只用 key。签发给一个会话的 key，不能通过另一个
  会话读取。
- 每项记录来源及其上下文：成员仓库、工作区根目录和路径。
- 初始上限：每个会话 8,192 项，总计 65,536 项，按最近最少使用淘汰，空闲 10 分钟过期。
- 未知或已被淘汰的 key 返回 `stale`。`stale` 加进 `CodeCollabV2ErrorCodeSchema`；只有新方法
  会返回它，也只有协商了 `codeCollabDiffBlobs` 的客户端会调用新方法。

**三种来源的读取方式**

**git**

- 在记录下来的成员仓库里执行 `git cat-file blob <oid>`，返回对象的原始字节。daemon 不对它
  解码，也不做 UTF-8 校验。
- 解压后的对象可以放进一个短期缓冲区，这样读 N 页时，不必把整个对象读 N 遍。

**turn store**

- 新增按哈希读取的 API：按 `content_hash`（快照 UTF-8 字节的 SHA-256）从已校验的 CDC 块
  重组出快照，再从重组后的字节里切页。页的 offset 不需要对齐块边界。
- 重组后的字节使用同一个短期缓冲区。

**磁盘**

- 按范围从实时文件读取，不做缓冲。
- 每读一页之前，daemon 都重新规范化记录的路径。只有路径仍落在该成员的工作区根目录内
  （沿用现有的工作区根约束），才允许读取；否则以 `invalid_path` 拒绝。这样可以防止路径在
  两次读取之间被换成指向工作区外的符号链接。
- daemon 只在生成清单项时对磁盘文本求一次哈希。文件在传输中途被改时，客户端校验会失败，
  于是丢弃该 blob，重新请求那一项清单。

**缓冲上限**

缓冲上限是待测量的初始值：总计 64 MiB，单个对象不超过 `maxRawTextBytes`，空闲 60 秒过期。

### 3. 授权

- `code-collab/read-blob` 是纯读。它和 `file/download-chunk` 一样加入
  `E2EE_READ_QUERY_METHODS`，经 `authorizeRead` 授权，不进入执行 journal。
- `code-collab/open-diff-manifest` 同样是纯读：不写磁盘，也不调用 `ensureWorkspaceWatch`。

监视的启动留在现有的发布路径上（激活和轮次刷新），两个方法的权限都不以它为依据。

结果是：加密工作区的只读成员可以查看 diff，就像现在已经能查看文件文本一样。这是对现状的
有意改变：现在的 `open-*-diff` 需要写权限，这些旧方法为了兼容旧版本对端保持不变。

### 4. 文件索引中的逐文件 generation

**读者**

旧客户端在严格规范化（`normalizeCodeCollabFileIndexValue`）时，会把带未知字段的整行丢掉，
所以版本号不能加在现有行上。改为每个路径一行兄弟行：`[path, 'v']` → `{ g: <token> }`。
`scanCodeCollabFileIndexFlock` 会跳过多于一段的 key，所以旧读者看不到这些行。

**写入方**

- `CodeCollabFileIndexWritableFlock.set` 同时接受 `[path]` 和 `[path, 'v']` 两种 key。
- `writeCodeCollabFileIndexToFlock` 单独扫描、比较 generation 行，因为文件行的扫描看不到
  它们。
- 只要任何 generation 行有差异，`publishCodeCollabFileIndexFlock` 就提交，即使文件行全部
  相等。
  - 这仍然属于内容去重：generation 行的值确实变了。
  - 没变的行绝不为了刷新时间戳而重发。
  - 这类提交和现在一样推进 `fis:` 信号。
- 删除路径行时，在同一次提交中删掉它的 `[path, 'v']` 行。
- 实现 PR 要同时修改 `apps/cli/src/lib/code-collab/AGENTS.md` 里"每个路径一行"的表述，
  改成"每个路径一行文件行，外加一行可选的 generation 行"。

**令牌**

`g` 是不透明字符串，格式为 `<epoch>.<counter>`。

- epoch 每次 daemon 启动时随机生成，只用于新的递增。
- 启动时，发布方沿用从 Flock 读到的现有 `[path, 'v']` 值，所以重启不会把所有行重发一遍。
- 每次递增都带上当前 epoch，因此同一个令牌绝不会对应不同内容。

**`g` 何时变化**

以下任一情况发生，`g` 就变化：

- 发布路径重写了该路径的文件行；
- 发布方观察到该范围的基准移动（提交、rebase、新的 merge-base），而文件行保持不变。此时该
  范围内所有有改动的路径都在同一次提交中递增。

**如何观察基准移动**

1. 每次发布时，用 `git rev-parse` 低成本地解析 `HEAD` 和基准 ref；
2. 与上次发布时记录的值比较；
3. 只有其中之一变化，才重新计算 merge-base。

这个检查与注入的 `observeWorkspaceGit` 是分开的，后者仍只在激活和显式的根目录刷新时运行。
`open-diff-manifest` 调用从不递增 `g`。

**`g` 的承诺**

`g` 只承诺"可能变了"。误报只多一次小的清单请求；而且没变的 key 仍然命中，blob 缓存会把这次
误报吸收掉。扫描中不新增任何内容哈希。

**客户端**

All Changes hook 逐路径比较 generation，只对 generation 变化、并且已打开或接近视口的路径，
重新请求清单项。旧 daemon 不写 `[path, 'v']` 行，此时保持现在的整批行为。

**为什么 `g` 不用内容哈希**

把内容哈希放进索引，就成了确认预言机：能读到索引的人，可以验证自己猜测的文件内容是否正确。

- 普通工作区里，这个读者是能读取 Flock 流的 relay。
- 加密工作区里，是持有文档密钥的任何成员，包括那些无法通过 owner 作用域 RPC 读取该路径
  内容的成员。

内容 key 只在 owner 作用域的 RPC 响应中传输。

### 5. 远端大文件的 hunk 模式

**通道判定**

daemon 从入口判断通道，不听客户端的：本地 `/machine-rpc` 处理器和 Streams RPC 服务器，
各自把 `plane: 'local' | 'remote'` 传入处理上下文。客户端无法经 Streams 冒充本地通道。

**远端**

当通道为 `remote`、且 `base.rawBytes + head.rawBytes` 超过远端 hunk 阈值时，这一项另外
带上 `hunks`：

- `hunks` 是 unified patch，固定上下文（默认 3 行），并有自己的字节上限。
- 客户端用 pierre 的 `parsePatchFiles` 把它解析成部分元数据（`isPartial: true`）。
- 客户端把 pierre 的 `loadDiffFiles` 接到 `read-blob` 上，拉取两侧 blob。pierre 在第一次
  展开时补齐整个文件，而不是按范围补。这可以接受：两侧都在 `maxRawTextBytes` 以内，取回
  之后 blob 就留在缓存里。
- patch 超过自己的上限时，这一项变成 `too_large`，只有统计。

**本地**

本地通道上，新方法从不使用 hunk 模式，只受 `maxRawTextBytes` 约束，不受单次回复预算约束。
桌面端同样使用新方法，因此两个通道共用一条客户端路径。现有的 `open-*-diff` 方法在两个通道
上都保留当前上限。

### 6. 预算与页上限

远端预算一律按封装 owner-session 信封之后的序列化响应计算，不按内部载荷计算。

**页上限**

read-blob 编码后的页上限和清单的页上限，都从 512 KiB 起步，沿用 `file/download-chunk` 的
先例（512 KiB 的响应分块）。

真正的约束是 owner-session 信封在 Streams 上的单次追加上限。本仓库没有定义这个值
（`apps/cli/src/lib/file-preview/README.md` 也这样写），需要确认。

**E2EE 分片**

加密工作区里，E2EE feature 层仍会把每一次响应切成 256 KiB 的分片
（`E2EE_FEATURE_CHUNK_BYTES`），每个结果最多 16 MiB（`E2EE_FEATURE_MAX_RESULT_BYTES`）；
客户端用本地保留的原件把分片拼回去。这只是同一次响应的分片，不是再向 daemon 请求一轮，
因此应用层的页上限不需要和它对齐。

### 7. 客户端 blob 缓存

缓存放在一个小的存储接口之后，同一个模块服务桌面端、Web，以及 `packages/components` 里的
手机端界面。

blob 以 `(workspaceId, key)` 为键，用 key 校验通过之后才存。基准 key 已经缓存的文件，只需传
head 一侧；没有变化的文件不产生任何传输。

**存储位置**

| 通道与工作区 | 存储 |
| --- | --- |
| 本地通道 | 只放内存。daemon 就在同一台机器上，持久化收益很小。 |
| 远端通道、普通工作区 | IndexedDB，按字节限额的 LRU，像现有 IndexedDB 缓存一样登记到 `clear-local-cache.ts`。 |
| 远端通道、加密工作区 | 只放内存，按字节限额，关闭工作区和撤销授权时丢弃。仓库没有记录允许在渲染进程中静态保存文件明文的规则。 |

解析缓存的 key 从"路径加长度"改为 `(baseKey, headKey)`，在多次重新拉取之间保持稳定。

### 8. 兼容性

新增机器协议能力 `codeCollabDiffBlobs`（版本 1），为两个方法把关：

- 缺失即不支持，绝不按 CLI 版本判断（`packages/shared/AGENTS.md`）。
- 第 1 步冻结完整的 v1 schema，后续几步只新增产出方，不改变 v1 读者接受的内容。冻结的内容
  包括：
  - 可选的 `version` 和 `hunks` 字段；
  - `nextCursor`；
  - read-blob 的页结构；
  - `stale` 错误码。
- `E2EE_READ_QUERY_METHODS` 的新增项在同一步上线。

没有该能力的客户端或 daemon，继续使用现有方法，现有方法保持支持。generation 行是新增的，
已存储的数据都不迁移。

## 考虑过的替代方案

- **保留全文，只加客户端缓存。**没有 key，客户端判断不了自己是否已经持有某份文本，缓存在
  多次打开之间永远命中不了。
- **daemon 端生成高亮 token（Paseo 的做法）。**否决，原因有三：
  - 载荷大约翻倍；
  - 把 daemon 绑在客户端的主题和语法上；
  - 并没有减少基准一侧的重传。
- **同步文本 CRDT（Zed 的缓冲区复制）。**`apps/cli/src/lib/code-collab/AGENTS.md` 禁止
  这样做。
- **在文件索引里放内容哈希。**这是最简单的失效信号，但因第 4 节所述的确认预言机问题被否决。
- **diff 读取继续要求写权限、继续走 journal。**否决，原因有二：
  - 每读一页 blob 都要付出一次执行声明；
  - 加密工作区的只读成员明明已经能读文件正文，却仍看不了 diff。
- **把 diff 正文持久化到机器之外，以便离线查看。**owner 已决定（2026-10-31）不在范围内。
  这会改变数据所有权，需要单独的 Spec。

## 交付

建议按以下顺序交付，每一步都可以在能力开关之后独立上线：

1. 协议与 daemon 端：
   - 共享部分：完整的 v1 schema、能力、`stale` 错误码、只读查询登记项；
   - 通道注入；
   - 带分页的 `open-diff-manifest`；
   - 支持三种来源的 `read-blob`；
   - turn store 按哈希读取；
   - 句柄表与缓冲区。

   daemon 端测试覆盖：
   - 按会话隔离的 key 和 `stale`；
   - git 原始字节和 SHA-256 格式的 oid；
   - 跨越块边界的 turn store 页；
   - 两页之间的符号链接逃逸；
   - length 收紧。
2. 客户端 blob 缓存，以及单文件和单轮 diff 的 provider 切换。
3. 在发布路径中写入 generation 行，All Changes 改为按视口逐文件加载。
4. 远端 hunk 模式，以及按信封之后计算的预算。

新的 daemon 代码遵循 Effect v4 选择指南；是否迁移现有服务方法，按 PR 评估，不预设。

## 待定问题

- owner-session 信封在 Streams 上的单次追加上限是多少？它决定真正的页上限，目前从 512 KiB
  起步。
- 远端 hunk 阈值和 patch 上限需要测量。起点：两侧原始字节合计 256 KiB，patch 256 KiB。
- 第 2 节中句柄表和缓冲区的上限是初始值，需要测量。
- 加密工作区能否在渲染进程中（IndexedDB）持久化 diff 明文？如果可以，用什么密钥，撤销授权
  时如何处理？
- 非 git 工作区没有 `git:` 基准，其基准一侧使用 turn store 的 `sha256:` key。这假设按哈希
  读取的 API 同样覆盖 `openCurrentDiff` 使用的"最早旧快照"路径。

## 证据

**检查过的实现**

- `packages/shared/src/code-collab.ts`
- `packages/shared/src/e2ee-rpc.ts`
- `packages/loro-streams-rpc/src/e2ee-feature-parts.ts`
- `apps/cli/src/lib/code-collab/code-collab-v2-service.ts`
  （`resolveCurrentDiffBaseSnapshot`、`readGitBaseDiffSnapshot`、
  `encodedDiffSnapshotWireBytes`）
- `apps/cli/src/lib/code-collab/code-collab-flock-publish.ts`
- `packages/turn-diff-store/src/sqlite-store.ts`
- `packages/components/src/lib/code-collab-file-index-cache.ts`
- `packages/components/src/components/sessions/use-session-all-changes-diff-data.ts`
- `packages/components/src/providers/workspace-machine-rpc-facade.ts`
- `packages/components/src/ui/diff-viewer/diff-viewer.tsx`
- `@pierre/diffs` 1.6.1 的公开类型

**相关决定**

- [All Changes diff 范围](../../implemented/feature/2026-10-19-all-changes-diff-scope.md)
- [多文件 diff 打开](../../implemented/bug-fix/2026-10-17-multi-file-diff-opening.md)

**已有做法的来源**

读自公开仓库 zed-industries/zed、getpaseo/paseo、stablyai/orca、slopus/happy，以及 GitHub
的仓库限制文档；均未执行。

**已执行的验证**

无。
