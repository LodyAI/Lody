# 限制 Code Collab 文件索引并合并 Flock 本地导出

Status: implemented
Translation: current

[English](2026-11-05-code-collab-file-index-budget.md)

## 摘要

Nightly CLI 主线程持续约 100% CPU，本地 Supervisor 反复进入 reconnecting。原因是 Code Collab 文件索引重写发出了数千次单独的 Flock 提交，而 `@loro-dev/streams-crdt` 为每次提交都排队一次完整的 Wasm `exportJson`；即使第一次导出已经覆盖全部写入，后面的导出也照样执行。索引本身膨胀到一份 5.3 MB 的未压缩更新，原因有三：项目内的 `.pnpm-store` 没有被 gitignore；All Changes 没有预算；被扫描预算截断的路径被当作 `deleted` 发布。修复方案：按订阅合并本地导出，过滤包管理器缓存，并把完整的已发布索引限制在 1,000 行、估算 Flock JSON 100 KiB 以内。被截断的路径现在表示“未加载”，不再是“已删除”。代价是共享文件树变浅：超出预算的行通过 lazy 父目录按需加载。

## 问题

对受影响安装（0.110.0-nightly.3）只读诊断，发现：

- 采样中 91.2% 的 inclusive time 位于 streams-crdt 本地 drain 的 Flock `exportJson` 内（`try_version`、B 树查询），GC 与 idle 均为 0%。突发写入期间排入的 setTimeout，直到整个队列结束才执行。健康检查短暂恢复后，下一次索引写入又让它卡住。
- 一份存储的更新有 5,294,234 字节 JSON、18,180 条记录。其中 17,846 条位于 `.pnpm-store`（约占 99% 的字节），里面又有 11,229 条 `kind: 'deleted'` 业务行：这些文件实际存在，只是超出了 10,000 条扫描预算。之后一次修复报告了 21,229 条路径：预算只限制文件树，而 `buildCodeCollabFileIndexState` 会无上限地追加所有 All Changes 路径。
- 写入函数循环执行 `delete`/`set`，最后才提交一次。没有 Flock 事务或 debounce 时，每个操作都作为单独的本地事件交付，所以末尾那次 commit 并没有合并任何事件。

在独立进程里用原版适配器回放复制出的数据，得到如下单机诊断数字（不是性能保证）：

| 条件                    | 写入   | 导出  | 空导出 | 总耗时    |
| ----------------------- | -----: | ----: | -----: | --------: |
| 保存的快照，逐条事件    |  4,000 | 4,000 |  3,999 |  1,260 ms |
| V1 底层，逐条事件       |  4,000 | 4,000 |  3,999 | 15,016 ms |
| V1 底层，合并为一个事件 | 17,846 |     1 |      0 |    384 ms |

没有读取原进程的 JS 堆，因此其底层格式和精确队列长度是推断，不是观察结果。

## 决策

- **合并导出（依赖补丁）。** `patches/@loro-dev__streams-crdt@0.19.2.patch` 修改 `createFlockAdapter().subscribeLocalUpdates`：每个订阅最多只有一个待执行的导出。导出前先让出一个 macrotask（`setTimeout`），因为只让出 Promise 无法让 IPC 和定时器运行。待导出标记在同步的 Wasm 导出之前清除，所以导出期间发生的提交恰好再安排一次导出。导出进度只按实际导出的 bundle 推进。导出失败时，未导出的范围留给下一次提交；退订后不再交付，也不推进导出进度。这个补丁是临时的：上游 streams-crdt 的发布版本合并了本地导出后即可删除，并把这里的测试移植到那个版本。
- **缓存过滤。** `.pnpm-store` 加入 `CODE_COLLAB_IGNORED_DIRECTORY_NAMES`。watcher、FS fallback 和 Git 列表中的未跟踪部分都使用这份集合。Git 列表现在分别列出已跟踪和未跟踪路径，所以位于被过滤目录下的已跟踪文件仍然可见。All Changes 的未跟踪路径在读取内容之前先过滤，并且只为前 `CODE_COLLAB_FILE_INDEX_LIMITS.maxEntries` 个读取内容统计行数。
- **全面遵守项目 `.gitignore`。** 递归的 Git 列表原本就使用 `--exclude-standard`。但在 Git 工作区里，有两种情况仍会走文件系统扫描：非递归的目录刷新（Turn 结束时按变更目录刷新就是这种），以及 `git ls-files` 失败时。这类扫描会列出 `coverage/`、`.env` 之类被忽略的产物。现在文件系统扫描在遍历过程中就剪枝：`createGitIgnoreScanFilter` 用 `ignore` 包在进程内判断规则。最深一层的 `.gitignore` 优先决定（按目录懒加载），然后依次是上层目录、`info/exclude` 和 `core.excludesFile`。被忽略的条目不会被分类，不占用预算，也不会进入其子目录。对每个含有被忽略条目的目录，执行一次 `git ls-files --cached`，以保留其中含有强制添加的已跟踪文件的条目。不在 Git 工作区时，扫描根目录下的 `.gitignore` 仍会为递归扫描剪枝，这正是不剪枝时遍历代价最大的情况。否决了“扫描后再用 `git check-ignore` 过滤”的做法：那样仍会遍历被忽略的目录树，并让它们占用条目预算。watcher 的 dirty 事件现在带上相对于根目录的路径：一个防抖窗口内的路径如果全部被 Git 忽略，就不重新扫描。没有路径的事件、非 `event` 原因、超过 256 条路径，或 Git 无法回答时，仍然重新扫描。
- **全量预算（owner 于 2026-11-05 决定）。** `CODE_COLLAB_FILE_INDEX_LIMITS` 规定完整的可发布索引最多 1,000 行、估算 102,400 字节。估算计入转义后的 JSON 键、值，以及每行 113 字节的时钟与标点上界（已用真实 Flock 校准）。超出预算时按以下顺序保留：根目录子项、最近展开目录的子项、变更行（连同祖先目录），然后按广度优先。展开目录按 owner 在内存中保存最近 32 个。扫描预算同样降为 1,000。
- **删除语义。** 只有记录了 `del: true` 的变更才成为 `deleted`。Git 二进制删除和 diff-store 中已缺失的文件现在都会记录 `del`。其他不在文件树中的变更路径，作为现存的 `file` 行发布，并补上 `lazy` 祖先目录。
- **有界提交。** 发布器把写入规划成多个批次，每批不超过 100 KiB，先写 set 再写 delete。每批之后执行 flush 加 sync，以此作为屏障，让每批成为单独的一次 Streams 追加。某一批失败时进入现有的 owner 修复循环，修复循环会根据副本重新规划。

