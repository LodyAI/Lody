# 多仓库项目组：一个主目录

Status: proposed
Type: architecture
Translation: current

[English](2026-10-16-multi-repo-projects.md)

## 摘要

一个功能经常要跨前端、后端和依赖库，同时提多个 PR。但 Lody 的对话只绑定一个仓库：
一个执行目录、一个分支，PR 发现也只针对这一个仓库。本提案引入工作区级的 Project：
新建对话时，为每个 Member 创建一个可编辑的 worktree，平铺在一个主目录下，主目录就是
Agent 的执行目录；PR 发现和“当前 PR”都改为按仓库计算。这是在评审中把最初的嵌套
布局方案简化后的结果。已声明的子模块保留嵌套关系，其他成员平铺。shared 与 daemon
实现正在评审，Agent 沙箱范围和旧客户端的呈现仍需产品验证。规范意图见[草案 Spec](../../../../specs/multi-repo-projects.zh.md)。

## 问题与要求

- 一个对话需要同时修改多个仓库，并关联所有仓库的 PR。
- 添加 Project 时不拉取内容；只在开启对话时才拉取。
- 产品负责人要求模型尽量简单：所有 Member 平铺在主目录下，并且全部可编辑。

## 代码中的“单仓库”假设

- `ProjectRef` 只有 `github | local` 两种，每个对话只有一个（`packages/shared/src/project.ts`）；
  `session/create` 也只携带一个 `project`。
- `SessionMeta` 里的 `branchName`、`repoFullName`、`isWorktree`、`workspaceDirty`、
  `workspaceUnpushed`、`diffStats` 都是单值。
- `pullRequests` 已经是一个 URL 数组，`pullRequestState` 也按 URL 作键。但 PR 调和器
  的发现键是 `(repo, branchName)`，并规定“当前 PR = 数组最后一项”；
  `session-tasklist-mapping.ts`、`archive-view.tsx` 等 UI 代码也直接取最后一项。
- Worktree 的 GC 范围是 `<data>/repos/<repo>/worktrees/<session>`，一个对话对应一个目录。

## 决策

1. **平铺。** 主目录是 `<data>/repos/project-<name>-<projectId>/worktrees/<sessionId>`，
   沿用现有 `repos/<repo>/worktrees/<session>` 的结构，以 `projectId` 为准。每个
   Member 的 worktree 放在 `<主目录>/<目录名>`。主目录是 Agent 的 cwd，本身不是 Git
   仓库，也不使用符号链接。
2. **全部可编辑。** 每个 Member 都有自己的分支，并且可能产生 PR；没有只读模式。
3. **按仓库身份去重。** 同一个仓库被重复添加时，只算一个 Member。
4. **每个 Member 独立分配分支。** 沿用现有规则：从基准引用新建分支，名字冲突时
   加后缀。不要求各仓库同名，因为某个仓库里名字被占用时，统一换名很难处理。PR 发现
   本来就按 `(仓库, 该 Member 的分支)` 进行，不依赖同名；这些 PR 同属一个功能，
   由对话本身和 PR 正文的互相链接来体现。首个任务的分支命名提示对每个 Member 分别
   生效。
5. **对话冻结 Member 列表。** 这和 Role 配置在 Operation 接受时冻结是同一个原则。
6. **只支持 Git 仓库。** 本地 Member 必须是 Git 仓库（可以没有远端），以原仓库为
   源创建 worktree，和现有的本地项目 worktree 模式一样。非 Git 目录在添加时被拒绝。
7. **原有对话不移动。** 单项目对话留在原来的位置。
8. **不设成员数上限。** 元数据体积、PR 轮询批量、物化耗时都可以分别处理：按 Member
   紧凑存储，超出预算的 PR 轮询目标留到下一批（调和器已有此行为），物化耗时只影响
   启动时间。这些都不需要靠产品上限来解决。
