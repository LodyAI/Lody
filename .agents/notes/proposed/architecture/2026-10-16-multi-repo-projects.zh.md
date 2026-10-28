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
布局方案简化后的结果。已声明的子模块保留嵌套关系，其他成员平铺。有 GitHub 远端的
本地文件夹以仓库 Member 加入，在任何有它副本的机器上都能运行；只有没有远端的文件夹
才把 Project 绑定到一台机器。shared 与 daemon
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
  /** preferLocal：仓库 Member，见「修订：仓库 Member」。 */
  | { kind: 'github'; repoFullName: string; repoId?: number; baseBranch?: string; preferLocal?: true }
  /** 绑定机器：没有 GitHub 远端的文件夹，或者非 Git 目录。 */
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

| 位置                                                | 现在的行为                                                                                        | 根目录之外的路径             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| Code Collab 文件 RPC（`code-collab-v2-service.ts`） | 绝对路径只有落在工作区根目录内，才会转成相对路径                                                  | 返回 `invalid_path`          |
| 文件索引 Flock（`<ws>:fi:<session>`）               | 每个路径一行，键是相对工作区的路径；监听器拒绝绝对路径和 `..`（`workspace-watch-path-policy.ts`） | 无法表示                     |
| 本轮 diff（`code-collab-v2-diff-evidence.ts`）      | `normalizeRelativePath` 只保留根目录内的路径                                                      | 静默丢弃，本轮 diff 里看不到 |
| 文件预览（`file-preview-path-policy.ts`）           | 工作区根目录加固定的几个额外目录                                                                  | `path_not_allowed`           |
| Agent 输出的文件（`message-handler.ts`）            | `resource_link` 必须在工作区内；历史里**有意**只保存相对路径，以免发布主机路径                    | 被拒绝                       |
| 桌面端的 Markdown 链接与本地文件路径                | 只对已知工作区根目录下的路径做相对化，绝对路径由根目录加相对路径拼出                              | 当作外部路径处理             |
| 文件索引与 All Changes（`file-index-scan-core.ts`） | 只有 `isInsideGitWorktree(root)` 为真才用 `git ls-files` 和 Git diff 基准                         | 不适用                       |

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

## UI 实现

界面上它就是包含多个仓库或文件夹的项目（见下文「修订：只保留项目一个概念」）；代码中的
类型名不变。

- **设置 → 项目**：添加菜单中的「多个仓库或文件夹」打开编辑器，多仓库项目在这里也是项目
  行，摆放规则和侧边栏一致。编辑器写入工作区目录文档，
  本地持久即视为保存完成，上传不等待、不报告。成员列表按目录嵌套顺序排列，本身就是对话
  主目录的布局预览。GitHub 成员的 `.gitmodules` 由 UI 通过 GitHub API 读取并自动设定子
  模块关系；本地成员等待 daemon 提供只读探测 RPC。自动探测只会改动默认或探测得到的位置，
  不会覆盖用户手动设定的位置；会形成环的探测结果被丢弃。只有创建者可以编辑或删除。
- **侧边栏**：多仓库项目就是一行项目。含绑定机器成员的放在那台机器下、它的文件夹之后；
  不含的放在 GitHub Worktrees 下。已定义的项目即使没有对话也会列出，
  以便从这里开始对话；已删除项目组的对话按快照里的名称继续分组。带 `projectRun` 的对话
  不再出现在第一个成员对应的本地项目或 GitHub 分组里。项目组的行和本地项目行一致：悬停时
  图标变为折叠箭头，点击行开始对话，悬停按钮依次是 ⋯（编辑项目组、归档对话）、新建对话和
  拖拽手柄；顺序按工作区保存，和本地项目一样。机器折叠时，它的状态标记也计入其中多仓库
  项目的对话。在「最近更新」视图和置顶列表中，这些对话带有项目图标和名称。
- **新对话**：项目组叠加在普通 chat 上下文之上，原有的本地/GitHub 逻辑和移动端视图不变。
  选中项目组后，本地成员所在的机器决定执行机器；对话总是按项目组配置使用全部成员，
  composer 只以只读方式列出成员（子模块反正会由父成员检出，需要不同组合应修改项目组设置）。
  只有一个成员的项目组按普通单项目对话创建。daemon 未声明 `multiRepoProject` 时阻止
  提交并提示更新。
