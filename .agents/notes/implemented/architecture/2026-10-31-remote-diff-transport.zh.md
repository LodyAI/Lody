# 基于内容寻址的远程 diff 传输

Status: implemented
Translation: current
PR: [#2316](https://github.com/LodyAI/Lody/pull/2316), [#2753](https://github.com/LodyAI/Lody/pull/2753), [#2756](https://github.com/LodyAI/Lody/pull/2756), [#2765](https://github.com/LodyAI/Lody/pull/2765)

[English](2026-10-31-remote-diff-transport.md)

## 摘要

远程 diff 过去每次打开都会重传两侧全文，All Changes 更新还会让整批正文失效。
现在将分页清单与经过校验的内容寻址字节读取分开，用不透明的逐文件 generation 失效，
正文按需加载。普通远程工作区可持久化已校验的 blob，加密与本地工作区只使用有界内存。
远程大文件先显示部分 patch，展开上下文时补齐完整文件。它减少重复正文传输，不提供
离线查看，也不代表已经测得生产环境的延迟收益。

## 决策

增量 capability `codeCollabDiffBlobs` v1 控制 `open-diff-manifest` 与 `read-blob`。
不支持时保留旧接口与原预算。两个新接口不启动监听、不修改证据；加密调用维持既有 write
权限与执行 claim。按 #2316 的 owner 决定，Guest diff 功能拆到后续独立 PR。明文缓存和兼容性约定记录在待人工审阅的
[Spec 草案](../../../../specs/remote-diff-delivery.zh.md) 中。

清单枚举已有的 turn、All Changes 或单路径变化集合，焦点文件优先，其后按变化量排序。
条目携带可空的两侧描述、统计、状态、不透明版本和可选 hunks。传输优先级不改变面板的字母排序；
完整成功的 Branch 清单同时更新 provider 的实时 Changes 列表，让侧栏与面板采用同一集合。
聚焦文件不在集合中时明确提示已无改动，空批次显示“没有修改”。部分、失败或被后续请求取代
的结果不得替换侧栏元数据；Uncommitted/turn 读取不覆盖 Branch 元数据。每页最多 64 个路径，
远程编码响应最多 512 KiB。cursor 将范围、各 Git/member 基线及初始路径集合固定十分钟；
基线移动或 cursor 被淘汰时返回 `stale`。额外文件根分别计算变化与基线，焦点不缩小完整集合。

blob 分页使用原始字节偏移，允许切在 UTF-8 字符中间，正文为 gzip-base64。
客户端先重组并校验完整字节，再解码 UTF-8，保留 BOM 和换行字节。每侧沿用 10 MiB 原始
文本上限，也尊重服务注入的更低上限。daemon 分配前裁剪长度，再按宿主提供的实际 envelope
计量收缩，直到远程响应不超过 512 KiB。本地/远程身份来自传输入口，不能由请求 JSON 选择。
普通兼容 envelope 在 owner 加密后计量；这个上界也保守覆盖加密 feature 的结果，其 codec
另外检查完整结果与密封 frame 上限。

### 来源与权限

当前 Git 比较区分正文身份与文件是否变化。二进制或超限占位符不能证明正文相同，文本相同
也不能排除执行权限变化。当前读取器将相同文本或旧接口的两个 binary 占位符判为
`not_changed` 前，会在实际所属仓库内，针对同一个固定基线检查 Git 文件状态，按字面匹配
路径，并禁用外部 diff 与文本转换。相同正文仍可复用 blob 键，但不能因此隐藏变更文件。
这些信息只保留在 daemon 内，不增加协议字段。检查失败时旧批量接口返回 `deferred`
（单文件返回 `transient_io`），清单返回逐文件 `unavailable`，后续读取仍可恢复，不能变成
`not_changed`。历史 turn 比较仍只使用保留的证据。

Web、Electron 和原生 iOS/Android 在历史证据不可用时仍保留请求轮次的范围。原生运行时
把原因和提示传给已有的不可用界面。取消自动请求当前工作区 diff，是因为它即使可读，
也可能包含后续修改，无法还原所请求的轮次。显式的当前/全部改动读取仍独立存在。
这里规定的是失败后的行为，不认定历史证据缺失的原因，也不改变捕获与保留策略。

新生成的本轮文件卡片及其修改前后内容来自同一份已保留的 ACP 编辑证据。证据缺失或
保存失败时，轮末不再用 Git 统计合成 `history.fileDiff`。已移除的 Git 摘要补写会生成
没有历史内容的可点击卡片，而且工作区比较无法证明每项修改都归属于本轮 Agent。
因此，没有编辑证据的纯终端修改不再生成新的本轮卡片，当前“全部改动”仍通过 Git
显示这些修改。已有的仅摘要历史不补写也不删除，历史内容不可用时维持上述提示。
Git 未提交/未推送状态、PR 发现、证据重试、收尾预算和轮次释放责任仍相互独立。
不引入新的捕获或存储格式，保留现有 Promise 证据与历史边界。

只有通过权限校验的清单才能签发 handle。handle 按请求会话和内容键索引，绑定实际 owner、
工作区和来源。每页重新校验会话权限与绑定。每个请求会话最多 8,192 个 handle，全局最多
65,536 个，按 LRU 淘汰，空闲十分钟过期。猜中全局哈希并不构成读取授权。
符号链接、目录与子模块指针（包括 superproject 中缺失的 commit）按单文件显示 binary；
文件读取错误（包括路径逃逸拒绝）返回单文件不可用；路径检查仍阻止越界读取，其他文件仍可读取。
请求本身的授权或校验失败仍拒绝请求。磁盘读取时文件被删除或改名
返回 `stale`，允许有界的元数据刷新。描述捕获中的单文件 `stale` 会针对同一个固定基线重试
一次，再隔离为单文件错误。客户端保留权限拒绝分类，不伪装成临时 I/O 故障。
Git/store 重组缓冲全局最多 64 MiB、8,192 个对象，空闲 60 秒过期；被动注册表不拥有定时器。

- Git 键为 `git:<oid>`，同时支持 SHA-1、SHA-256 仓库。解析与 `cat-file blob` 在所属
  member 仓库执行。客户端按 oid 长度选择算法，校验 Git 的 `blob <长度>\0` 头与原始字节。
- 磁盘键为原始字节 SHA-256。每页重新校验规范路径、工作区包含关系和打开后的文件身份，
  拒绝逃逸 symlink。传输期间即使发生等长修改，也会在完整哈希校验时失败，触发一次清单重试。
- turn 键使用已有完整 UTF-8 `content_hash`。新增 worker 描述读取按 owner、路径、两侧
  和保留期选择记录，不解压正文；字节读取重新选择、核对指定哈希与原始大小，再复用已有的
  chunk 重组与全量哈希校验，无需数据库迁移。历史 turn 只用存储证据。earliest-old 沿用
  “最早仍保留且未过期”的语义；签发后、进入缓冲前若来源移动，旧 handle 失败，不能偷换
  为另一快照。缺失文件和零字节文件仍是不同状态。

新 diff 接口在所有传输平面使用独立的只读 store 与已有路径解析器，不创建缺失数据库、
不初始化或迁移 schema、不运行 GC，也不接受修改。这样不会通过正常 worker 的惰性初始化
把读操作变成写操作，也不会创建工作目录或修复 member 链接。

### 不披露内容的失效通知

旧读取器会拒绝文件行中的未知字段，因此 generation 使用增量兄弟行
`[path, 'v'] -> { g: <随机 epoch>.<counter> }`，旧扫描器忽略多段 key。
写入单独比较兄弟行，支持仅 generation 变化的提交；删除路径时同步删除兄弟行，
发布后推进已有 signal。generation 兄弟行也计入[完整索引和每批发布的预算](../bug-fix/2026-11-05-code-collab-file-index-budget.zh.md)。
每个变更路径预留第二行和最多 64 字节的编码后 token；文件行、仅 generation 变化和孤立
兄弟行清理共用有界提交计划，每批之后 flush/sync。已有超长 token 会重新签发，不能绕过预留。
共享索引不放内容哈希，避免只有索引权限的成员确认猜测的私有文件
正文是否存在，即使他没有 owner 范围的读取权限。

daemon 私有的逐路径磁盘身份、大小、mtime、ctime，以及非 Git 的保留基线描述，使增删行数
相同的内容变化仍能使该路径失效。HEAD/base ref 变化使已修改路径失效。重启后的首次发布
刷新已修改路径的 generation，但不重发未变化的文件行。这里明确调整了原提案的启动时
保留所有 token：如果不持久化基线指纹，就可能漏掉停机期间的基线移动或等统计修改。
接受这一次元数据刷新，避免仅为省去它而增加新的持久化元数据约定。

generation 会减少文件索引容量：每个改动路径占两条物理行及版本字节预留。1000 行上限下，
未计目录与字节成本时最多保留 500 个全改动路径；合成的单根 500 文件场景在 100 KiB 预算下
保留 268 个路径。被裁剪目录仍可按需展开；All Changes 通过清单独立枚举完整集合。

共享文件索引资源会发布仅 generation 变化的更新，使实时视图刷新。主机监听过期后，
索引 token 不能证明文件新鲜度，因此每次加载 All Changes 都重新校验分页清单；批次描述
只供可见文件消费一次，之后重新打开时校验元数据并复用已验证的正文。待消费描述最多
128 条。即使索引陈旧，也以机器返回的文件集合驱动列表和视野加载。这会增加元数据传输，但不重传未变正文。

provider 在自身生命周期内拥有实时 Branch 列表及监听者，完整成功的比较通知 summary hook；
请求启动序号拒绝较旧的完成结果，取消或缓存释放后不再发布。它只更新本地展示元数据，
不由渲染器反写共享索引。provider 更换后先用新索引，下一次实时比较成功后再替换。
实时 Changes 不等待可选的历史读取器，历史 turn 汇总仍跟随保留证据。接受完整清单后继续保留
另一份陈旧侧栏列表会给同一比较提供两个矛盾答案，因此不采用。

写入者的 diff 活动单独续用已有 `init-directory` 发布流程，每五分钟最多一次，失败后
至少间隔五秒，以保留十分钟的监听寿命。Guest 文件读取跳过此动作；加密工作区的 diff 仍要求 write 权限。激活是有错误观测的后台
工作，发布失败不阻塞正文；两个 blob RPC 仍为纯读取。provider runtime 内合并并发激活，
owner 或根目录变化时更换 runtime。取消后，RPC 并发许可仍保留到原请求实际结束。

只有协商成功的 blob 分页支持取消。旧 daemon 已在进行的有效请求即使在滚动时结束也继续使用，
不因初始能力协商附带了 controller 而丢弃。可选缓存分类不等待尚未确定的机器路由，未知路由只用内存。

### 缓存与远程大文件

校验后的 blob 使用工作区范围的键，内存 LRU 最多 64 MiB、2,048 条。普通远程工作区
可选择相同全局上限的 IndexedDB LRU，且已注册到缓存清理列表。加密与本地工作区的 blob
不打开该数据库。工作区释放或内容准入撤回时清理新增内存缓存；epoch 阻止晚到的读取重新填充已清理缓存。缓存或磁盘失败退化为
有权限的读取，不缓存持久失败；损坏缓存会丢弃并重读，部分或未校验 blob 不入缓存。
解析后 diff 的缓存键包含两侧内容键及路径。

两侧原始大小合计超过 256 KiB 时，远程清单携带三行上下文的 unified patch，最多 256 KiB。
计算也限制在 600 行编辑以内，超过计算、patch 或编码页预算时回退完整 blob；只有原始正文
超限才不可用。本地清单仍返回完整描述，不应用远程 hunk 策略。Pierre 将 patch 解析为部分元数据，第一次展开上下文时再取得完整且校验通过
的文件。展开操作有独立的读取 controller，文件块隐藏或卸载后不再启动后续分页；初始清单
与正文读取也在界面隐藏时停止后续分页。本次不扩展渲染器或 worker 架构。

哈希与 hunk 来自同一次捕获的字节。延后展开遇到过期 handle 时重新签发一次；只有内容标识
未变才能补全原 patch。任一侧内容或状态变化时，面板重新加载整批比较（基线标题、路径集合和统计），
或当前 turn 比较，不能在旧基线标题下原地换入新行号。其他展开失败显示错误与重试按钮。刷新过程中保留上一份
一致的比较，并标示正在刷新，完整清单到达后再切换。内容键未变的文件保留查看器元数据、
已补全的上下文和文件块状态，变化文件换用新的 loader。视野锚点的 observer 不因路径集合
改变而重建；重试只重新挂载失败的查看器。这些状态保留不得混用不同的比较内容标识。恢复原状的文件即使标为 `not_changed` 也保留可读描述。绑定 runtime 的部分
loader 不进入跨工作区的不可变 turn 缓存；已经完整读取的 turn 快照仍可保留。

## 已核实的传输限制

2026-11-04 的源码检查区分了传输硬限制与应用预算：

| 层次 | 实际限制 | 含义 |
| --- | --- | --- |
| 普通 Streams append | 公开网关默认与 storage HTTP 请求体上限均为 64 MiB | 普通响应一次 append，Lody 不会自动分片 |
| 加密 feature 结果 | 完整序列化结果最多 16 MiB | 超限在密封分页前明确失败 |
| 加密 frame | 密封后最多 1 MiB，包含 143 字节开销 | feature 正文已有 256 KiB 分片 |

锁定的 `@loro-dev/streams-client` 0.12.1 一次 append 发送一次 HTTP POST。
网关对声明长度与流式实际超限均返回 HTTP 413。这些是公开源码默认值，不是部署测量。
现有 `file/download-chunk` 的 512 KiB 是原始范围，编码后响应更大，不能据此推导线上的
512 KiB 限制。diff 页大小约束调度、内存与取消粒度；真正消除重复字节的是哈希和缓存复用。

公开源码版本 `9dd723175fccc5fc669676fd8d05b37efb82945e`：
[网关](https://github.com/loro-dev/loro-streams/blob/9dd723175fccc5fc669676fd8d05b37efb82945e/riverrun-gateway/src/proxy/upstream.rs#L124)、
[存储](https://github.com/loro-dev/loro-streams/blob/9dd723175fccc5fc669676fd8d05b37efb82945e/rr/src/server.rs#L485)。
对生产 codec 的直接探针接受了恰好 16 MiB、重组了 64 个 feature 页，并拒绝多一个字节。
未对在线网关执行超限探针。

## 备选方案与影响

- 仅给旧全文接口加客户端缓存，无法在传输前识别可复用内容，仍会重传不可变基线。
- daemon 高亮 token 增加正文且绑定主题与语法；Paseo 的整份 hunk 快照也会在每次更新重传。
  Zed 的基线缓存与 Orca 的编码后远程预算启发了当前拆分；同步文本 CRDT 仍不属于 Code Collab。
- 在 Flock 放内容哈希更易失效，但会形成内容确认 oracle；随机 generation 保持兼容且避免披露。
- Guest diff 会扩大 Git 基线与历史证据的访问权限。#2316 维持既有 write 限制，功能拆到后续独立审阅的 PR。
- 仓库没有允许加密工作区在 IndexedDB 存明文的现行约定。因此实现选择仅内存，它不是待确认的前提。
- 服务端持久化 diff 正文可以提供离线查看，但会改变数据所有权，不在本次范围内；客户端仍需在线且
  通过准入的机器与清单。

现有 legacy service 仍拥有 I/O。Effect feature/fix 评估让注册表与哈希逻辑保持纯计算或被动
状态，沿用已有 worker 和 RPC owner。只读 worker 关闭失败会在分别尝试 writer、tunnel 和文档的独立清理后汇总报告，不增加重试或保留失败状态。没有引入独立生命周期单元或扩展迁移依赖链。

## 验证与限制

行为证据由以下测试维护：

- `apps/cli/tests/session-execution-service.test.ts`：没有编辑证据的轮次不再获得
  Git 单独补出的卡片；已捕获内容在后续轮次修改前完成保存；取消或更早的 Git 状态
  观察不能覆盖较新的状态。
- `apps/mobile/ios/apps/ios/tests/native/files-rpc.test.mjs` 和
  `apps/mobile/android/runtime/test/contract-bridge.test.mjs`：当前工作区内容可读时，
  不可用的历史轮次仍保持不可用；已保留的轮次正文和显式的当前读取维持各自的比较范围。
- `apps/cli/src/lib/code-collab/code-collab-v2-service.test.ts`：真实 SHA-1/SHA-256 Git
  和磁盘字节、BOM/CRLF/Unicode、会话绑定、路径逃逸、过期、分页预算、基线移动、历史与非 Git
  worker 读取、本地/远程 hunk 策略、等统计失效、不同文件根的基线、文件删除、捕获时编辑及补丁预算回退，
  两种 scope 与 Project Member 的二进制替换、仅权限变化，以及 Git 比较失败后的单文件隔离与恢复。
- `packages/turn-diff-store/tests/sqlite-store.test.ts`：只读描述与字节选择、owner 隔离、
  保留期、完整重组与 worker 消息。CLI 打包产物 `turn-diff-store-worker.js` 的独立探针也只读打开已有数据库，按描述精确还原 BOM、CRLF 和 Unicode 字节。早期未修改 store 的探针还精确还原了四个 chunk 中的
  400,020 UTF-8 字节，检查完整哈希、缺失/空文件与 GC；这是复用 store 而不新增快照表示的依据。
- `packages/shared/tests/code-collab.test.ts` 与 CLI Flock 发布测试：仅 generation 变化
  不影响旧文件行，删除也清理兄弟行。
- `packages/loro-streams-rpc/tests/machine-rpc-server.test.ts` 与 `tests/e2ee-native.test.ts`：
  实际 owner envelope 计量、错误 owner 拒绝，以及真实签名 writer 授权和 Guest 的清单、blob 与保存拒绝。
- `packages/components/tests/code-collab-session-file-provider-v2.test.ts`：清单阶段正文为零，
  第一次打开传两侧，再次打开没有新增正文字节，索引 generation 未更新时也重新校验元数据且只传输新 head；
  还覆盖损坏、取消、加密内存策略、IndexedDB 保留与淘汰、存储不可用。
- `packages/components/tests/e2e/diff-viewer-large-diff-performance.spec.ts`：真实 panel/Pierre
  链路在零 blob 流量下显示部分 hunks，展开后补齐完整上下文；陈旧索引不能隐藏清单文件或排除其视野加载。
  展开失败显示重试，比较变化后整批刷新并更新基线标题。

这些是确定性的合成数据、本地行为验证，不是生产带宽、延迟、移动设备内存或托管部署基准。
不支持 capability 的机器仍可使用旧接口。相关决策：
[All Changes 范围](../feature/2026-10-19-all-changes-diff-scope.zh.md)、
[多文件打开](../bug-fix/2026-10-17-multi-file-diff-opening.zh.md)。