9. **子模块关系在创建 Project 时自动探测。** Lody 匹配 `.gitmodules` 的 URL，探测到的
   关系直接设好，用户可以取消，探测不到时也可以手动指定。子模块 Member 不单独拉取，而是由父 worktree 的
   `git submodule update --init --recursive` 检出，再从 gitlink 提交新建任务分支。
   保留这层关系主要是为了 PR 关联：先创建子模块的 PR，再创建更新指针的父 PR，并
   让父 PR 链接子 PR。
10. **子模块分支要单独保存。** 子模块的 Git 数据位于父 worktree 的管理目录中，移除父
    worktree 时会被一起删除。因此归档时先在子模块中做备份提交，并把任务分支保存到该
    仓库的持久位置，再处理父 Member；恢复时从持久位置取回。另外，`git worktree remove`
    会拒绝移除包含已初始化子模块的 worktree，需要在确认备份完成后先 deinit 子模块。

## 数据格式

以下是草案，字段名在实现时可以调整，但归属和合并语义不能变。

**Project 定义**：工作区 Flock 行 `['project', ProjectId]`。

```ts
type ProjectId = string & { __brand: 'ProjectId' }; // UUID
type ProjectMemberId = string & { __brand: 'ProjectMemberId' }; // Project 内唯一的短 ID

type WorkspaceProject = {
  v: 1;
  id: ProjectId;
  name: string;
  /** 可选的 Project 说明，注入新对话的第一轮。和 Role 的 promptPrefix 一样不设长度上限。 */
  instructions?: string;
  ownerUserId: string;
  createdAtMs: number;
  /** 内容变化时递增，和 Agent Role 的 revision 规则相同。 */
  revision: number;
  /** 数组顺序就是显示顺序；第一个 Member 用于旧字段投影。 */
  members: ProjectMember[];
};

type ProjectMember = {
  id: ProjectMemberId;
  source: ProjectMemberSource;
  placement: ProjectMemberPlacement;
};

type ProjectMemberPlacement =
  /** 平铺在主目录下；dir 是单个安全路径片段，在 Project 内唯一。 */
  | { kind: 'root'; dir: string }
  /** 父 Member 的子模块；path 是 .gitmodules 中的路径，由用户确认。可以多层嵌套。 */
  | { kind: 'submodule'; parent: ProjectMemberId; path: string };

type ProjectMemberSource =
  | { kind: 'github'; repoFullName: string; repoId?: number; baseBranch?: string }
  | { kind: 'local'; machineId: MachineId; localProjectId: LocalProjectId; baseBranch?: string };
```

去重身份：GitHub Member 为 `repoId`（未知时取小写的 `repoFullName`）；有 GitHub 远端
的本地 Member 取远端对应的 GitHub 身份；没有远端的本地 Member 为
`(machineId, localProjectId)`。删除 Project 就是删除这一行。

**对话元数据**：`SessionMeta` 增加一个可选字段，只出现在多 Member 对话上。

```ts
type SessionProjectRun = {
  id: ProjectId;
  /** 创建时的 Project 名称，Project 被删除后仍用于分组显示。 */
  name: string;
  /** 创建时冻结的 Project 说明。 */
  instructions?: string;
  /** 主目录所在的 `repos/` 子目录名，例如 `project-acme-shop-<id>`，创建时固定。 */
  root: string;
  /** 单个顶层快照：创建后只有 owner daemon 按对话串行读改写。 */
  members: Record<ProjectMemberId, SessionProjectMember>;
};

type SessionProjectMember = {
  /** 显示顺序。 */
  o: number;
  /** 冻结的快照：来源与位置。 */
  src: ProjectMemberSource;
  placement: ProjectMemberPlacement;
  /** 相对主目录的实际路径，例如 `api/proto`，由 placement 推导并固定。 */
  path: string;
  /** 创建时解析出的基准：普通 Member 为基准引用，子模块 Member 为 gitlink 提交。 */
  base: string;
  /** 以下为运行时观测，由拥有该对话的机器写入。 */
  repoFullName?: string; // 本地 Member remote 的 GitHub 身份观测
  branch?: string; // 最后一次观测到的命名分支
  dirty?: boolean;
  unpushed?: boolean;
  diff?: LineChange;
};

// SessionMeta 新增：projectRun?: SessionProjectRun;
```

