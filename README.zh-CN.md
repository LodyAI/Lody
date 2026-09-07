<p align="center">
    <a href="https://play.google.com/store/apps/details?id=ai.lody.android">
        <img src="https://img.shields.io/badge/Google_Play-414141?logo=google-play&logoColor=white"/>
    </a>
    <a href="https://apps.apple.com/us/app/lody-run-code-agent-anywhere/id6761373528">
        <img src="https://img.shields.io/badge/App_Store-0D96F6?logo=app-store&logoColor=white"/>
    </a>
    <a href="https://lody.ai/download">
        <img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=F0F0F0"/>
    </a>
    <a href="https://lody.ai/download">
        <img src="https://custom-icon-badges.demolab.com/badge/Windows-0078D6?logo=windows11&logoColor=white"/>
    </a>
    <a href="https://lody.ai/download">
        <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black"/>
    </a>
</p>

<p align="center">
  <a href="https://lody.ai">
    <picture>
      <img src="./site-docs/public/icon-mac.png" width="128"/>
    </picture>
  </a>
</p>
<h1 align="center">
<a href="https://lody.ai" alt="lody-site">Lody</a>
</h1>
<p align="center">
  <a href="./README.md">English</a> | <b>简体中文</b>
</p>
<p align="center">
  <b>为团队正在使用的 Coding Agents 提供一个共享工作空间。</b>
</p>
<p align="center">
  连接任意机器，通过 ACP 接入任意 Coding Agent。与团队共享对话，并从桌面端、移动端、网页端或 CLI 调度工作。
</p>
<p align="center">
  <a href="https://lody.ai/zh/docs/">
    <b>文档</b>
  </a>
  |
  <a href="https://lody.ai/zh/docs/quickstart">
    <b>快速开始</b>
  </a>
</p>
<p align="center">
  <a aria-label="X" href="https://x.com/intent/follow?screen_name=lody_ai" target="_blank">
    <img alt="" src="https://img.shields.io/badge/X-%23000000.svg?style=for-the-badge&logo=X&logoColor=white">
  </a>
  <a aria-label="Discord-Link" href="https://discord.gg/E8mZtMu38s" target="_blank">
    <img alt="" src="https://img.shields.io/badge/Discord-black?style=for-the-badge&logo=discord">
  </a>
</p>

<p align="center">
  <img src="./site-docs/public/_docs-assets/lody-readme-hero.png" alt="通过 Lody 在桌面端和移动端运行 Coding Agents" width="100%" />
</p>

## 你可以用 Lody 做什么

### 与团队共享 Agent 对话

团队成员可以打开同一个对话，查看完整记录、运行状态、相关文件和代码改动，并直接补充指令，不再需要来回传递截图或粘贴日志。

### 接入你已经在使用的 Agents 和机器

接入 Claude Code、Codex、Kimi、OpenCode 或其他兼容 ACP 的 Agent。继续使用各台笔记本、工作站、服务器和云主机上已有的订阅、登录状态、模型与权限配置。机器默认保持私有，只有所有者主动共享后才会加入团队工作空间。

### 从任意端调度工作

从桌面端、移动端、网页端或 CLI 选择任意已连接的机器来调度工作。权限请求、运行进度、对话和代码改动会在这些入口间保持可见。

## 连接一台机器

在工作站、服务器或云主机上运行：

```bash
npx lody daemon start
```

这条命令会打开登录链接，将当前机器连接到你的工作空间，并让桌面端、移动端、网页端或 CLI 可以向它调度工作。

## 通过 CLI 使用 Lody

CLI 不只是用来连接机器的后台进程。你可以从终端或脚本注册本地项目；查看工作空间、机器、已关联的仓库和 Agent 配置；创建 Session、发送消息、读取历史和状态；以及归档或恢复 Session。支持 `--json` 的命令还可以把 Lody 工作空间中的数据接入你自己的工具。

```bash
npx lody session create --workspace my-team --agent-config codex \
  --repo owner/repo "修复失败的测试"

npx lody session list --workspace my-team
```

