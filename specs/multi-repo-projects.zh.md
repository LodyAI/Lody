# 多仓库项目

Status: draft
Translation: current

[English](multi-repo-projects.md)

界面上就叫「项目」，没有单独的「项目组」概念；代码类型名不变。下文 Project 指多仓库
项目，单个本地文件夹或 GitHub 仓库仍是普通项目。

## 场景

Alice 的产品由本地文件夹 `web`（远端 `acme/web`）、`api`（远端 `acme/api`）和
`api` 里的子模块 `proto`（`acme/proto`）组成。她要做“导出报表”功能，需要在同一个
对话里修改这三个仓库，最后得到三个互相关联的 PR，并在这个对话里看到它们的状态和 CI。

今天一个对话只绑定一个本地项目或一个 GitHub 仓库（`ProjectRef`），只有一个执行
目录、一个分支，PR 发现也只看这个分支。

## 概念

- **多仓库项目**（代码类型 `WorkspaceProject`，下文称 Project）：工作区级的项目，由若干
  **Member** 组成。界面上它就是项目，和单个文件夹或仓库共用项目行、菜单和选择器，只是
  包含多个 Member。Member 可以是 GitHub 仓库、
  本地 Git 仓库（可以没有远端，此时有分支和备份，但没有 PR），或者本地非 Git 目录。
  非 Git 目录没有分支、备份和 PR，对话直接修改原目录，见「成员接入方式」。
- Member 按**仓库身份**去重：GitHub 仓库（有数字 ID 时以 ID 为准），或者没有 GitHub
  远端的本地仓库 `(machineId, localProjectId)`。同一个仓库从本地文件夹和 GitHub 各加
  一次，或者从同一个 monorepo 的两个子目录加入，都只算一个 Member。
- Member 分为**仓库 Member**和**绑定机器的 Member**。从 GitHub 选择的仓库以仓库
  Member 加入：它记录的是仓库而不是机器，可以在任意机器上运行。在某台机器上选择的
  文件夹以绑定机器的 Member 加入，即使已知其 GitHub 远端（仍按该仓库去重和跟踪），
  所以由一台机器的文件夹组成的 Project 只在这台机器上运行。之前保存的 Project 中使用
  本地副本的仓库 Member 在编辑前保持不变。一个 Project 的所有
  绑定机器的 Member 都在同一台机器上，这台机器就是它唯一的执行机器；没有绑定机器的
  Member 的 Project 可以在任意机器上运行。
- 每个平铺的 Member 有一个目录名，在 Project 内唯一，默认取仓库名，用户可以修改；
  子模块 Member 的位置由子模块路径决定。
- 现有的单个本地项目或 GitHub 仓库保持原样。它们原有的对话留在原来的位置，加入
  Project 后也不会移动。
- Member 的数量没有产品上限。

- **显示位置。** 含有绑定机器 Member 的 Project 显示在那台机器下，和它的文件夹放在
  一起；不含的 Project 可以在任意机器上运行，和 GitHub 仓库放在一起。sidebar 和
  设置 › 项目都按这个规则。在 sidebar 里，它的行为和相邻的项目一致：在机器下像文件夹
  一样一直显示；在仓库旁边像仓库一样只在有对话时显示，归档全部对话后隐藏，恢复任一对话
  后重新出现。它的菜单像文件夹一样，为创建者提供「移除项目」。
- **创建与编辑。** 设置 › 项目的添加菜单里，在添加文件夹、添加 GitHub 仓库旁边提供
  「多个仓库或文件夹」。项目行的右键菜单提供「编辑项目…」：对多仓库项目直接编辑；对
  单个文件夹或 GitHub 仓库则打开同一个编辑器并预先加入它，保存后得到一个新的 Project，
  原来的项目和它的对话保持不变。手机上，同样的操作是项目设置标签页的第一行，移动端
  设置 › 项目也可以新建。Composer 的项目选择器也提供「创建项目」。创建是一组逐个回答的
  问题，在用户决定项目在哪里运行之前不会把文件夹和仓库混在一起：先选择包含本地文件夹还是
  仅 GitHub 仓库；包含本地文件夹时再选机器；然后选择那台机器上的文件夹（含直接选择），
  另一个标签页列出全部 GitHub 仓库；仅 GitHub 时直接多选仓库；最后填写名称、确认成员和说明。
  同一个仓库既作为文件夹又作为 GitHub 仓库勾选时只提醒、不阻止，Project 只保留一个成员，
  优先使用 GitHub 仓库。
  修改前面的回答会移除新回答容纳不了的成员。编辑 Project 走同样的问题，并把当前的答案和
  成员标为「上次选择」；无权修改的人只读查看。

