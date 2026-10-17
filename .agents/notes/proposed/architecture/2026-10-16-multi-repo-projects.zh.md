# 多仓库 Project：平铺在一个主目录下

Status: proposed
Type: architecture
Translation: current

[English](2026-10-16-multi-repo-projects.md)

## 摘要

一个功能经常要跨前端、后端和依赖库，同时提多个 PR。但 Lody 的对话只绑定一个仓库：
一个执行目录、一个分支，PR 发现也只针对这一个仓库。本提案引入工作区级的 Project：
新建对话时，为每个 Member 创建一个可编辑的 worktree，平铺在一个主目录下，主目录就是
Agent 的执行目录；PR 发现和“当前 PR”都改为按仓库计算。这是在评审中把最初的嵌套
布局方案简化后的结果，代价是原有的嵌套关系（子模块、依赖目录内部的相对路径）不再在
磁盘上保留，只通过提示告诉 Agent。设计尚未实现，Agent 沙箱范围、`SessionMeta` 大小
和旧客户端的显示都还没有验证。规范意图见[草案 Spec](../../../../specs/multi-repo-projects.zh.md)。

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
  /** 以 Member ID 为键的 Loro map，不同 Member 的写入互不冲突。 */
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
`project`。每个 Member 的 Git worktree 登记在它自己的仓库中，登记名使用 sessionId；
同一个对话里每个仓库只有一个 Member，所以不会冲突。

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