`pullRequests` 和 `pullRequestState` 不变。每个仓库的当前 PR，是 `pullRequests` 中
该仓库的最后一项。PR 调和器的发现目标从 `(session, repo, branch)` 变为
`(session, memberId, repo, branch)`，状态目标仍按 PR URL。

**协议**：`session/create` 增加可选的 `projectRun`，内容是客户端在接受请求时从
Project 行冻结的 Member 列表（`id`、`dir`、`src`、`base`）。这和 Role 配置在 Operation
接受时冻结的做法相同，daemon 不再回读可变的 Project 行。daemon 在
`protocolCapabilities` 中声明 `multiRepoProject: 1` 后，客户端才发送这个字段。对话中
追加 Member 使用单独的请求，daemon 物化成功后才把新 Member 写入 `members`。

**磁盘**：普通 Member 在 `<data>/repos/<root>/worktrees/<sessionId>/<dir>/`，子模块
Member 在父 Member 路径下的子模块路径。`<root>` 中的名称片段是
Project 名称经过小写化、只保留 `[a-z0-9-]` 并截断到 32 个字符的结果，为空时用
`project`。每个 Member 的 Git worktree 登记在它自己的仓库中；Git 根据检出目录名
分配内部登记名，必要时加后缀。Lody 使用冻结目录和分支识别 Member，不依赖内部登记名。

## 路径依赖调研（为将来支持本地目录做准备）

将来如果通过 `additionalDirectories` 支持主目录之外的本地目录，一个对话就会有多个文件
根目录。目前凡是涉及文件的功能，都假设只有一个会话工作区根目录，路径用相对这个根目录
的形式表示：

| 位置 | 现在的行为 | 根目录之外的路径 |
| --- | --- | --- |
| Code Collab 文件 RPC（`code-collab-v2-service.ts`） | 绝对路径只有落在工作区根目录内，才会转成相对路径 | 返回 `invalid_path` |
| 文件索引 Flock（`<ws>:fi:<session>`） | 每个路径一行，键是相对工作区的路径；监听器拒绝绝对路径和 `..`（`workspace-watch-path-policy.ts`） | 无法表示 |
| 本轮 diff（`code-collab-v2-diff-evidence.ts`） | `normalizeRelativePath` 只保留根目录内的路径 | 静默丢弃，本轮 diff 里看不到 |
| 文件预览（`file-preview-path-policy.ts`） | 工作区根目录加固定的几个额外目录 | `path_not_allowed` |
| Agent 输出的文件（`message-handler.ts`） | `resource_link` 必须在工作区内；历史里**有意**只保存相对路径，以免发布主机路径 | 被拒绝 |
| 桌面端的 Markdown 链接与本地文件路径 | 只对已知工作区根目录下的路径做相对化，绝对路径由根目录加相对路径拼出 | 当作外部路径处理 |
| 文件索引与 All Changes（`file-index-scan-core.ts`） | 只有 `isInsideGitWorktree(root)` 为真才用 `git ls-files` 和 Git diff 基准 | 不适用 |

文件监听协议已经支持多个根目录（`replace-roots` 携带 `roots: string[]`），其余地方都
只认一个根目录。

**这份调研还发现了一个现在就要处理的问题。** 平铺布局下，主目录本身不是 Git 仓库，
`isInsideGitWorktree(主目录)` 为假。于是文件索引会退回到普通文件系统扫描，而这种扫描
只按固定名单（`node_modules`、`dist` 等）忽略，不读 `.gitignore`；All Changes 也会改用
非 Git 的快照重建，而不是各 Member 自己的 Git diff。所以第二阶段必须让文件索引和 All
Changes 按 Member 分别使用 Git。这件事和将来是否支持本地目录无关。