- **Info Bar**：新增「仓库」按钮（不占舞台），按快照顺序列出每个仓库的路径、分支、未提交
  /未推送状态、当前 PR 和 CI。上下文舞台只显示第一个成员自己仓库的当前 PR。

尚未完成：本地成员的子模块探测与仓库身份（依赖 daemon 字段）、项目组版本的 Create PR
提示词、移动端入口。UI 只在 Storybook 和单元测试中验证，尚未在真实 daemon 上端到端运行。

## 修订：非 Git 成员与多根目录

这一节修订「备选方案」中把非 Git 目录列为暂缓的结论。产品负责人正在为更多 ACP
Provider 实现 `additionalDirectories`，并且 Lody 自带的 Claude、Codex 适配器已经支持
（`packages/acp-extension-codex/src/CodexAcpClient.ts` 的 `readAdditionalDirectories`），
因此现在引入非 Git 成员：

- **接入方式由 daemon 在物化时决定**：Git 成员（GitHub 或本地）始终用 worktree；非 Git
  成员在 Provider 声明支持 `additionalDirectories` 时作为额外目录传入，否则在主目录下建
  软链接（Windows 用 junction）。
- **软链接的边界**：此前否决软链接的理由逐条有了对应措施。写权限由额外目录或全权限模式
  保证，而不是靠链接本身；索引和监听按注册的根目录工作，不依赖跟随链接；清理只删除链接、
  不递归进入目标；链接目标只从本地项目注册表解析，被改动时重建。
- **不隔离是有意的取舍**：和现有单项目「直接使用原目录」模式一样，非 Git 成员直接修改
  原目录，没有分支、备份和 PR，界面需要明确说明。

**多根目录的文件能力**：调研发现，同机 Electron 预览已经能只读打开任意路径，但远程预览、
编辑保存、LSP、文件树、All Changes、`@` 搜索、每轮 diff 和 Agent 输出文件都只认单一
工作区根目录（见「路径依赖调研」）。只开放额外目录而不改这些地方，用户会看到 Agent 改了
文件，却无法在 Lody 中编辑、搜索或在 diff 里看到修改。因此一并按 `(rootId, relativePath)`
把这些能力扩展到所有根目录：授权先解析真实路径再比对已注册的根目录，主目录的纯相对路径
格式保持不变。

**分工**：根目录注册、授权、索引、监听和 diff 的 daemon 侧由逻辑 session 实现；文件树
按根目录分组、`@` 搜索和按 `rootId` 打开文件由 UI session 实现。两侧均尚未实现或验证。

## 多根目录文件契约

契约分支 `multi-repo-extra-roots-contracts`：`access?: 'worktree' | 'additional' | 'link'`
只由 daemon 写入。`MAIN_SESSION_FILE_ROOT_ID` 为 `main`，`getProjectMemberRootId(id)`
生成 `member:<id>`，`parseProjectMemberRootId` 反向解析；`SessionFileRootIdSchema` 校验 RPC。
文件类 RPC 的 `rootId` 可选，缺省表示 main；远程内容仍在原有加密外壳中。

同步字符串由 `encodeSessionFilePath` / `decodeSessionFilePath` 编解码。main 保持纯相对路径；
其他根目录使用 `\u0000lody-root:member:<id>/<relativePath>`（开头是实际 NUL，不是六个转义字符）。
NUL 不能出现在真实文件名中，因此不与主目录的任何真实文件名冲突，也不保留成员同名目录。
这是同步数据的键，不能直接交给文件系统、URL 或终端；必须先解码、查本机注册表，再做 realpath
授权。文件索引行、每轮 diff 路径和附件 sourcePath 共用这一个编码。旧客户端不能操作此类新键；
不宣称它们兼容额外根目录。RPC 始终用分离的 rootId 和相对路径，不发送编码后的键。

探测结果增加 `isGit: boolean`；旧 daemon 的成功探测仅可能是 Git，解析旧结果时默认 true。
本提交只提供契约及 Git 探测字段，非 Git 探测、物化、授权和完整文件能力在后续 runtime PR 实现。

