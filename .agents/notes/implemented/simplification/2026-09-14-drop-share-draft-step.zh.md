# 删除分享流程中单独的草稿步骤

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/682

[English](2026-09-14-drop-share-draft-step.md)

## 摘要

编辑器关闭后遗留的分享草稿已没有可用上传凭据，唯一可行的下一步就是撤销它并发布新副本。
对话框此前会显示一个专门的未完成草稿页，其唯一操作是放弃草稿，然后回到设置页让用户再点
一次。现在直接渲染设置页，发布操作会在冻结和开始新部署之前撤销过期草稿。打开对话框仍然
不改变任何状态，服务端“先撤销再准备新副本”的规则得以保留。

## 决策

`session-share-manager.tsx` 移除 `stale-draft` 步骤及其三个文案键。
`use-session-share-management.ts` 新增不包 `run` 的 `revokeDeployment`，并在发布 `run`
内部、`capture` 之前调用它，且仅在没有重试包时调用。重试路径不变：待发布包复用已冻结的
凭据，不执行撤销。

取舍在于用户只看到一个“分享对话”按钮，而不是“放弃并重新分享”，也不会知道曾有过一次失败
尝试。该尝试从未发布且凭据不可恢复，撤销是客户端唯一正确的操作。打开对话框即撤销被否决，
因为它会在没有人类操作的情况下改变服务端状态，并短暂显示一个从未存在过的链接的撤销提示。

## 验证

移除三个未使用的草稿键后，`node scripts/check-i18n.mjs` 通过。`@lody/components` 完整测试
套件通过（462 个文件、3519 个用例），其中包括断言草稿发布变更顺序为 `revoke`、
`beginDeployment`、`publishDeployment` 的新 hook 测试；`tsgo --noEmit` 与 oxlint 也通过。
未运行完整的 workspace `pnpm check`。
