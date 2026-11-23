# 项目子模块准备必须区分不完整仓库

Status: implemented
Type: bug-fix
Translation: current

[English](2026-10-26-project-submodule-preparation.md)

## 摘要

项目启动原先把所有本地仓库都当成完整的对象参考库，也把 `.gitmodules` 中的所有路径都当成真实子模块，导致合法的部分克隆和残留配置在 agent 启动前就阻断对话。修复后仅对支持的源仓库布局借用对象，并按索引中实际存在的 gitlink 初始化。归档也会区分未创建的空成员和独立检出的仓库，保留恢复所需的 gitlink，并保留未知内容。本次修改源码，不部署或重启应用。

## 责任与证据

所属设计见[项目组决定](../../proposed/architecture/2026-10-16-multi-repo-projects.zh.md)。本次检查的源码版本为 `274d74a724de7bfb42c6ff0685c52c0abce7d487`，也核对了已安装桌面版本使用相同的命令构造。本文不包含捕获的对话或机器记录。

### 部分克隆不是完整的对象参考库

[`project-submodules.ts`](../../../../apps/cli/src/session/worktree/project-submodules.ts) 的 `checkoutProjectSubmodule` 原先只要看到 `options.local` 为真，就添加 `--reference <repositoryPath> --dissociate`。[`worktree-manager.ts`](../../../../apps/cli/src/session/worktree/worktree-manager.ts) 的 `materializeProjectSubmodule` 仅通过 `source.kind === 'local-shared'` 决定这个值，没有检查 promisor 配置或对象完整性。提交 `b4c39aabfe10550192fb7f1fe3382998ac5ad781` 引入了这项优化。

