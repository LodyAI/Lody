# 基于内容寻址的远程 diff 传输

Status: implemented
Translation: current
PR: [#2316](https://github.com/LodyAI/Lody/pull/2316)

[English](2026-10-31-remote-diff-transport.md)

## 摘要

远程 diff 过去每次打开都会重传两侧全文，All Changes 更新还会让整批正文失效。
现在将分页清单与经过校验的内容寻址字节读取分开，用不透明的逐文件 generation 失效，
正文按需加载。普通远程工作区可持久化已校验的 blob，加密与本地工作区只使用有界内存。
远程大文件先显示部分 patch，展开上下文时补齐完整文件。它减少重复正文传输，不提供
离线查看，也不代表已经测得生产环境的延迟收益。

## 决策

增量 capability `codeCollabDiffBlobs` v1 控制 `open-diff-manifest` 与 `read-blob`。
不支持时保留旧接口与原预算。两个新接口使用读权限，包括加密工作区 Guest，不启动监听、
不申请执行权。读权限调整、明文缓存和兼容性约定记录在待人工审阅的
[Spec 草案](../../../../specs/remote-diff-delivery.zh.md) 中。

清单枚举已有的 turn、All Changes 或单路径变化集合，焦点文件优先，其后按变化量排序。
条目携带可空的两侧描述、统计、状态、不透明版本和可选 hunks。每页最多 64 个路径，
远程编码响应最多 512 KiB。cursor 将范围、各 Git/member 基线及初始路径集合固定十分钟；
基线移动或 cursor 被淘汰时返回 `stale`。额外文件根分别计算变化与基线，焦点不缩小完整集合。

blob 分页使用原始字节偏移，允许切在 UTF-8 字符中间，正文为 gzip-base64。
客户端先重组并校验完整字节，再解码 UTF-8，保留 BOM 和换行字节。每侧沿用 10 MiB 原始
文本上限，也尊重服务注入的更低上限。daemon 分配前裁剪长度，再按宿主提供的实际 envelope
计量收缩，直到远程响应不超过 512 KiB。本地/远程身份来自传输入口，不能由请求 JSON 选择。
普通兼容 envelope 在 owner 加密后计量；这个上界也保守覆盖加密 feature 的结果，其 codec
另外检查完整结果与密封 frame 上限。

### 来源与权限

只有通过权限校验的清单才能签发 handle。handle 按请求会话和内容键索引，绑定实际 owner、
工作区和来源。每页重新校验会话权限与绑定。每个请求会话最多 8,192 个 handle，全局最多
65,536 个，按 LRU 淘汰，空闲十分钟过期。猜中全局哈希并不构成读取授权。
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
发布后推进已有 signal。共享索引不放内容哈希，避免只有索引权限的成员确认猜测的私有文件
正文是否存在，即使他没有 owner 范围的读取权限。

daemon 私有的逐路径磁盘身份、大小、mtime、ctime，以及非 Git 的保留基线描述，使增删行数
相同的内容变化仍能使该路径失效。HEAD/base ref 变化使已修改路径失效。重启后的首次发布
刷新已修改路径的 generation，但不重发未变化的文件行。这里明确调整了原提案的启动时
保留所有 token：如果不持久化基线指纹，就可能漏掉停机期间的基线移动或等统计修改。
接受这一次元数据刷新，避免仅为省去它而增加新的持久化元数据约定。

共享文件索引资源会发布仅 generation 变化的更新。重建 provider 时，generation 覆盖完整
才复用有效描述并只请求变化或缺失条目，否则重读分页清单。描述缓存最多保留 128 条。
All Changes 正文延后到文件进入视野或被展开；取消后，正在执行的 RPC 仍持有并发许可，
直到原请求实际结束。

### 缓存与远程大文件

校验后的 blob 使用工作区范围的键，内存 LRU 最多 64 MiB、2,048 条。普通远程工作区
可选择相同全局上限的 IndexedDB LRU，且已注册到缓存清理列表。加密与本地工作区的 blob
不打开该数据库。工作区释放或内容准入撤回时清理新增内存缓存；epoch 阻止晚到的读取重新填充已清理缓存。缓存或磁盘失败退化为
有权限的读取，不缓存持久失败；损坏缓存会丢弃并重读，部分或未校验 blob 不入缓存。
解析后 diff 的缓存键包含两侧内容键及路径。

两侧原始大小合计超过 256 KiB 时，远程清单携带三行上下文的 unified patch，最多 256 KiB。
计算也限制在 600 行编辑以内，更大的整段重写仅显示统计。本地清单仍返回完整描述，不应用
远程 hunk 策略。Pierre 将 patch 解析为部分元数据，第一次展开上下文时再取得完整且校验通过
的文件。展开操作有独立的读取 controller，文件块隐藏或卸载后不再启动后续分页；初始清单
与正文读取也在界面隐藏时停止后续分页。本次不扩展渲染器或 worker 架构。

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
- 保留 write 角色和执行 claim 会让每页变成一次动作，并继续排除本来可以读取正文的加密只读成员。
- 仓库没有允许加密工作区在 IndexedDB 存明文的现行约定。因此实现选择仅内存，它不是待确认的前提。
- 服务端持久化 diff 正文可以提供离线查看，但会改变数据所有权，不在本次范围内；客户端仍需在线且
  通过准入的机器与清单。

现有 legacy service 仍拥有 I/O。Effect feature/fix 评估让注册表与哈希逻辑保持纯计算或被动
状态，沿用已有 worker 和 RPC owner。只读 worker 关闭失败会在分别尝试 writer、tunnel 和文档的独立清理后汇总报告，不增加重试或保留失败状态。没有引入独立生命周期单元或扩展迁移依赖链。

## 验证与限制

行为证据由以下测试维护：

- `apps/cli/src/lib/code-collab/code-collab-v2-service.test.ts`：真实 SHA-1/SHA-256 Git
  和磁盘字节、BOM/CRLF/Unicode、会话绑定、路径逃逸、过期、分页预算、基线移动、历史与非 Git
  worker 读取、本地/远程 hunk 策略、等统计失效及不同文件根的基线。
- `packages/turn-diff-store/tests/sqlite-store.test.ts`：只读描述与字节选择、owner 隔离、
  保留期、完整重组与 worker 消息。CLI 打包产物 `turn-diff-store-worker.js` 的独立探针也只读打开已有数据库，按描述精确还原 BOM、CRLF 和 Unicode 字节。早期未修改 store 的探针还精确还原了四个 chunk 中的
  400,020 UTF-8 字节，检查完整哈希、缺失/空文件与 GC；这是复用 store 而不新增快照表示的依据。
- `packages/shared/tests/code-collab.test.ts` 与 CLI Flock 发布测试：仅 generation 变化
  不影响旧文件行，删除也清理兄弟行。
- `packages/loro-streams-rpc/tests/machine-rpc-server.test.ts` 与 `tests/e2ee-native.test.ts`：
  实际 owner envelope 计量、错误 owner 拒绝，以及真实签名 Guest 读权限和禁止保存。
- `packages/components/tests/code-collab-session-file-provider-v2.test.ts`：清单阶段正文为零，
  第一次打开传两侧，再次打开没有新增正文字节，单 generation 更新只请求该描述和新 head；
  还覆盖损坏、取消、加密内存策略、IndexedDB 保留与淘汰、存储不可用。
- `packages/components/tests/e2e/diff-viewer-large-diff-performance.spec.ts`：真实 panel/Pierre
  链路在零 blob 流量下显示部分 hunks，展开后补齐完整上下文。

这些是确定性的合成数据、本地行为验证，不是生产带宽、延迟、移动设备内存或托管部署基准。
不支持 capability 的机器仍可使用旧接口。相关决策：
[All Changes 范围](../feature/2026-10-19-all-changes-diff-scope.zh.md)、
[多文件打开](../bug-fix/2026-10-17-multi-file-diff-opening.zh.md)。