## 直接选择目录与独立展示

用户创建 Project 时可以直接选择本机文件夹，无需事先逐个添加独立项目。“选择本机文件夹”是本地目录的主要入口，同时保留从已有项目或仓库添加。保存前展示所选路径，以及成员会修改原文件还是使用 Git 隔离。

**目录登记与展示分开。** 目录登记记录机器上的目录身份和路径，Project 引用它；独立展示决定该目录是否也作为单独条目出现在侧栏、设置 › 项目和独立项目选择入口。它不是第二份项目，也不是访问权限边界。成员始终可以在所属 Project 内看到。已有独立条目保持显示，加入 Project 不会把它隐藏。绝对路径继续保存在机器目录表中。

**保存与复用。** 选择阶段是草稿，保存前取消不产生登记。保存时校验目录，复用已有登记，对缺少的目录自动登记但不独立展示。同一工作区、同一机器上，规范化后相同的目录只有一份登记，与显示名称无关；不同克隆或机器分别登记，仓库 Member 的去重仍遵循前文规则。部分保存失败时明确报错，重试复用已经创建的登记，不发布不完整的 Project，也不删除共享登记。

**以后单独添加同一目录。** 用户主动把已登记目录添加为独立项目时，复用原身份并开启独立展示；已经显示则定位到已有条目。例如先通过多文件夹 Project 添加 `backend`，以后再单独添加，结果是一份登记、两个入口。不会移动或合并对话，也不会改变组合成员关系。

**删除。** 沿用设置 › 项目里的“删除项目”，不增加确认框或“从列表移除”功能。拥有目录的 daemon 检查 Project 成员和已有多仓库会话快照：仍有引用时取消独立展示，保留登记与对话；没有引用时沿用已有本地项目删除流程。依赖关系完全由内部处理，不向用户展示。原目录和文件不会被删除。移除成员或删除 Project 只改变其定义，不自动清理闲置隐藏登记。用户明确重新添加保留的目录时，恢复原身份与独立入口。

**保持运行语义。** 直接选择目录不新增“始终绑定这个本地副本”的含义：所选目录让 Project 绑定到它所在的机器，包括有 GitHub 远端的目录（2026-10-27 按用户要求修订；此前这类目录会转换为可迁移的仓库 Member），编辑器应解释这一区别。普通目录修改原文件，没有 worktree 隔离；选择仓库子目录不承诺独立 Git 隔离。本次不新增 CLI/MCP 接口、目录自动迁移或权限模型。为兼容现有数据，旧登记默认独立展示。

## 平铺布局

对话有一个主目录，除子模块 Member 外，所有 Member 都平铺在它的下面：

```text
<data>/repos/project-<name>-<projectId>/
  worktrees/<sessionId>/   ← 主目录
    web/       ← acme/web 的 worktree
    api/       ← acme/api 的 worktree
      proto/   ← acme/proto，作为 api 的子模块检出
```

这沿用了现有 `<data>/repos/<repo>/worktrees/<session>` 的结构。`<name>` 是 Project
名称转换成的安全路径片段，只用来方便辨认；目录以 `projectId` 为准，Project 改名后
不搬目录。主目录就是 Agent Provider 的执行目录，也是终端、文件搜索和预览的根目录。
主目录本身不是 Git 仓库。每个 Member 的 Git 数据仍在它自己的仓库里：GitHub Member
在 `<data>/repos/<repo>/bare.git`，本地 Member 在原仓库的 `.git`。Lody 不按原有的
嵌套关系摆放 Member。Git Member 不使用符号链接；非 Git Member 按下文接入规则处理。

子模块以外的目录嵌套照样平铺。原来依赖 `../lib` 这类相对路径的仓库，只要把 Member
的目录名设成原来的名字，就能继续使用这些引用。

## 成员接入方式

Daemon 在物化对话时，按成员类型和本次对话的 Provider 能力决定每个成员怎样进入
Agent 的工作范围，并把结果记录在快照的运行时字段里：