**决定：同步数据不改用绝对路径，改用“根目录 + 相对路径”。** 曾考虑过把所有路径都
改成绝对路径，但历史记录有意不发布主机路径；同步的 Flock 键如果用绝对路径，会带上
用户名和主目录位置，在另一台机器上也没有意义。产品负责人已在评审中采纳以下做法：

- 对话持有一个有序的根目录列表 `{ id, absolutePath }`，只有拥有该对话的机器知道绝对
  路径。主目录是 `id = 'main'` 的根目录，将来的额外目录各占一个 id。
- 同步数据中的路径标识是 `(rootId, relativePath)`。主目录下的路径继续使用现在的纯
  相对路径字符串，旧数据和旧客户端不受影响；只有其他根目录下的路径才需要带 `rootId`。
- 机器边界（RPC 输入、ACP 给出的路径、预览和附件的检查）接受绝对路径，并统一交给一个
  解析函数：按最长前缀匹配到某个根目录，得到 `(rootId, relativePath)`；不在任何根目录
  下就拒绝。
- 现在就可以做的准备：把上表中各处的包含检查都改为调用这一个解析函数，目前只传入一个
  根目录。将来支持本地目录时，只需要多注册几个根目录。

## 备选方案

- **显式布局森林（顶层、嵌套、子模块），外加 edit/read 两种参与方式。** 这是第一版
  提案，能保留磁盘上的原有结构，也能避免只读依赖产生分支。但 Git 行为、归档顺序和 UI
  都更复杂，评审时被要求简化，因此改为平铺、全部可编辑。将来如果嵌套关系确实成为
  阻碍，可以在平铺之上再加回去。
- **子模块也平铺成独立 Member，父仓库里的子模块路径不初始化。** 曾作为上一版方案。
  否决：Agent 可能在父仓库里再初始化一份子模块并改错副本，父仓库在 worktree 里看不到
  子模块的改动，指针更新完全依赖提示。
- **共同父目录 + 符号链接。** 否决。工具解析 realpath 后会跳出根目录，沙箱的可写范围
  也会变得不确定。
- **Project 只作为侧边栏分组，每个仓库仍是一个独立对话。** 做不到“一个对话关联所有 PR”。
- **非 Git 本地目录通过符号链接加入主目录。** 否决。链接指向原目录，Agent 会直接修改
  用户的原始文件，同一个 Project 的并发对话会互相覆盖，也没有分支和备份提交。按真实
  路径判断的沙箱可能拦截写入；ripgrep 和文件索引默认不跟随符号链接；归档清理一旦跟随
  链接，就会删除用户目录。而且这类目录本来就没有 PR。
- **非 Git 目录直接引用原路径。** 暂缓。主目录里不放这个目录，只把它的绝对路径告诉
  Agent，并通过 ACP 的 `additionalDirectories` 加入 Provider 的可访问范围。这相当于
  现有单项目“直接使用原目录”模式的多目录版本，没有隔离。目前大多数 ACP 适配器还没有
  实现 `additionalDirectories`，等普遍支持后再引入。
- **非 Git 目录使用影子仓库。** 暂缓。Lody 在数据目录下建一个私有仓库，以原目录为
  工作区做快照提交，再从它创建 worktree；对话结束后，经用户确认以快照为基准合并
  回原目录。这样能保持隔离，并复用 worktree 的生命周期，但首次快照、默认忽略规则和
  写回冲突都需要额外设计，现在没有足够的需求支撑。
- **复制目录，或使用 overlay 挂载。** 否决。复制的改动只能手动拷回；overlay 只在
  Linux 上可用，并且需要特权。

## 建议分期

1. Project 的定义（含说明、子模块自动探测）与侧边栏分组；现有项目作为隐式的单 Member
   Project。把各处的路径包含检查收敛到同一个根目录解析函数。
2. 多 Member 对话（本地 Member）：平铺物化、子模块 Member、按 Member 观测分支和状态、
   按 Member 使用 Git 的文件索引和 All Changes、按仓库发现 PR、Info Bar 显示 PR 列表、
   Create PR 互链 PR，并加入协议能力协商。
