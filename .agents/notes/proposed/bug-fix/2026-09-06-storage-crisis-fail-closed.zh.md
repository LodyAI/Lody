# 本地仓库 IndexedDB 写满或失效时失败关闭

Status: proposed
Translation: current

[English](2026-09-06-storage-crisis-fail-closed.md) | 中文

## 摘要

用户磁盘写满后，渲染进程的 CRDT 副本先遇到 `QuotaExceededError`，随后 IndexedDB 连接进入
永久关闭状态，于是每次新建会话都失败并在 toast 里抛出裸露的 Chromium DOMException；即使用户
腾出了空间，toast 仍然不断出现，因为只有重启进程才能重新打开该连接。我们在传给
`LoroRepo.create` 的存储适配器外面包一层做错误分类，锁存一个单向熔断器，并用一块阻塞式恢复
界面取代反复弹出的 toast，其操作是重启应用。读操作和写操作一起失败关闭，这是关键取舍：返回
`undefined` 会被上层读成"该文档不存在"，从而让下一次写在持久数据之上另起一段历史。分类器目前
仍以 DOMException 消息文本作为兜底匹配，这是启发式而非稳定契约；要去掉它取决于尚未完成的
上游改动。

## 问题

见 [Lody #417](https://github.com/LodyAI/Lody/issues/417)。新建会话显示"会话创建失败"，正文是
`Failed to execute 'transaction' on 'IDBDatabase': The database connection is closing.`，
每重试一次就多叠一条。应用里没有任何操作能成功，也没有任何地方说明这一点。

有两个发现决定了修法。其一，`IndexedDBStorageAdaptor.loadDoc` 即使面对一个什么都不会写的全新
room，也开 `readwrite` 事务，因此会话创建是在**读路径**上就断了，根本没走到写——在输入框那层
加防护只能覆盖众多调用方中的一个。其二，濒死的连接绑定在渲染进程上，所以腾出磁盘空间和刷新
页面都无法恢复它。

## 决策与发现

实现见 [LodyAI/Lody#438](https://github.com/LodyAI/Lody/pull/438)，只覆盖 issue 中的 Phase 1；
其中描述的 Phase 2（纯文件系统的"管理存储"面板）尚未实现，因此该 issue 保持开启。

熔断器放在仓库层之下，即 `createCrisisAwareStorageAdapter` 内，而不是各个调用点：归档、发送、
工作区目录写入撞上的是与会话创建同一条死连接。它把每个被分类的失败重新抛为
`StorageCrisisError`，因此即便是第一次失败，原始引擎文案也到不了 toast。机制说明见
[storage crisis](../../../docs/components-storage-crisis.md)（英文）。

我们核实过 loro-repo 在 save 失败时不会丢数据：`persistDocUpdate` 会把 `docPersistedVersions`
回滚并把文档重新入队，`MetaPersister` 也只在 `save()` 成功之后才推进 `lastPersistedVersion`。
所以这是一个失败表现的正确性与体验问题，不是持久性缺陷。

但它确实是一个**持久性窗口**问题：失败后没有任何东西会重新触发 flush，重新入队的文档要等下一次
doc event，meta Flock 要等下一次订阅回调。因此一次瞬时失败会让最后一次改动一直不落盘，直到用户
恰好又编辑了点什么。已上报为
[loro-dev/loro-repo#130](https://github.com/loro-dev/loro-repo/issues/130)，它与磁盘写满
正交（后者本来就什么都存不下），不在本次范围内。

### 考虑过的替代方案

**内存版仓库兜底**，照搬 `ResilientRemoteCursorStore`。否决：那个 store 之所以能安全降级，是
因为 Streams cursor 只是可由服务端重建的回放检查点。仓库文档是用户数据，内存替身会接受它永远
无法持久化的写入，并在无可避免的重启中丢掉。

**读返回 `undefined`、只让写失败。** 按摘要中的理由否决：这会把一个可见的失败变成静默的数据
丢失。

**在 `InvalidStateError` 时自动重开**（`db.close()`、清掉缓存的 promise、重试一次），issue 里
列为可选项。否决：磁盘满时重开大概率同样失败，而会自愈的存储层会让应用更难失败关闭。粘性分类
加上显式重启是更清晰的契约。

事后得到进一步印证：`ensureDb` 会把**失败**的 open promise 缓存下来且从不清空，与 `close()`
和 `versionchange` 两条路径的做法相反，因此一旦开库失败，该 adaptor 实例在整个页面生命周期内
就已经是死的（[loro-dev/loro-repo#131](https://github.com/loro-dev/loro-repo/issues/131)）。
应用层的重开只会建立在一个自己都无法重开的层之上。

**改 `patches/loro-repo.patch`** 在库内做分类，这是 issue 出于速度考虑建议的做法。否决：
`StorageAdapter` 是公开接口且所有方法都是 `async`，因此裸的同步 `db.transaction()` 抛出本来就
会以 rejection 的形式被包装层看到。对已发布的 `dist/`（两份构建）打补丁需要在每次版本升级时
重打，而当前没有任何用户可见收益。

### 已知限制

`classifyStorageFailure` 优先匹配 DOMException 的 `name`，但会回退到消息正则，而这些文案跨引擎、
跨语言环境都不是稳定 API。措辞不同的引擎消息会被当作未分类——这是安全侧的失败，应用保持原有
行为，而不会错误地锁存。

上游修复是 [loro-dev/loro-repo#129](https://github.com/loro-dev/loro-repo/pull/129)：新增
携带 `code: 'quota' | 'unavailable' | 'unknown'` 的 `RepoStorageError`，并让 `loadDoc` 不再
需要 `readwrite`。我们**刻意没有**在这里预先写 `code` 的读取逻辑：该契约仍在上游评审中、字段名
可能改变，而一个永远匹配不上的字段会变成藏在可用启发式背后的死代码。等 Lody 下次升级
loro-repo 时再优先读 `code`，那时才能配上真正能验证它的测试。

该 PR 把抛出的错误改名为 `RepoStorageError`，但保留了 message 文本和 `cause` 链。已验证对本
分类器安全：它从不与 `'Error'` 比对，并且无论如何都会遍历 `cause`。

上游还确认了 `loadDoc` 里的 `readwrite` 是有意为之而非疏漏：把读和 `delete(docId)` 拆成两个
事务会丢掉期间追加的 update。修复方案是泛化已有的 compare-then-write 辅助函数，而不是简单拆开。

## 验证

438 个文件共 3216 个 components 测试（新增 27 个，覆盖分类、cause 链遍历、环状 cause 链能终止、
读失败关闭、内层 adaptor 没有的可选方法不被对外声明，以及恢复界面的操作），91 个 Electron 测试，
27 个脚本测试，typecheck、lint、i18n、`pnpm run docs check`，以及 public/platform/code-collab
边界守卫。以上数字来自与 `main`（90c6eaf2）合并后的分支。

磁盘满这一条件是用 fixture 复现的，而非真实写满的卷；没有在耗尽磁盘的机器上做端到端手工验证。
恢复界面挂载之后才弹出的 toast 不会被清除——它们渲染在界面下方，且携带的是受控文案而非引擎
文本——所以这块界面压制的是上报的症状，而不是所有可能的 toast。