## 多根目录 daemon 接入

`multi-repo-extra-roots-runtime` 叠在契约分支之上。非 Git 接入和根目录文件请求须使用
`machineSupportsProjectFileRoots`，对应 `projectFileRoots: 1`；旧的 `multiRepoProject: 1`
只证明支持 Git 项目组，不能据此开放非 Git 成员。

本机注册表是唯一根目录来源。物化只对 Git 成员分配分支；非 Git 成员在 ACP 初始化前注册
额外目录，随后在每次启动的实际 `sessionCapabilities.additionalDirectories` 声明后，由
owner 串行链发布 `additional` 或 `link`。支持时把真实目录传入 ACP 生命周期请求；否则
重建链接（Windows 为 junction）。链接模式遇到真实同名条目会拒绝接入并保留条目；额外目录模式不占用该名称。
首轮清单说明「不隔离」，并仅在运行时给 Agent 提供额外目录的真实路径，不存入同步元数据。

文件读取每次重新解析注册表与 realpath；链接变化从注册表修复，不能扩大授权。缺失或不可读
成员只使该根目录不可用，其他根目录仍可读；启动必须具备所有选中成员。预览不激活索引。
编辑请求按根目录选择现有服务状态，所有根目录共用物理文件保存串行链；索引发布按 owner
串行合并各根目录快照，监听订阅带根目录身份，防止后一个根目录替换前一个订阅。主目录保持
按 Git Member 扫描；非 Git 根目录使用已有文件系统扫描与 diff 快照。LSP 既有后端尚未接线，
所有根目录保留 `lsp_not_wired`，但请求先做同样的根目录授权。

每轮证据、Agent 输出资源及附件来源使用统一根目录解析。快照库的局部键禁用 NUL，CLI 在
存储边界把非主目录键转换为 `/lody-roots/member:<id>/<relativePath>` 并在返回时还原；
前导斜杠不可能与既有纯相对键冲突，该局部键绝不作为磁盘路径使用，不改上游存储库。
归档跳过非 Git 备份，unlink 已知成员链接，检查残留软链接后才清理主目录；目标缺失不阻止
unlink，真实条目或未知链接保留供处理，不递归进入目标。

原生 Effect 探测保留 Git 失败分类，仅正常的「不在 Git 仓库」得到 isGit=false；损坏仓库、
权限和进程清理失败仍上报。接入与发布沿用既有 Promise 会话 owner，不引入第二个后台 owner
或扩大 Effect 迁移；根目录工具只完成有限文件系统操作，无常驻资源。失败保留已发布状态与
目录以便重试；单根目录读取失败不会禁止其他根目录使用。验证以临时目录、实际 Git 和假
Provider 边界为主；真实 Provider、Windows junction 与 UI 端到端仍需跨平台验收。

## 多根目录的 UI 实现

UI 不新增路径格式，而是把额外根目录「挂载」在成员目录名下：文件索引和 All Changes 里的
编码键（`\0lody-root:member:<id>/…`）在文件提供器入口被翻译成 `<成员目录>/…`，对话 diff
面板对历史里的编码键做同样的翻译；所有文件请求在运行时适配层再拆回 `rootId` 和相对路径
（`packages/components/src/lib/session-file-root-mounts.ts`）。因此文件树、`@` 搜索、
打开、编辑保存和 diff 都不需要各自了解根目录。以额外目录接入时 daemon 不在主目录保留成员名，
真实主目录条目可能与之同名；此时文件树在该路径下显示成员根目录的文件，请求也发往成员根目录。快照中不再挂载的根目录显示为 `member-<id>/…`，不会露出 NUL。

带成员 `rootId` 的预览不走 Electron 本机快速路径：那条路径按主目录解析相对路径，会读到
别的文件；这类请求一律交给机器解析。编辑器把非 Git 成员标为「直接修改原目录」，并且不允许
它成为子模块或子模块的父成员；Info Bar 的仓库列表对这类成员显示「原目录 · 不隔离」。
UI 只在快照记录了 `access: 'additional' | 'link'` 时挂载根目录，而只有支持 `projectFileRoots` 的 daemon（#1674）才会写这个字段，因此旧 daemon 不会产生挂载。以上仅在单元测试和类型检查中验证，未端到端运行。