3. 托管 GitHub Member、预创建 worktree、Schedule 指向 Project。

## 验证边界

这份提案只基于阅读代码和现有 Spec，没有原型和测试。需要实测：各 Agent 沙箱对主目录
外 `.git` common dir 的写权限、多 Member 元数据的大小、旧桌面端看到多 PR 对话时
的显示，以及子模块相关的 Git 行为：worktree 中子模块 Git 数据的位置、包含子模块的
worktree 的移除、SSH 子模块 URL 与托管凭证的配合，以及本地父仓库能否复用原仓库已有的
子模块数据来避免联网拉取。


## Shared 契约实现

第一部分实现在 `packages/shared/src/workspace-project.ts` 导出 `WorkspaceProject`、
`SessionProjectRun` 及上文的 Member 类型。工作区 Flock 归一化 `project` 行，并提供
list/write/delete 函数。定义与运行快照 schema 拒绝不安全的跨平台路径、重复仓库身份、
不存在的父成员、循环引用和兄弟成员路径重叠。运行快照至少包含两个 Member；普通单仓库
对话沿用原契约。创建请求使用完整 `SessionProjectRun`（包括 placement），而非上文的
简略字段清单。daemon 必须解析并验证 `base`（尤其是子模块 gitlink），不能信任客户端
携带的运行时观测字段。

`deduplicateProjectMembers` 接受机器提供的本地仓库到 GitHub 身份解析函数。
数字 ID 优先；仅有名称的别名在已知 ID 无歧义时使用该 ID。冲突的数字 ID 不按名称合并。
`getCurrentPullRequestsByRepository` 按输入顺序返回各仓库最后一个有效 GitHub PR。
`resolveSessionFilePath` 是跨平台的最长根目录词法解析器；磁盘调用方仍须检查 realpath
以拒绝符号链接逃逸。绝对根目录只留在本机。

已定义并可协商 `multiRepoProject: 1`，但物化与生命周期实现完成前，不加入 daemon 的
当前能力广告。此契约部分不会让现有 daemon 开启多仓库创建。运行时实现、owner 串行写入元数据和生命周期行为仍待验证。

