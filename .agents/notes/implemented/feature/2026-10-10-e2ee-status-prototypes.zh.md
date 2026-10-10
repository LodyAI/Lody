# 加密工作区的纯展示状态原型

Status: implemented
Translation: current

[English](2026-10-10-e2ee-status-prototypes.md)

## 摘要

登录、获得批准、拿到密钥和内容完整是不同条件。两个受控组件通过 Storybook 展示这些差别及逐工作区恢复结果，便于检查界面。所有状态、操作结果和错误影响范围都由调用方提供。这只是可审查的 UI 原型，没有启用加密，也不表示恢复服务已经实现。

## 决策与边界

复用现有 Card、Button、i18n、StyleX 和 Storybook，不引入向导框架，不改变全局运行时服务。范围是[状态组件和预览](../../../../packages/components/src/components/e2ee/README.md)，没有产品入口、依赖变更或后端接线。

恢复文件用于解锁云端加密恢复库，每个工作区有独立恢复身份。资料已保存与某次密钥更新的恢复已验证分别显示，后续更新不会自动标为已验证。账号登录和按钮点击不代表获得权限或密钥。

单文档失败是否暂停整个工作区仍待定。示例展示调用方传入的两种范围，并标记待定。恢复列表的部分完成不替代该错误策略决策。本次不改变密码学、全平台 Beta、持久进度或生产保证。

```text
Storybook 调用方（虚构状态及显式失败结果）
  -> E2eeAccessStatus(state, scope, pending, onAction)
  -> E2eeRecoveryStatus(state, workspaces, pending, onAction)
       -> 现有 Card / Button / 翻译
按钮 -> 只报告意图 -> 调用方提供下一状态
```

## 证据与限制

基线：`a79613633c3cb19e0d31a693c92331c4da1b769c`。复跑命令及预览路径见组件 README。浏览器测试覆盖中英文、小屏/桌面、无障碍结构和键盘重试。等待结果时按钮保留焦点但不能激活；调用方改变状态之前，失败不会消失。测试不使用定时等待或真实数据。

验证结果：8 项浏览器测试通过；组件包现有测试 556 个文件、5010 项通过。组件类型检查、`pnpm check:quick`、`pnpm format`、范围内 Oxfmt 和 `pnpm run docs check` 通过。已查看浅色桌面与深色小屏截图，包括部分恢复卡片。

受限环境中的 `pnpm check` 未通过：shared IPC/host-lease 绑定 socket 报 `EPERM`，CLI 预览和 broker-auth 测试也失败。允许本机 socket/进程访问后，这四个文件复跑全部通过。这不等于全仓全绿；剩余检查链（包括 Electron 测试）未完成。环境问题复跑命令：

```sh
NODE_ENV=test pnpm --filter @lody/shared test tests/local-ipc.test.ts tests/local-cli-host-lease.test.ts
NODE_ENV=test pnpm --filter lody test src/preview/preview-service.test.ts src/session/worktree/worktree-manager-broker-auth.test.ts --maxWorkers=2
```

这些检查不能证明 200% 缩放、 VoiceOver/NVDA 的实际朗读效果、原生平台、真实恢复文件、服务及持久保存已经通过。生产接入和待定错误策略需另行实现和审查。