| 成员                                                       | 接入方式                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------- |
| GitHub 仓库                                                | 在主目录下建 worktree                                           |
| 本地 Git 仓库                                              | 在主目录下建 worktree                                           |
| 本地非 Git 目录，Provider 声明支持 `additionalDirectories` | 把原目录的真实路径作为额外目录传给 Provider，不放进主目录       |
| 本地非 Git 目录，Provider 不支持                           | 在主目录下以成员目录名建软链接指向原目录（Windows 用 junction） |

- 后续启动的 ACP 会话（恢复、换 Provider）重新判断：额外目录不可用时补建软链接，
  可用时不再依赖软链接。
- 非 Git 成员不隔离：同一目录被多个对话同时使用时，它们修改的是同一份文件。界面在
  选择和使用这类成员时明确说明。它没有分支、备份提交和 PR。
- 额外目录和软链接目标都只从本机的本地项目注册表解析（`localProjectId` → 路径），
  不信任 Agent 提供的路径或磁盘上读到的链接目标。链接被 Agent 改动时，daemon 按注册表
  重建。
- 归档清理只删除链接本身，绝不递归进入链接目标；先移除所有成员链接并确认主目录下
  不再有软链接，再删除主目录。非 Git 成员不参与备份提交。
- 非 Git 成员只能是顶层成员，不能是子模块。

## 子模块 Member

创建 Project 时，Lody 只读地读取每个 Member 的 `.gitmodules`，把子模块 URL 与其他
Member 或待添加的仓库进行匹配。能自动探测到的关系会直接设好，并在界面上显示为
“`proto` 是 `api` 的子模块 `proto/`”；用户可以取消，也可以为探测不到的情况手动指定。
设定后，这个 Member 就是**子模块 Member**：

- 不单独拉取，也不平铺到主目录。父 Member 的 worktree 创建后执行
  `git submodule update --init --recursive`，子模块 Member 出现在父 Member 的子模块
  路径下，例如 `api/proto/`。
- 子模块检出时是游离 HEAD。Lody 随后在这个路径上，从父仓库记录的提交新建任务分支；
  基准是 gitlink 提交，不是子仓库的默认分支。
- 它仍然是一个完整的 Member：单独观测分支和状态，单独发现 PR。Lody 保留这层关系，
  主要是为了正确关联 PR：Create PR 先为子模块创建 PR，再为父仓库创建更新指针的 PR，
  并在父 PR 中链接子 PR；合并顺序提示子模块先合。
- 始终和父 Member 一起物化；父 Member 的 worktree 无论如何都会检出它声明的所有子模块。
- 创建对话时会校验：父仓库的基准提交中，该路径仍是指向同一仓库的子模块。不一致时
  报告给用户，不静默改为平铺。
- 没有被设为 Member 的子模块也会被 `--recursive` 初始化，可以修改，但不会被观测，
  也不会产生 PR。

## Project 说明

创建或编辑 Project 时，可以填写一段可选的说明，注入给 Agent。输入框的提示文字引导
用户描述各个仓库的职责和相互关系，例如：“web 是 Next.js 前端；api 是 Go 后端，对外
提供 REST 接口；proto 是两者共享的接口定义，修改接口时先改 proto。”

新对话的第一轮会注入两部分上下文：Lody 生成的 Member 清单（路径、仓库、分支、子模块
关系），以及这段说明。说明随 Member 快照一起冻结，之后编辑 Project 只影响新对话。它
和 Agent Role 的提示前缀一样，是工作区内共享的普通配置，不能存放密钥。

## 创建与物化

定义 Project 时只写入定义，不 clone、不 fetch，也不创建 worktree。新建对话时，
Daemon 在执行机器上为每个 Git Member 创建一个 worktree 和新分支，非 Git Member 按接入规则处理。对话
总是包含 Project 定义的全部 Member，不能在创建对话时另选一部分；需要不同的仓库组合时，
应修改 Project 设置（或另建一个 Project）。所有 Member 都是可编辑的，没有只读模式。

- 每个 Member 按现有规则各自分配分支，不要求各仓库的分支名相同。
- 对话在创建时冻结 Member 列表，之后对 Project 的编辑只影响新对话。
- 绑定机器的 Member 必须在执行机器上有绑定，Lody 不会改为 clone 一份代替它。
- 仓库 Member 在执行机器有本地副本时使用本地副本，即这台机器上 GitHub 远端为该仓库的
  本地项目：worktree 从这份副本创建，使用本机自己的 Git 凭证，和本地 Member 一样。
  没有本地副本时，托管部署像 GitHub Member 一样 clone 这个仓库。开源桌面版是纯本地
  模式，从不 clone，所以含有这台机器没有副本的仓库 Member 的 Project 不能在这里开始；
  选择器把它显示为在这台机器上不可用，并说明原因。
  仓库 Member 用创建其 worktree 时的同一套凭证观测 PR。