完整命令请查看 [CLI 文档](https://lody.ai/zh/docs/cli)。

## 让 Agent 跨对话协调工作

Lody 为 Agent 提供创建或复用其他对话、读取状态和历史、追加指令、取消运行中任务以及取回结果的工具。这样，一个对话就可以承担协调者的角色：你可以先与主 Agent 一起分析 Bug，再让它把调查、实现和测试分别交给多个并行对话。

每个子对话仍然拥有独立的历史和任务状态，Lody 同时会保留它与发起对话之间的关系。你或 Agent 也可以通过 `@` 引用其他对话，把不同 Session 中的工作联系起来。

## 在同一个工作空间中查看代码和运行结果

### 隔离并行任务的代码改动

为不同 Session 创建独立的 Git worktree，让多个 Agents 并行工作而不会混在同一个工作目录中。你可以在标签页中同时打开多个对话、文件、Diff、终端和 Preview，也可以把一个 Session 派生为新的对话或 worktree，探索另一种解决方案。

### 在工作发生的地方查看改动

在对话旁浏览项目文件，查看单轮或整个 Session 的 Diff。你还可以添加行级评论、跟踪 Pull Request 和 CI 状态，并让 GitHub Review 讨论留在产生这些改动的 Agent 附近。

<p align="center">
  <img src="./site-docs/public/_docs-assets/PR-panel.png" alt="在 Agent 对话旁查看 Pull Request 和 CI 状态" width="100%" />
</p>

### 向 Agent 提供视觉反馈

在 Session 中打开正在运行的网页应用，切换不同的响应式视口，并把针对具体元素的视觉批注直接发回给 Agent。

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260507-preview.png" alt="在网页 Preview 中添加批注并发送给 Agent" width="100%" />
</p>

## 更多内置能力

- **Agent Roles** — 与团队共享可复用的 Agent、模型、权限和默认指令配置。
- **附件** — 从桌面端、移动端、网页端或 CLI 发送文件和图片，并接收 Agent 生成的文件。
- **Session 管理** — 搜索、置顶、归档、派生和整理对话，同时保留完整历史。
- **桌面工具** — 使用内置终端、命令面板、自定义快捷键，也可以在外部编辑器中打开文件。
- **移动端控制** — 接收通知、批准权限请求、查看 Diff，并通过 iOS 实时活动跟踪正在进行的工作。
- **用量信息** — 查看上下文、Token 和额度使用情况，以及机器和 Agent 的资源占用。

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260611-island.png" alt="通过 iPhone 实时活动批准 Agent 的权限请求" width="60%" />
</p>

## 不止于对话

共享对话是 Lody 理解项目的起点，但不会是工作空间的全部。

我们计划加入文档和文档沙盒，帮助团队整理需求、保留决策，并与 Agents 一起处理不适合放在单个对话时间线中的工作。随着这些能力发展，它们可以逐渐成为团队共享的上下文，帮助成员理解不只是代码改了什么，还有为什么这样改。

我们希望整个工作空间——而不只是对话——最终成为 local-first。Lody 使用 [Loro](https://loro.dev/) Stack，通过 Loro 和 Flock 表示并同步基于 CRDT 的协作状态。同一套基础可以从对话扩展到文档和未来的其他工作空间工具。我们的目标是让团队上下文更加持久、可迁移，并最终由团队自己掌控。

Lody 仍在走向完整的 local-first 支持。

## 加入社区

欢迎加入 Lody 中文用户群，与团队和其他用户交流、反馈问题、了解新功能。

<p align="center">
  <img src="./packages/components/src/assets/community-feishu-qr.png" alt="Lody 飞书用户群二维码" width="220" />
</p>
<p align="center">
  使用飞书扫描上方二维码加入群聊，或加入我们的 <a href="https://discord.gg/E8mZtMu38s">Discord</a>。
</p>

## 仓库结构

- `apps/cli` — 连接机器并运行 Coding Agents
- `apps/electron` — Lody 桌面应用
- `packages/components` — 工作空间共享 UI
- `packages/platform` — 平台能力与集成
- `packages/shared` — 共享 Schema、协议与工具
- `site-docs` — 官网、文档与博客

如果希望参与开发，请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。
