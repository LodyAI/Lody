# 恢复意外合入 Roost 后的主线

Date: 2026-10-08
Status: implemented
Translation: current
PR: [#1323](https://github.com/LodyAI/Lody/pull/1323)

[English](2026-10-08-accidental-roost-merge-recovery.md)

## 摘要

一次意外合并把 Roost 历史实现带入了 main。随后以第一个父提交为基准的回滚保留了 Roost，反而撤掉了已经合入的 mention 修复，因此历史测试仍然失败。本次恢复 mention 修复、撤掉误入的 Roost 改动，并保留后续的 Daily journey 修复。源码树已核对为误合并前的主线加上该后续修复；这次恢复源码，不迁移已存储的数据。

## 父提交选择与恢复

合并提交 `d2aa65d0decc8a2f0bb885f28914b87133f238ec` 的两个父提交为：

- 父提交 1：`4221bda0178cef160712416bbdeb8b124b667f8e`，包含 Roost 功能。
- 父提交 2：`eb761ddc820db943eda2f87e37cb8d48a4180668`，是误合并前的 main，包含
  [mention 修复 #1317](https://github.com/LodyAI/Lody/pull/1317)。

回滚提交 `dc39c91f870a546ac3458dab394051294afe0db7` 明确以父提交 1 为基准撤销合并，其源码树与该父提交相同，因此 Roost 留了下来，而 mention 修复消失了。恢复时先撤销这次错误回滚，再以父提交 2 为基准撤销合并。两步操作在 main 的 `696fc4f2daa47526f57427175ca0bc1be1b330be` 上均无冲突。

恢复后的源码树为 `97d671674d4f19e06e1b51f052ace4b670a71023`。它相对父提交 2 的二进制 diff 与
[Daily journey 修复 #1318](https://github.com/LodyAI/Lody/pull/1318) 的六文件 diff 完全相同。
无需 reset 或改写历史。Git 的祖先关系仍记录已撤销的功能；将来正式接入 Roost 时，需要显式重新引入被撤销的改动。

## 证据与验证

- [误合并前的主线 CI](https://github.com/LodyAI/Lody/actions/runs/37741828178)
  所有任务均通过。
- [错误回滚后的 CLI 测试](https://github.com/LodyAI/Lody/actions/runs/37745040263/job/113204399405)
  在六个文件中失败了 30 项，包括 Roost 后端不可用、Linux 凭据存储服务缺失等错误。
- [错误回滚后的组件测试](https://github.com/LodyAI/Lody/actions/runs/37745040263/job/113204399358)
  在初始会话断言中失败：期望 `historyBackend: "loro"`，实际为 `"roost"`。
- 合并提交、错误回滚和后续主线提交的 CLI 失败相同。已有行为测试覆盖恢复后的历史契约；本次没有引入新的源码行为或测试实现。
- 本地 `pnpm check`、`pnpm format`、`pnpm format:check` 和文档检查均通过。CLI 套件通过 3,504 项，组件套件通过 4,881 项；包含原失败测试的七个套件均通过。PR 检查在发布后运行。本地未执行桌面打包或浏览器/Electron journey。

[Roost 提案](../../proposed/architecture/2026-09-30-roost-transition-delivery-lifecycle.zh.md)
仍为 proposed。本次恢复不批准该架构，也不声称已经迁移正在运行的安装或 Roost 创建的会话。