- 和单个项目一样，先选在哪台机器运行：新对话的选择器只列出能在所选机器上运行的
  Project。绑定机器的 Member 在另一台机器上的 Project 不在这里列出，因此在这个
  选择器里选择 Project 从不切换机器。每个列出的 Project 会说明所选机器缺少哪些仓库 Member。
- 多 Member 对话中，Git 成员始终使用 worktree，非 Git 成员按「成员接入方式」接入。
  单 Member 对话保持现有行为，包括直接使用原始目录的模式。

## PR 关联

- 每个 Member 单独观测分支、未提交/未推送状态和 diff 统计。PR 发现以
  `(仓库, 该 Member 的分支)` 为键。
- `pullRequests` 仍按 URL 存储全部 PR。“当前 PR”的含义从“整个数组的最后一项”
  改为“每个仓库的最后一项”，因此一个对话可以同时有多个当前 PR，每个仓库至多一个。
- Info Bar 的仓库面板列出全部 Member，并按放置层级缩进，显示各自的分支与当前
  PR/CI。选中某个 Member 后，context stage 与 PR 标签页描述该 Member 的仓库、分支、
  diff 与 PR；未选择时仍默认使用第一个 Member 的投影。没有 GitHub remote 的 Member
  不会借用其他 Member 的仓库或 PR。Create PR 为每个有改动的 Member 各创建一个 PR，
  各 PR 正文互相链接。
- 只有当前 PR 全部进入已启用的终态时，才触发 PR 自动归档；其中一个进入终态不算。
- 兼容性：`project`、`branchName`、`repoFullName` 保留为第一个 Member 的投影，供旧
  客户端使用。只有声明了该协议能力的 daemon 才能创建多 Member 对话。
  含仓库 Member 的 Project 只能在声明了仓库 Member 能力的 daemon 上开始；旧 daemon
  会把这种 Member 当作普通的 GitHub clone。

## 生命周期

归档时逐个 Git Member 执行备份提交并移除其 worktree；全部成功后才删除主目录。子模块
Member 先于父 Member 处理：先在子模块中做备份提交，并把它的任务分支保存到该仓库的
持久位置（GitHub Member 为 `<data>/repos/<repo>/bare.git`，本地 Member 为原仓库），
因为子模块的 Git 数据位于父 worktree 的管理目录中，会随父 worktree 一起删除；之后
父 Member 的备份提交记录的就是子模块备份后的指针。恢复时从持久位置取回子模块分支。任一
Member 无法解析或备份失败，都保留整个主目录并稍后重试。分支永不删除。恢复时按冻结
的 Member 列表和各自的分支重建主目录。Child Tab 共享根对话的主目录。除此之外，
沿用 [Session worktree 生命周期](session-worktree-lifecycle.md) 的规则；GC 范围扩展到
`<data>/repos/project-*/worktrees/<session>`。

## 数据归属

- Project 定义是工作区 Flock 文档中的一行，和 MCP、Agent Role 的目录放在一起。绑定
  机器的 Member 只引用 `(machineId, localProjectId)`；路径仍只存在于该机器的 Flock 中。
- 每台机器在自己的 Flock 中、在每个本地项目旁发布它的 GitHub 仓库，由拥有该项目的
  daemon 从文件夹的远端观测得到。客户端用它把同一个仓库的多份副本合并成一项，并显示
  哪些机器能运行某个 Project。它只是仓库名，从不是路径，且只有拥有它的 daemon 写入。
- 在仓库 Member 出现之前保存的 Project，其本地 Member 保持原样，编辑也不再转换它们：
  文件夹仍属于它的机器。在某台机器上编辑时，使用该机器本地副本的仓库 Member 会变为这台
  机器的文件夹。
- 对话元数据保存创建时冻结的 Member 快照，包括 Project 名称和主目录名。删除或修改
  Project 不影响已有对话；Project 被删除后，已有对话仍按快照分组和恢复。
- `projectRun` 保持 SessionMeta 上的单个顶层值。客户端只在创建对话时写初始快照；
  此后只有拥有该对话的 daemon 写入，包括成员观测、中途追加成员和旧字段投影，
  按对话串行执行读取、修改、写回，复用分支观测的 owner 串行链。
  如果将来出现第二个写入方，必须改为每个成员单独一行。