## 修订：仓库 Member

**问题。** 从本地文件夹加入的 Member 记录为 `(machineId, localProjectId)`。因此编辑器
把一个仓库在每台机器上的副本都列成单独一行（三台机器的工作区里 `lody` 出现三次）；
选了一个本地 Member 之后，又把其他机器的文件夹全部置灰，每行重复同一句很长的原因。
机器一多，大部分行都是灰的。用户想的是「这个仓库」，而不是「那台机器上的副本」；
而且绑定到一台机器的项目组，换到另一台有同样仓库的机器上也无法使用。

**决策**（产品负责人看过示意图后确认）：

- 已知 GitHub 远端的本地文件夹以**仓库 Member** 加入，即
  `{ kind: 'github', repoFullName, preferLocal: true }`。只有没有 GitHub 远端的本地
  仓库和非 Git 目录仍是绑定机器的 `local` 来源。Project 的执行机器由它绑定机器的
  Member 决定（`getProjectBoundMachineId`）；没有这类 Member 的 Project 可以在任意
  机器上运行。
- **物化。** Daemon 在自己的机器上找远端是该仓库的本地项目，取最近打开的一个
  （`pickProjectRepositoryLocalCopy`），并重新观测这个文件夹的远端，而不是信任已发布
  的值。worktree 从这份副本创建，使用本机凭证，和本地 Member 完全一样。没有副本时，
  托管部署像 GitHub Member 一样 clone；纯本地模式不 clone，而是报告这个 Member 在这台
  机器上不可用。
- **发布。** `LocalProjectMeta.githubRepoFullName` 由拥有该项目的 daemon 根据文件夹
  的远端写入。规范化时丢弃格式错误的值，而不是拒绝整行项目。客户端用它把多份副本
  合并成选择器里的一行，并在不逐个探测文件夹的情况下说明哪些机器能运行某个 Project。
- **兼容。** `projectRepositoryMembers: 1` 控制含仓库 Member 的 Project 能否开始；
  契约分支声明检查函数，daemon 分支负责声明该能力。`preferLocal` 是可选字段，旧客户端
  把它读成普通 GitHub Member；旧客户端重新保存时会丢掉这个字段（它的 Zod 对象会剥离
  未知键），这个 Member 退化为托管 clone。已保存的 Project 不会在后台被改写：下次
  在编辑器里保存时，所在机器发布了远端的本地 Member 才会被转换，ID、目录和子模块位置
  保持不变。

**备选方案。**

- *每个 Project 显式指定一台机器，选择器只显示这台机器。* 改动最小，但项目组在其他
  有同样仓库的机器上仍然用不了，而且在一台机器的视图里，GitHub 和本地副本仍会重复。
- *保留按机器的行，只按机器分组。* 噪音更少，但每个仓库仍按机器各出现一次，仍把项目组
  绑定到一台机器。
- *新增来源类型 `repo`。* 代码上更清楚，但旧客户端的可辨识联合会拒绝整行 Project；
  可选字段则能降级。

**UI。**

- *编辑器选择器。* 每个仓库一行：GitHub 仓库缓存与发布了远端的本地项目合并，以小写
  仓库名为键。分组为「仓库」「本机目录」「其他机器的目录」。只在 GitHub 上的仓库在
  用户搜索前不列出（已选中的除外），所以仓库再多也不会把本地行挤出视野；列表末尾提示
  「另有 N 个 GitHub 仓库，输入名称搜索」。搜索框下面有一排来源筛选（全部、仓库、本机、
  各台机器），沿用 iOS 模拟器选择器的做法。项目组已有绑定机器的 Member 时，其他机器的
  目录置灰，原因只在该组标题下说一次，不逐行重复。
- *Composer。* 和单个项目一样先选机器：绑定到其他机器的项目组不列出，选择项目组从不
  切换机器。没有绑定机器 Member 的项目组在每台机器上都列出，并说明在这台机器上的可用
  情况，其成员列表标出这台机器缺少的仓库 Member。纯本地模式下这样的项目组在这台机器上
  显示为不可用，因为对话总是使用整个项目组。