## 备选方案

- **每次写入限制 100 KiB，总量上限约 5,000 行。** owner 否决：共享状态和每次首次同步都会保持在 MB 级。只拆分传输包不能解决索引膨胀。
- **只在仓库 `.gitignore` 里加 `.pnpm-store`。** Code Collab 面向任意用户项目，产品必须有自己的缓存过滤策略。
- **全局开启 Flock debounce，或只依赖应用层批处理。** debounce 会改变其他调用方的提交语义；应用层批处理无法保护其他 Flock 写入方免受适配器逐事件导出的影响。
- **只调低 `CODE_COLLAB_LIMITS.maxSupportedFiles`。** 它不在文件索引的发布路径上，调低它什么也不会改变。

## 影响

- 共享文件树变浅。lazy 目录按需加载；即使部分子项已经存在，点击它也会重新执行 `init-directory`。如果根目录本身的子项就超出预算，没有可以标记截断的行，只会记录日志。
- 清理旧的超大索引时，tombstone 按有界批次写入，每批一次网络同步。这些 tombstone 会在流的 TTL 期间留在 Flock 历史中。
- All Changes 的 diff 统计仍计入超出读取预算的未跟踪文件，但不含行数。
- 旧 diff-store 快照为 `too_large`、如今已缺失的变更路径仍然没有 `del`，所以显示为文件。

远程 diff 的[不透明 generation 兄弟行](../architecture/2026-10-31-remote-diff-transport.zh.md)
也包含在预算内：每个变更路径预留第二个物理行和最多 64 字节编码 token 的 JSON 成本，
发布器重新签发超长 token。generation 写入及孤立行清理与文件行共用提交计划，不能绕过
完整索引或单次追加预算。

## 验证

- `apps/cli/tests/streams-crdt-flock-local-export.test.ts` 用真实 Flock 测试合并导出、定时器公平性、待导出期间的写入、失败重试和退订。它在未打补丁的适配器上会失败。
- `apps/cli/src/lib/code-collab/file-index-scan-worker.test.ts` 测试缓存过滤与已跟踪文件、1,500 个未跟踪文件涌入时仍在预算内且不伪造删除，以及有界的行数读取。
- `file-index-scan-worker.test.ts` 还测试：非递归扫描对 `.gitignore` 的处理，包括被强制添加的已跟踪文件；嵌套规则、`!` 反选、`info/exclude`、只匹配目录的规则和从子目录开始的扫描；以及非 Git 递归扫描中被忽略目录的剪枝。`code-collab-v2-service.test.ts` 测试只涉及被忽略路径的 watcher 批次不触发重新扫描；`workspace-watch-coordinator.test.ts` 测试事件路径相对于根目录。
- `apps/cli/src/lib/code-collab/code-collab-flock-publish.test.ts` 在真实 Flock 中替换一份 4,000 行、包含长路径、多字节字符和需转义字符的旧索引：每次导出的提交都不超过 102,400 字节，结果等于有界状态。
- `packages/shared/tests/code-collab.test.ts` 测试删除语义、优先顺序和字节预算。
- 未验证：原机器上打包版 Electron 的行为，以及经由真实 Streams 服务器的远端收敛。