契约 PR：[#1641](https://github.com/LodyAI/Lody/pull/1641)。


## 运行时存储发现与 worktree 基础能力

当前锁定的 `loro-repo` **不会**把嵌套元数据 Record 转成 Loro map：
`MetadataManager.upsert` 将每个顶层键写入单个 Flock 值 `['m', docId, key]`。
产品负责人已确定单一写入方方案：`projectRun` 保持 SessionMeta 上的单个顶层值。
客户端只在创建对话时随 session/create 元数据写入初始快照。此后只有拥有该对话的
daemon 写入，成员状态观测、中途追加成员和旧字段投影均复用分支观测的 owner 串行链，
按对话执行读取、修改、写回。因此不依赖嵌套 Record 合并，不改上游 loro-repo，
也不单独存成员行。如果将来出现第二个写入方，必须改为每个成员单独一行。
代码类型名保持不变；面向用户与 Agent 首轮注入的概念名称为「项目组」，
「项目」仍指单个本地文件夹或 GitHub 仓库。

worktree 准备性改动为 WorktreeManager 增加显式冻结的 Project 位置。
仓库存储与锁仍以 repoId 为键；带位置的实例不进入仅按 repoId 的全局缓存。
原生观测使用同一个 Member 目录后缀。不同对话重复使用 Member 目录名时，Git 可能
为内部管理目录名加后缀；Member 通过目录与分支识别，不依赖内部名称。这修正了上文
“Git 登记名总是 sessionId”的假设。

子模块基础函数组合现有原生 WorktreeGit 服务，检出前验证 `.gitmodules` 与实际
gitlink，递归初始化，从 gitlink 创建分支，并在 deinit 前通过本地 fetch 将备份分支
保存到持久仓库；恢复时取回该分支。非快进保存和仓库身份不符均失败保留。
这些函数已有真实 Git 测试；下文运行时编排将其接入物化与 GC。

Project mutation owner 由冻结创建/恢复快照触发，串行处理同一 Project
对话的变更，失败时保留部分目录和分支记录，原始 Git 进程清理完成后才能交接。
WorktreeGit 已拥有命令取消和清理；现有 manager/setup/GC 编排仍基于 Promise。
整个 manager 迁移会拉入未完成的依赖，因此暂缓。新增原生子模块叶子函数不代表该迁移
完成。测试验证本地 Git 的检出、备份、恢复、多 Member 观测和稳定分支记录；真实托管凭据
不在确定性的本地测试范围内。

Worktree 基础能力 PR：[ #1642](https://github.com/LodyAI/Lody/pull/1642)。


## Owner 串行与运行时接入

拥有该对话的 daemon 在同一 document manager、同一 owner Session 的服务实例间共享
WorkspaceGitService 队列。读取发生在取得队列之后；失败不会阻断后续恢复。
物化逐个发布成功成员的分支，再处理下一成员，因此后续失败保留目录与分支记录。
观测在各成员 Git 目录执行，并将快照与旧字段投影一起发布。未知观测保留已有事实；
detached HEAD 保留最后一个命名分支。Child Tab 写入 owner。外层 session/setup/GC
编排仍基于 Promise，不声称完成原生生命周期迁移；WorktreeGit 仍拥有进程释放。

Session 启动使用冻结的项目组目录，首轮提示称为「Project group / 项目组」。
ACP originProjectPath 指向稳定的项目组目录。归档/GC、PR 调和和按成员文件索引接入后，
运行时声明 `multiRepoProject: 1`。


本地 Member 的 GitHub PR 发现需要持久的机器观测仓库身份，避免 PR 调和器扫描元数据时
逐个打开 Git。`SessionProjectMember` 新增可选 `repoFullName`，由 owner 从 Member remote
观测写入；这是向后兼容的增量字段，`src` 仍保留冻结的本地绑定。创建请求不能提供权威的
观测身份；PR 发现仍要求 Member 的观测分支，并在写回前重新校验仓库身份与分支。


运行时归档在移除任何 root 前先完成所有成员备份。子模块分支先保存到持久仓库，父成员
随后记录新的 gitlink。恢复从持久仓库取得子模块对象，包括远端没有的提交，并保留原始
基准。Git 即使在 deinit 后仍要求强制移除 worktree；manager 先验证已保存的分支、干净的
工作区和已 deinit 的子模块。未选中子模块的新提交没有 Member 持久存储，或任一仓库无法
解析时，保留整个项目组。成员外的主目录文件不递归删除；可从冻结 blob 重建的
`.lody/attachments` 副本可在备份后移除。

PR 发现目标与闲置指纹包含 Member ID，写回前用最新元数据重新校验同一成员的仓库和
分支，当前 PR 排序只在各自仓库内进行。文件索引 worker 对各 Member 使用 Git，并为相对
路径添加 Member 前缀；All Changes 为每个 Member 固定独立的 merge base。Code Collab、
预览、ACP diff 证据和上传包含检查共用 `resolveSessionFilePath`，文件系统边界保留
realpath 校验。POSIX 反斜杠保持字面字符，避免相邻目录冒充子路径。UI 组件和桌面呈现
仍由独立的 UI session 负责。

中途追加成员的公开请求仍是后续工作：本次契约尚未定义其 RPC 格式。后续请求必须经同一
owner 队列物化并发布，客户端不得在创建后替换快照。真实托管凭据和 UI 端到端验收
不在确定性本地 Git 测试的覆盖范围内。

验证：CLI 类型检查和 `check:quick` 通过；PR 调和套件 101 项通过。最终
session/owner/prompt/Git transport 回归 74 项通过，含全部三种项目组生命周期布局；
一个原生 SSH 凭据测试报 `context_unreadable`。全仓检查未全绿，UI 与真实凭据验收仍待完成。

运行时接入 PR：[#1644](https://github.com/LodyAI/Lody/pull/1644)。

## UI/daemon 交接

`buildSessionProjectRun(project, selectedMemberIds)` 按定义顺序冻结 source、placement、path、
root 和 instructions。`selectProjectMembers` 递归去除未选中父成员的后代，未知 ID 报错。
过滤后不足两个成员返回 `undefined`，调用方走现有单仓库流程（零成员禁用创建）。
root 的 base 使用 `baseBranch ?? 'HEAD'`；子模块使用 `PROJECT_SUBMODULE_BASE = 'gitlink'`。
owner 在发布物化回执前将 root 占位值改为基线引用、子模块占位值改为提交 ID；root HEAD 对应本地当前分支或
GitHub 默认分支。显式 baseBranch 保留原值。单成员回退不携带 `projectRun`。

machine RPC `project/probe-local-member` 的 params 为 `{ localProjectId }`，外层携带标准
machineId/workspaceId。result 含 type `project/probe-local-member`、可选 repoFullName 和
`submodules: { path, url, repoFullName? }[]`，保留标准 `{ ok, result }` 外壳。仅探测当前
工作区/机器已注册成员，拒绝 session-scoped 调用；读取工作树 `.gitmodules`，不展开 include，
不 fetch/init/sync、不改 Git config。忽略非法子模块路径，拒绝不安全或过大的配置。
本地绝对路径和 file URL 脱敏为 `url: ''`，不返回主机根路径和 Git 错误细节；不猜测此类
URL 的 GitHub 身份，UI 可以保留其关系为未确认。

shared `getProjectRepositoryFullName` 解析 GitHub HTTPS/SSH/SCP 及相对父仓库 URL；
`matchProjectSubmoduleMember` 匹配 GitHub 成员或机器解析出的本地成员身份，歧义时不匹配。
daemon 的 gitlink 校验共用 `projectRepositoryUrlIdentity` 规范化。创建入口保持
`session/create`，project 是首个选中成员的投影，projectRun 仅在
`machineSupportsMultiRepoProject` 为真时发送。

探测由已认证 machine RPC 触发和拥有；有限的原生 Effect 工作流使用 WorktreeGit/FileSystem，
等待命令释放，不保留后台状态。既有 Legacy 入口衔接 Promise dispatcher；失败返回不含路径的
错误，重试重新读取。此次不宣称完成 dispatcher 的 Effect 迁移。

远程机器通过 Streams 提供同名方法：
`LoroStreamsMachineRpcClient.requestProjectProbeLocalMember({ localProjectId, requestedByUserId, timeoutMs? })`
返回 typed result，传输/处理失败返回 null；daemon 探测前校验机器/项目访问权限。
本地 IPC 沿用已认证 machine RPC 外壳。

root HEAD 回执保留命名基线引用，避免 PR 基线变成 SHA；本地 detached HEAD 或恢复时没有
基线回执才固定提交。GitHub HEAD 读取当前远端符号 HEAD，不优先 main 或缓存中的旧默认分支。
验证覆盖 shared 37 项、Streams 124 项、RPC 范围 13 项、Git/owner 12 项，以及远端基线
2 项（含默认分支变化）。全工作区类型检查、check:quick、format、docs check 已通过；
全仓测试另行记录。


shared `withProjectGroupPrScope(prompt)` 将创建 PR 或 Commit & Push 操作应用到成员仓库，
保留请求的操作及 draft 状态，先发布子模块再发布父仓库 gitlink，取得所有 URL 后在各 PR 正文
互相链接。单独 Commit & Push 不开 PR；子模块发布失败时，不发布指向未发布提交的父仓库指针。
成员目录使用首轮清单，项目组主目录本身不是 Git 仓库。
本地成员身份观测字段最终仍为 `SessionProjectMember.repoFullName?: string`；
UI 中读取 `repo` 的代码须改为 `repoFullName`，不新增同义存储字段。

初始 GitHub `project` 投影须用 `branch: baseBranch ?? 'HEAD'`，既有 `ProjectRefSchema`
不接受空字符串 branch。本地投影继续使用 `useWorktree: true`。