**分工。** 本分支包含 Spec、本节和 shared 契约。逻辑 session 实现 daemon：在添加项目
和启动时发布 `githubRepoFullName`；从本地副本用本机凭证物化仓库 Member（否则回退到
托管 clone，纯本地模式报告不可用）；把提示词清单和 PR 观测扩展到副本使用的凭证；声明
该能力。UI session 实现选择器、编辑器迁移和 composer 过滤。契约分支验证了 shared 契约；daemon 验证见下文。

**Daemon 集成**（[PR #1682](https://github.com/LodyAI/Lody/pull/1682)）。添加项目及启动时发布 `githubRepoFullName`，其他行写入保留该字段。
物化时按排序重新观测本机副本、拒绝重复身份并使用原生认证；缺少副本时通过托管克隆回退，
否则报 `project_repository_not_on_machine`。新增由所有者写入的
`SessionProjectMember.repositoryCheckout` 回执，在创建分支前固定 `{ kind: 'github' }`
或 `{ kind: 'local', machineId, localProjectId }`，不含主机路径。重试及归档恢复保留该
存储位置而不重新选择副本；本地副本将分支保存到原仓库，并保留 `src.repoFullName` 作为
PR 身份。混合运行时在现有凭据租约内冻结原生仓库列表；主机 Git、Shell Git/gh 和 PR
轮询按成员选择认证，同一仓库的原生与托管查询也分批处理。提示词清单标明本地副本，daemon
宣告 `projectRepositoryMembers: 1`。真实临时 Git 仓库和假的提供方边界测试覆盖副本选择、
过时或缺失副本、重复拒绝、发布与保留、凭据以及根仓库和子模块归档恢复。尚未验证真实
GitHub、Windows 和桌面 UI 端到端行为。启动刷新不进入提示词热路径；现有会话串行化和
租约释放继续拥有生命周期。由于 worktree 修改、setup/GC 和 Flock 编排的依赖仍未完成，
本次暂缓 Effect 迁移。

相关测试套件、生产类型检查、`check:quick`、格式化及文档检查通过。
`pnpm check` 的全工作区测试阶段在完成前停止，不能视为完整检查通过。

**守护进程启动调查（2026-10-18，[PR #1688](https://github.com/LodyAI/Lody/pull/1688)）。** #1682 基线依次创建独立成员，再依次初始化其余
子模块和执行 setup。所选子模块的 checkout 还使用 `--recursive`，在嵌套所选成员到达
自己的凭据边界之前便克隆它们，同时克隆未选择的后代。后续阶段跳过已有 `.git` 的
目录，因此通常不是完整下载两遍；嵌套所选成员仍会重复更新、检查和分配分支。
原实现没有显式 fetch jobs 或对象引用。未选择但必需的子模块仍须初始化，本次没有
悄悄省略它们。

相关截止时间属于守护进程 `session-active-presence.ts` 的初始化停滞看门狗，由
`session-execution-service.ts` 的 `awaitInitializationStall` 执行。物化器自身没有发布
Git 阶段或进度。外层 `shouldPrepareWorktree` 仅按兼容字段 `project` 选择
`git-clone`：首成员为 Git 仓库时通常走这条路径；兼容项目缺失或首成员为直接目录／
非 Git 项目时，组仍停留在通用 `initializing`，静默上限为 180,000 ms。恢复最初
使用 `resuming`（900,000 ms）。ACP 在此后启动，握手计时不包含这段准备。`WorktreeGit` 另外将单条 Git 命令限制为 600,000 ms；
`withRepoLock` 的 120,000 ms 是获取锁的等待上限，不是整个克隆的时限。现有
`git-clone` 看门狗预算为 1,800,000 ms。假时钟回归重现了通用阶段在 180 秒失败、
Git 阶段仍存活、成员里程碑变化延长截止时间，以及最终因静默而失败。没有收到
现场失败会话的日志：这些证据确认代码缺陷和可复现的计时器，而非证明现场具体
触发了哪一个计时器。`MessageHandler.handleSessionCreate` 在等待 `startSession`
之前就发送成功响应，因此正常的 create 接受／RPC 等待不包含物化过程。

修复从凭据预检到成员 checkout、子模块和 setup 的真实里程碑发布现有 Git 阶段，
不伪造心跳，也不增加协议字段。最多并行四个独立成员操作，子模块等待父成员，
共享父仓库配置的兄弟成员串行，分支回执以不可变快照串行写入。失败后等待所有
已开始的任务结束再释放 owner；重试保留固定的 `repositoryCheckout` 与已发布分支。
所选子模块使用自身凭据进行非递归初始化；本地副本通过 `--reference` 加
`--dissociate` 复用对象，避免依赖源仓库未来保留对象。其余子模块按有界成员批次
和 `git submodule update --jobs 4` 批次初始化。setup 保持原有串行遍历顺序（父成员先于子成员），因为
脚本可能相互依赖。不将空的托管缓存视为有效对象来源，不引入永久 alternates，
也不扩大已有文件传输权限策略。

启动协调此前在注册 PR 轮询和计划任务之前等待每个本地项目的远端探测，现在改为
运行时就绪后开始。运行时持有其 Promise 和终止信号：关闭时在项目之间停止扫描，
等待当前操作结束后再关闭文档。错误仍记录日志，下次启动重试扫描。观察和写入
继续使用原有原生 Git 边界与 Promise owner，不声称完成部分 Effect 迁移。

测量使用现有 `workspace-git-service.test.ts` 中的真实 Git fixture：三个独立根成员、
两个所选嵌套成员、一个未选择的嵌套叶子和一个未选择的兄弟子模块；setup 仅读取文件
验证状态。Git URL 解析为 `file://` 传输，并设置 `GIT_ALLOW_PROTOCOL=file`，没有
网络或 sleep。使用原生 `/usr/bin/git` 排除开发 shell 凭据包装器的开销。以下为
隔离运行的配对结果（#1682 基线与本次修改；不包含进程导入和 fixture 创建）。这些
只是小型本地样本，不是经过统计验证的网络性能预测。

| 阶段 | 修改前（ms） | 修改后（ms） |
| --- | ---: | ---: |
| 仓库解析与 owner 准备 | 594 | 558 |
| 成员 checkout（包含所选子模块） | 874 | 715 |
| 其余子模块初始化 | 147 | 139 |
| setup hooks | 3 | 4 |
| 完整物化 | 1,619 | 1,419 |

另一个包含十二个真实 Git 项目的 Flock 扫描耗时 398 ms。此前就绪路径等待此扫描，
现在不再为扫描等待，但后台仍有这部分工作。不声称测量了完整守护进程启动时间。
运行相应定向测试时，将 `PROJECT_STARTUP_MEASUREMENTS` 或 `PROJECT_SCAN_MEASUREMENTS`
设为输出文件可采集时间；断言使用显式屏障和最终 Git/Flock 状态，不使用耗时阈值。
覆盖三个根成员在凭据屏障汇合、父成员先于子成员 checkout、所选后代未被提前克隆、
不残留本地 alternates、setup 串行、失败后排空任务再交接 owner、归档恢复、行间
取消扫描以及关闭时等待观察任务。UI 可展示现有 `initializing` 状态及 `git-clone`
阶段和 detail（如 `Prepared web (1/5 ready)`）；没有新增错误码或可用性字段。
真实 GitHub 传输、大量对象的吞吐、Windows 和桌面 E2E 未验证。单次静默克隆仍受
现有命令截止时间限制；完成里程碑不是字节级传输进度。

验证：八个定向 CLI 测试套件共 150 个测试通过，最终的 setup 顺序回归复跑也通过。
`check:quick`、生产类型检查、格式化和文档检查通过。完整 `pnpm check` 中 CLI
有 4,342 个测试通过、两个失败：#1682 的穷举注册 fixture 漏掉新公布的能力字段
（已在本次修正）；原生 SSH 传输 fixture 继承了开发 shell 的 `GIT_EXEC_PATH`
包装器，出现 `context_unreadable`。使用原生 Git 执行路径后，这两个套件的 27 个
测试均通过。此前一个 broker 测试也在继承该包装器时超过自身 30 秒测试上限，清除
后通过。修正后未重新运行完整工作区扫描，后续包的测试阶段及桌面 E2E 仍未验证。
未修改无关的组件源码。

**UI 实现。** `lib/project-member-sources.ts` 构建选择器的行：本地项目按其所在机器
发布的远端合并，每台机器保留一份副本（即 daemon 会选的那份），并保留每个被合并文件夹
原来的来源键，让之前保存的项目组仍能找到对应项。`groupProjectMemberSourceOptions`
负责分组、筛选和置灰的目录。`ProjectGroupSourcePicker` 用受控的搜索词渲染它们，所以
只在 GitHub 上的仓库要等用户输入才出现。编辑器打开已保存的项目组时，会把所在机器
发布了远端的本地成员转换为仓库 Member，并随项目组一起保存。仓库 Member 的子模块
优先从在线机器上的副本读取，因此没有 GitHub 集成也能探测。Composer 中，
`getProjectGroupMachineAvailability` 隐藏绑定到其他机器的项目组，为其余项目组附上
「N 个开始时 clone」或「本机缺 N 个」，并在纯本地模式下禁用这台机器缺少副本的项目组。含
仓库 Member 的项目组需要机器声明 `projectRepositoryMembers` 才能开始。选择器已在
Storybook 中检查（中文，两种筛选）；纯函数有单元测试。尚未与 #1682 的
daemon 端到端运行。

**UI 中的准备进度。** #1688 把项目组的准备过程放在已有的 `git-clone` 初始化阶段上报，
但 composer 对这个阶段只显示固定的「正在克隆仓库」，并忽略 `detail`，而 detail 原本是
英文自由文本。现在 detail 是有长度上限的结构化值（`encodeProjectPreparationProgress`：
`resolve`、带 done/total/path 的 `member`、`submodules`、带 path 的 `setup`），UI 按产品
语言显示，例如「正在准备仓库 2/5 · lody-oss」。按照 presence 通道的规则，daemon 只在
生命周期节点发布：开始时一次、每完成一个成员一次、子模块阶段一次、每个初始化脚本一次
（N 个成员共 2N+2 次，每次不到 200 字节，写在会话唯一的 presence 键上）。旧客户端对这个
阶段忽略 detail；旧 daemon 发来的纯文本回退为通用提示。

## 修订：只保留项目一个概念

**决策**（产品负责人，2026-10-21）。界面上去掉「项目组」这个单独概念。多仓库项目就是包含
多个 Member 的项目，复用项目的各个界面，不再有单独的分区和设置页：

- **摆放。** 含绑定机器 Member 的项目放在那台机器下、它的文件夹之后；不含的可以在任意
  机器运行，放在 GitHub Worktrees 下（`placeProjectGroups`）。绑定的机器不在侧边栏里的
  项目，以及已删除项目的对话，也放在 GitHub Worktrees 下。设置 › 项目按同样规则摆放，
  第二类放在「任意机器」分区。
- **入口。** 设置 › 项目的添加菜单提供「多个仓库或文件夹」。文件夹行的右键菜单提供
  「编辑项目…」，打开同一个编辑器并预先加入这个文件夹（所在机器发布了远端时作为仓库
  Member）；保存后新建一个项目，原文件夹和它的对话不变，因为已有对话的目录结构无法改变。
  GitHub 仓库行的右键菜单（以及悬停时的 ⋯）提供同样的入口，预先加入这个仓库。多仓库
  项目行的菜单直接编辑它。手机上，项目的设置标签页顶部有一行「编辑项目…」，预先加入
  该项目；移动端设置 › 项目按同样规则列出多仓库项目，并提供「多个仓库或文件夹」。
  所有入口共用一个宿主（`ProjectEditorHost`，由
  `projectEditorRequestAtom` 驱动），负责编辑器和删除确认。
- **移除。** 设置里的「项目组」页面和路由、侧边栏的单独分区及其折叠状态。文案统一称
  「项目」；行使用叠放文件夹图标。

shared 契约、daemon 和 composer 的行为不变。删除多仓库项目目前只能在桌面端的设置 ›
项目中进行。已通过单元测试和类型检查验证；侧边栏摆放
在 Storybook 中检查过，未在真实工作区中验证。