- 主目录名在创建时确定并写入对话元数据，之后不随 Project 改名而变化。
- 旧字段 `project`、`branchName`、`repoFullName`、`isWorktree` 是第一个 Member 的
  投影；`workspaceDirty`、`workspaceUnpushed` 取所有 Member 的“或”，`diffStats` 取总和，
  让旧客户端的提交与推送提示仍然有效。
- 子模块关系是 Project 定义的一部分，由用户确认，并冻结在对话快照中。
- PR 与 Member 的对应关系由 PR URL 中的仓库推导，不另存。因为一个仓库在 Project 里
  至多是一个 Member，这个推导是唯一的。

格式草案见[提案 Note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.zh.md#数据格式)。

## ACP 项目归属

现有的 `worktreeProject.originProjectPath` 表示本地项目的原始根目录，用于让 Provider
把同一项目的多个 worktree 对话归到一个原生项目下；它不授予目录权限，也不改变 `cwd`。
多 Member 对话发送 Project 目录 `<data>/repos/project-<slug>-<projectId>`：同一个
Project 的对话都归到同一个原生项目，`cwd` 仍是各自的主目录。

## 文件路径

同步数据不包含主机绝对路径。对话的文件根目录列表 `{ id, absolutePath }` 只保存在拥有
该对话的机器上；主目录是根目录 `main`，每个以额外目录或软链接接入的成员各是一个根目录
`member:<memberId>`。同步数据用 `(rootId, relativePath)` 标识文件，主目录下的路径保持
现有的纯相对路径形式。机器边界接受绝对路径，由同一个解析函数映射到某个根目录，不在任何
根目录下的路径被拒绝。

所有根目录在 Lody 中享有和主目录相同的文件能力：

- 文件预览（含远程查看）、打开编辑、保存和 LSP 都按根目录列表授权。授权先解析真实
  路径，再判断是否在某个已注册根目录内，因此从软链接逃出根目录的路径仍被拒绝。只有在
  所有根目录之外的文件才是 `external`（只读）；同机 Electron 的任意路径只读预览保持
  不变。
- 文件树、All Changes 和 `@` 文件搜索覆盖所有根目录，按根目录分组；每个根目录单独
  扫描和监听。非 Git 根目录沿用现有的非 Git 扫描与快照方式。
- 每轮 diff、Agent 输出的文件和附件来源路径都按根目录记录，额外目录中的修改不会被
  丢弃。
- 远程客户端请求文件时传 `rootId` 和相对路径，不传主机绝对路径。调研见[提案 Note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.zh.md#路径依赖调研为将来支持本地目录做准备)。

## 证据

本次已实现直接选择目录与独立展示。登记复用逻辑见
[local-project-import](../packages/components/src/lib/local-project-import.ts)，
[研究与取舍](../.agents/notes/implemented/architecture/2026-10-26-project-direct-folder-selection.zh.md)
记录了行为、验证和边界；本 Spec 的其他部分仍保持草案状态。

以下是对现状的检查，不是本 Spec 的实现：

- 单一绑定：[`ProjectRef`](../packages/shared/src/project.ts)、
  [`SessionMeta`](../packages/shared/src/schema.ts)。
- 单分支 PR 发现，以及“当前 PR 是最后一项”：[PR 调和器](../apps/cli/src/lib/pr-poller/AGENTS.md)。
- [分支观测](workspace-branch-state.md)、[本地 PR 观测](local-github-pr-observation.md)。
- 目前只认单一根目录的位置：[预览路径策略](../packages/shared/src/node/file-preview-path-policy.ts)、
  [Code Collab 路径解析](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts)、
  [每轮 diff 路径归一化](../apps/cli/src/lib/code-collab/code-collab-v2-diff-evidence.ts)。
- 决策与备选方案：[提案 Note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.zh.md)。

创建快照对未指定的 root base 使用 `HEAD`，对子模块 base 使用 `gitlink`；owner daemon
在物化时将 root 占位值解析为基线引用、子模块占位值解析为提交。取消父成员同时取消全部后代。本地子模块探测只读，不返回主机
绝对路径，本地路径 URL 脱敏。

非主目录文件的同步字符串使用 NUL 前缀编码，与真实文件名不冲突；文件 RPC 使用可选 rootId，缺省 main。编码细节见 Note 的「多根目录文件契约」。
