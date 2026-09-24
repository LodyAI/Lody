# 复制相对路径与绝对路径

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/920

[English](2026-09-23-copy-relative-and-absolute-file-path.md)

## 摘要

文件树右键菜单和右侧面板的更多菜单原本只有一个“复制文件路径”，在已知所属机器工作区
根目录时静默复制解析后的绝对路径，否则复制工作区相对路径，用户无法选择放进剪贴板的
形式。现在两个菜单都提供“复制相对路径”（查看器持有的路径）和“复制绝对路径”（在所属
机器上解析的路径）；当工作区根目录和路径本身都无法提供绝对路径时，隐藏绝对路径一项。
文件错误卡片和 Markdown 链接菜单仍保留单一的自动复制操作，这也是这些界面之间仅存的差异。

## 决策与证据

本改动扩展现有的共享文件操作决策，见[本地文件链接笔记](../bug-fix/2026-09-09-local-file-link-actions.md)：
任何界面都能复制路径，而调用系统 shell 仍只在 local-host 分支开放。
`useSessionFileActions` 为文件错误卡片和 Agent Markdown 链接菜单保留 `copyPath`，
并为 `menuItems` 新增 `copyRelativePath` / `copyAbsolutePath`。菜单项类型增加可选的
`isAvailable(filePath)` 谓词，让绝对路径项可以在渲染时拒绝某个路径；文件树和
`SessionFileActionsMenu` 都按它过滤，因此该决策仍留在唯一模型中，而不是在每个界面重新推导。

`lib/session-local-file-path.ts` 中的 `isAbsoluteFilePath` 现在负责绝对路径/UNC 判定，
同时供工作区根解析器和 hook 的 `resolveAbsoluteFilePath` 复用：后者返回解析出的宿主路径、
路径本身（当它本来就是绝对路径）或 `null`。规范的工作区查看器路径本就是相对路径，
因此 `copyRelativePath` 不依赖根目录，在远程会话中同样可用；而当远程会话的工作区根目录
已知时，`copyAbsolutePath` 仍然正确，因为该根目录是所属机器自己的路径，绝不会交给查看者
机器的 shell。

## 备选方案

始终显示绝对路径项、在无法解析时退化为复制其他内容被否决：菜单项复制的内容与标签不符
就是欺骗，现有界面也倾向于隐藏操作而不是让它失败。禁用项被否决，因为共享菜单模型没有
禁用态，而两个界面都能干净地隐藏条目。从绝对路径剥离工作区根以推导相对路径，对文件树和
侧边面板没有必要——它们的规范路径本就是相对路径——反而会引入第二条路径身份规则。

## 验证

`use-session-file-actions.test.tsx` 覆盖两个菜单项、解析出的绝对路径值、绝对路径不可用
的情况，以及本身就是绝对路径的外部路径；`session-local-file-path.test.ts` 覆盖绝对路径/
UNC 判定。验证通过：27 个定向测试、完整的 `@lody/components` 测试套件（487 个文件，
3954 个测试）、`pnpm typecheck`、`pnpm lint`、`pnpm run docs check` 以及三个仓库边界
守卫。单仓库 `pnpm check` 在运行未改动的 `apps/cli` 测试时被环境以 SIGTERM 中断；
中断前未观察到测试失败。