设置了 `remote.origin.promisor=true`、`remote.origin.partialclonefilter=blob:none` 的仓库是合法的本地副本，但允许缺少对象。把它借给普通克隆作为对象库，并不会传递其 promisor 配置。`--dissociate` 只会在克隆成功后解除依赖，不能在传输和重新打包之前补齐参考库。参见 Git 的 [clone](https://git-scm.com/docs/git-clone) 和[部分克隆](https://git-scm.com/docs/partial-clone)文档。

本地合成 Git 实验比较了不使用参考库、使用完整参考库、使用无 blob 的参考库三种情况。实验先用固定随机种子生成文本历史并进行不检出文件的部分克隆，再向远端添加十个文本逐渐缩短的提交，正常执行 `git gc --aggressive`。各组使用相同的父仓 gitlink 和原生 Git 命令；文件传输不需要网络或 broker。

| 参考库 | 子模块更新 | 完整性检查 |
| --- | --- | --- |
| 不使用 | 退出码 0 | `fsck --full` 退出码 0 |
| 完整本地副本 | 退出码 0 | `fsck --full` 退出码 0 |
| `blob:none` 本地副本 | 两次克隆均报 `pack has 10 unresolved deltas` 和 `invalid index-pack output` | 检出未完成 |

参考库和远端处于相同提交时，不完整参考库会改为在解除依赖时报告缺少 blob、重新打包失败。两种情况都证明无条件启用这项优化会使本来成功的检出失败。差量包案例复现了报告中的错误机制，不依赖真实服务端、代理、并发 Git 命令或损坏的源仓库。

### 配置条目不是 gitlink

`initializeMissingProjectSubmodules` 原先从 `.gitmodules` 读取路径，检查子目录的 `.git`，然后把所有缺失路径显式传给 `git submodule update`。它没有与 Git 索引中实际存在的 `160000` 条目求交集。在合成仓库中只保留 `protocol` 配置、没有对应 gitlink，就能复现退出码 1 和 `pathspec 'protocol' did not match any file(s) known to git`。项目准备会在启动 ACP 之前等待该操作，因此这个错误会阻断整个对话。

### 空目录不是已初始化的仓库

[`project-worktree-archive.ts`](../../../../apps/cli/src/session/worktree/project-worktree-archive.ts) 原先在备份所选子模块前，只检查目录存在及其路径没有越界，没有确认该目录本身是 Git 仓库。克隆失败后，子目录可能存在但没有 `.git`。第一个备份命令 `symbolic-ref` 会向上找到父仓库，读出父仓分支；接下来的 `add -A` 报 `in unpopulated submodule`。合成的父仓库和子模块案例复现了这两个结果。重复 GC 会重复失败，无法恢复这次不完整的启动。

## 修复与所有权

- 部分克隆、浅克隆和 linked worktree 不借用对象，通过现有原生 Git 能力检查任意 promisor remote 和旧的 partial-clone 配置。使用普通克隆流程，不自动下载补齐或改写用户的源仓库。是否进一步检查不完整的 alternates 链，可另行评估；不能把任意仓库损坏都当成合法部分克隆。
- 只初始化真实存在的子模块 gitlink。忽略无对应条目的残留配置，但不吞掉真实子模块的下载、鉴权或检出错误。
- 备份前确认成员本身是已检出的仓库。区分从未成功创建的空目录和包含未知内容的目录，不通过向上发现的父仓库备份或删除未知内容。
- 对完全缺失的子成员，先确认父仓索引仍保留真实 gitlink，才能按未创建的成员处理。在父仓备份前于已验证的组内路径补空目录，避免 `git add -A` 意外提交 gitlink 删除。用户明确从索引删除 gitlink、祖先路径越界时仍报错保留。

触发点是本地源仓库检查、成员初始化和已归档会话的清理。现有项目所有者仍等所有已启动的修改结束后才释放锁，原生 Git 命令继续使用原有进程作用域并保留完整失败原因。不新增所有者、全局阻断、重试循环、凭据回退或自动重放。缺失成员已有保存分支时，先验证持久仓库；未知非空目录或未完成的检出保留整个项目供检查。归档成功时仍先发布分支记录再解除子模块初始化，恢复复用这些记录和父仓 gitlink。

对象参考检查扩展已有的原生 Effect 工作流。迁移清单中的 manager 修改、setup 和 GC 仍有未完成的 Promise 依赖，本修复保留原有所有者及已登记的 Legacy Git 边界，不声称完成更大的生命周期迁移，也不改变迁移依赖清单。

## 未选为成员的后代复用对象

未选为成员的子模块原来始终使用普通递归 clone，即使本地父仓库已经包含完整副本。
现在对应源路径也使用 `--reference` / `--dissociate`；原有远端和 gitlink 仍然决定
检出内容，不用本地 URL 替换 clone 远端。参考源必须是同一仓库的独立检出，不能经过
符号链接，也不能有 promisor 配置、浅历史或 alternates。可选源不可用或不受支持时
跳过优化；命令基础设施故障和混合 Cause 仍然传播。clone 失败仍使准备失败，保留已完成
的检出供后续重试。

每个参考只用于自己的仓库。父仓库解除对象依赖后再处理后代，已有检出保持自己的 HEAD；
此前中断后缺失的后代也会继续初始化。明确选为成员的子模块不由父仓遍历，其自身 manager
保留凭据和修改所有权。没有可用参考的缺失兄弟仍使用 Git 的四任务递归 update；使用参考
的兄弟串行处理，避免并发修改父仓 Git 配置。

未采用直接本地 clone 的对象硬链接方案：这一优化不值得在该路径引入第二种长期对象共享
方式。所选方案在创建结束后保留独立对象存储，本地对象不足时仍正常向远端获取，不承诺
离线工作或固定启动时间。借用期间源仓被删除或并发 GC 仍可能导致初始化失败；不新增
源仓全局锁或破坏性的自动清理。原有 Project 所有者等待已启动工作结束，重试检查保留的
检出，而不重置它们。

[`workspace-git-service.test.ts`](../../../../apps/cli/src/session/workspace-git-service.test.ts)
中的真实 Git 回归允许远端公布 refs，却拒绝对象包传输，证明完整本地对象确实避免传输。
它覆盖后代初始化失败及重试，再移除源对象库检查目标仓库。不可用的源布局保留普通 clone
行为。

## 验证与限制

所属的真实 Git 套件现在覆盖部分克隆成员检出且不补齐源对象、linked/shallow 源、残留配置与真实子模块共存、克隆失败后的归档和恢复、缺失备份分支、未完成的检出、未知内容、明确删除 gitlink、祖先路径越界。临时换回修复前三个生产文件后，四个主要回归案例分别出现对应的 Git 错误。

所属套件使用合成的本地仓库，不依赖真实远端或耗时阈值。性能取决于本地可用对象、远端
协商和重新打包；测试证明行为，不保证固定启动时间。这些 fixture 不构成桌面验收，也
未证明源仓并发 GC 时的恢复行为。
