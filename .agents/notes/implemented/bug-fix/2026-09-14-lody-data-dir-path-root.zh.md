# 所有会话路径都从安装数据目录派生，并使用宿主机自己的分隔符

Status: implemented
Translation: current

[English](2026-09-14-lody-data-dir-path-root.md)

## 摘要

一位 Windows 用户反馈：工作区路径显示为 POSIX 风格路径，会话随后以
`fatal: Invalid path '<home>/.lody': No such file or directory` 失败，之后既无法新建
也无法继续任何对话。有两个彼此独立的缺陷共同造成了这种状态：浏览器安全的路径构造函数
用 `/` 拼接所有派生路径，于是 Windows 机器的 worktree 与对话路径被写成
`C:/Users/...`，而守护进程用 `path.join` 真正创建的路径却是 `C:\Users\...`；同时有四个
CLI 模块直接拼接字面量 `~/.lody`，而不是调用唯一会遵循 `LODY_DATA_DIR` 与 OSS
`.lody-oss` 配置的 `getLodyDataDir()`。现在派生路径会沿用其来源宿主路径的分隔符，这四个
模块改用派生出的根目录，并且在该目录下的任何路径进入 git 之前，先创建该目录并以 Lody
自己的目录名义报告问题。报告中那个具体的 `/mnt/c/...` 取值未能复现——Windows 上的 Node
进程无法产出该字符串，它最可能是更早一次安装写下的持久化状态——因此本次修复针对的是这
一类失败，而非某个已确认的单一触发路径。

## 两个缺陷

`packages/shared/src/worktree-paths.ts` 是浏览器安全模块，无法使用 `node:path`，因此在
去掉反斜杠后用 `/` 拼接各段。原注释以 `vscode://file/...` URI 安全性为由，但
`buildVSCodePathLauncherFallbackUrl` 本身已经会归一化分隔符，没有任何调用方依赖这种正斜
杠形式。其余调用方依赖的却是它必须是一个真实宿主路径：渲染层把它作为会话工作区路径展示、
交给路径启动器，并在 `session-local-file-path.ts` 中把文件路径拼接到它后面——而那里选择分
隔符的条件是 `WINDOWS_ABSOLUTE_PATH.test(root) && !root.includes('/')`，于是 `C:/...`
形式的根路径会静默地选中 POSIX 分隔符。CLI 一侧，`terminal-workdir-resolver.ts` 把同一个
字符串放进 `workdir_unavailable:path_not_found:<path>` 错误里，
`local-project-control-service.ts` 则用它读取 worktree 文件。因此同一台 Windows 机器对本地
项目会话显示 `C:\Users\...`，对 worktree 与对话会话显示 `C:/Users/...`：同一个目录的两种
写法，彼此永远不相等。

另一个缺陷是，`speculative-worktree.ts`、`session-fork-operation-store.ts`、
`machine-lifecycle.ts` 与 `code-collab-v2-diff-store.ts` 各自拼接
`path.join(os.homedir(), '.lody', …)`。`getLodyDataDir()` 会优先解析 `LODY_DATA_DIR`——
Electron 主进程为它启动的每个 CLI 都会设置该变量——否则按安装配置选择 `.lody` 或
`.lody-oss`。在两者不一致的任何安装上，这四个模块读写的是一个不一定存在的同级目录，而
`WorktreeManager` 与对话工作目录用的却是真正的那个。CommonJS 镜像
`node/worktree-paths.cjs` 早已改为从配置读取 `dataDirectoryName`，其 TypeScript 孪生体没
有——这正是该分歧一直未被发现的原因。

## 决策

分隔符风格取决于输入路径自身的形状，而非 `process.platform`。这些构造函数运行在渲染层，
处理的是 Flock 从会话所属机器带过来的 `dotlodyPath`，因此 Windows 桌面端经常要为 Linux
机器构造路径，反之亦然；`isWindowsStyleHostPath` 因而只检查取值本身是否具有盘符根或内嵌
反斜杠。`getLodyReposBaseDir` 以及 `getWorktreeHostPath` 的 `homeDir` 形式现在都委托给
`dotlodyPath` 系列构造函数，使一条规则覆盖两个家族；CJS 镜像也带上了同一个辅助函数。

`getLodyDataDir()` 是命名数据根目录的唯一受支持方式。那四处字面量拼接改为调用它，并且浏
览器安全的 `.lody` 回退路径在文档注释中明确说明：它只是尚未发布 `dotlodyPath` 行的机器
的回退值，而不是该安装真正的根目录。

数据根目录缺失时，以 Lody 自己的目录名义报告。`ensureLodyDataDir()` 会创建它，失败时抛出
指明该路径与 `LODY_DATA_DIR` 的 `LodyDataDirUnavailableError`。
`WorktreeManager.ensureRepoLocked` 在两个分支运行 git 之前调用它，
`ensureDefaultSessionWorkdir` 在创建对话工作区之前调用它。`ensureRepoLocked` 的
local-shared 分支现在同样会创建 `worktreesDir`——此前只有 bare 分支会创建；在那之前第一个
创建该目录的是 `git worktree add`，而它会把这类失败报告成 git 收到的某个路径。

## 备选方案

解析 git 的 stderr、匹配 `Invalid path '<data dir>'` 并改写提示的方案被否决：这是对另一个
程序诊断输出的字符串式读取，而且守护进程仍然会带着不可用的根目录去调用 git。显式前置检
查会更早失败，并且不依赖 git 的措辞就能说明同一件事。

改为在 Windows 上一律归一化为 `/`（Node 的 `fs` 两种都接受）也被否决，因为缺陷在于两种写
法并存，而不在系统调用：这两种形式正是用户读到的内容，并且它们会破坏与 `path.join` 输出
之间的 `path.relative`/`startsWith` 包含关系检查。

删除未被使用的 `homeDir` 系列构造函数被判定超出范围：它们从 `@lody/shared` 导出，可能存在
本仓库边界之外的调用方。

## 验证与局限

`packages/shared`（1208 个测试）与 CLI 测试套件通过。新增用例覆盖
`tests/worktree-paths.test.ts` 中的 Windows、盘符加正斜杠以及 UNC 输入，
`packages/components/tests/session-workspace-path.test.ts` 中会话展示的 Windows 工作区路径，
以及 `tests/installation-profile.test.ts` 中 `ensureLodyDataDir` 的两种结果。

所有分隔符覆盖都停留在字符串层面：CI 运行在 Linux 上，没有任何测试在真实 Windows 文件系统
上执行这些路径。报告者的 `/mnt/c/...` 取值仍无法解释——Windows 上 `os.homedir()` 源自
`USERPROFILE`，不可能产出它；而只有当所有父级都解析成功时 git 才会把 `<...>/.lody` 指为失
败分量，对于 `/mnt` 前缀，Windows 版 git 做不到这一点。如果本次改动后该路径仍然显示，剩下
的嫌疑对象是更早一次安装写下的持久化状态：机器 Flock 的 `dotlodyPath` 行（守护进程重连时
会自愈），或 git 自身 worktree 管理文件中的绝对路径。
