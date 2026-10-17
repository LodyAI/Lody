# 多仓库项目组（Project group）

Status: draft
Translation: current

[English](multi-repo-projects.md)

界面与 Agent 文案称为「项目组 / Project group」。代码类型名不变；下文 Project
指项目组，现有「项目」仍指单个本地文件夹或 GitHub 仓库。

## 场景

Alice 的产品由本地文件夹 `web`（远端 `acme/web`）、`api`（远端 `acme/api`）和
`api` 里的子模块 `proto`（`acme/proto`）组成。她要做“导出报表”功能，需要在同一个
对话里修改这三个仓库，最后得到三个互相关联的 PR，并在这个对话里看到它们的状态和 CI。

今天一个对话只绑定一个本地项目或一个 GitHub 仓库（`ProjectRef`），只有一个执行
目录、一个分支，PR 发现也只看这个分支。

## 概念

- **Project**：工作区级的分组，由若干 **Member** 组成。每个 Member 是一个 Git
  仓库：GitHub 仓库，或者一个是 Git 仓库的本地项目（可以没有远端，此时有分支和备份，
  但没有 PR）。不是 Git 仓库的本地目录不能作为 Member；添加时会提示先 `git init`。
  非 Git 目录等 ACP 的 `additionalDirectories` 普遍支持后再引入。
- Member 按**仓库身份**去重：GitHub 仓库（有数字 ID 时以 ID 为准），或者没有 GitHub
  远端的本地仓库 `(machineId, localProjectId)`。同一个仓库从本地文件夹和 GitHub 各加
  一次，或者从同一个 monorepo 的两个子目录加入，都只算一个 Member。
- 每个平铺的 Member 有一个目录名，在 Project 内唯一，默认取仓库名，用户可以修改；
  子模块 Member 的位置由子模块路径决定。
- 现有的单个本地项目或 GitHub 仓库保持原样。它们原有的对话留在原来的位置，加入
  Project 后也不会移动。
- Member 的数量没有产品上限。

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
嵌套关系摆放 Member，也不使用符号链接。

子模块以外的目录嵌套照样平铺。原来依赖 `../lib` 这类相对路径的仓库，只要把 Member
的目录名设成原来的名字，就能继续使用这些引用。

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
- 只能和父 Member 一起选中。取消勾选父 Member 时，它的子模块 Member 也不会被物化。
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
Daemon 在执行机器上为每个 Member 创建一个 worktree 和新分支，放到主目录下。默认
包含全部 Member；用户在创建对话时取消勾选的 Member 不会被拉取。所有 Member 都是
可编辑的，没有只读模式。

- 每个 Member 按现有规则各自分配分支，不要求各仓库的分支名相同。
- 对话在创建时冻结 Member 列表，之后对 Project 的编辑只影响新对话。
- 本地 Member 必须在执行机器上有绑定。没有绑定的 Member 不能被选中，Lody 不会悄悄
  改为 clone 一份。开源桌面版是纯本地模式，只支持本地 Member，PR 通过本机凭证观测。
- 多 Member 对话始终使用 worktree。单 Member 对话保持现有行为，包括直接使用原始
  目录的模式。

## PR 关联

- 每个 Member 单独观测分支、未提交/未推送状态和 diff 统计。PR 发现以
  `(仓库, 该 Member 的分支)` 为键。
- `pullRequests` 仍按 URL 存储全部 PR。“当前 PR”的含义从“整个数组的最后一项”
  改为“每个仓库的最后一项”，因此一个对话可以同时有多个当前 PR，每个仓库至多一个。
- Info Bar 按仓库列出 PR 和 CI。Create PR 为每个有改动的 Member 各创建一个 PR，
  各 PR 正文互相链接。
- 只有当前 PR 全部进入已启用的终态时，才触发 PR 自动归档；其中一个进入终态不算。
- 兼容性：`project`、`branchName`、`repoFullName` 保留为第一个 Member 的投影，供旧
  客户端使用。只有声明了该协议能力的 daemon 才能创建多 Member 对话。

## 生命周期

归档时逐个 Member 执行备份提交并移除其 worktree；全部成功后才删除主目录。子模块
Member 先于父 Member 处理：先在子模块中做备份提交，并把它的任务分支保存到该仓库的
持久位置（GitHub Member 为 `<data>/repos/<repo>/bare.git`，本地 Member 为原仓库），
因为子模块的 Git 数据位于父 worktree 的管理目录中，会随父 worktree 一起删除；之后
父 Member 的备份提交记录的就是子模块备份后的指针。恢复时从持久位置取回子模块分支。任一
Member 无法解析或备份失败，都保留整个主目录并稍后重试。分支永不删除。恢复时按冻结
的 Member 列表和各自的分支重建主目录。Child Tab 共享根对话的主目录。除此之外，
沿用 [Session worktree 生命周期](session-worktree-lifecycle.md) 的规则；GC 范围扩展到
`<data>/repos/project-*/worktrees/<session>`。

## 数据归属

- Project 定义是工作区 Flock 文档中的一行，和 MCP、Agent Role 的目录放在一起。本地
  Member 只引用 `(machineId, localProjectId)`；路径仍只存在于该机器的 Flock 中。
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
该对话的机器上；主目录是根目录 `main`。同步数据用 `(rootId, relativePath)` 标识文件，
主目录下的路径保持现有的纯相对路径形式。机器边界接受绝对路径，由同一个解析函数映射到
某个根目录，不在任何根目录下的路径被拒绝。将来支持主目录之外的本地目录时，只需要增加
根目录，不改变这一格式。调研见[提案 Note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.zh.md#路径依赖调研为将来支持本地目录做准备)。

## 证据

以下是对现状的检查，不是本 Spec 的实现：

- 单一绑定：[`ProjectRef`](../packages/shared/src/project.ts)、
  [`SessionMeta`](../packages/shared/src/schema.ts)。
- 单分支 PR 发现，以及“当前 PR 是最后一项”：[PR 调和器](../apps/cli/src/lib/pr-poller/AGENTS.md)。
- [分支观测](workspace-branch-state.md)、[本地 PR 观测](local-github-pr-observation.md)。
- 决策与备选方案：[提案 Note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.zh.md)。
