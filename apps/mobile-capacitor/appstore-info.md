# App Store Information — Lody

ASO-optimized listing for the Apple App Store. Generated with the
`appstore-info-generator` skill, then optimized for Lody's positioning
(remote control for every coding agent) and search.

> **What actually drives App Store search (ASO):** only the **Title (30)**,
> **Subtitle (30)**, and **Keywords (100)** are indexed by Apple's search
> algorithm. **Promotional Text (170)** and **Description (4000)** are _not_
> indexed — they are for conversion, so they read like marketing, not keyword
> lists. Apple automatically forms multi-word search phrases by combining
> single words across Title + Subtitle + Keywords (e.g. `remote` + `control`
> → "remote control"; `claude` + `code` → "claude code"), so we never repeat a
> word that already appears in another indexed field.

---

## English (Primary)

**Title** (30 max — indexed) · 26 chars

```
Lody: Remote Coding Agents
```

**Subtitle** (30 max — indexed) · 27 chars

```
Control Claude Code & Codex
```

**Promotional Text** (170 max — not indexed) · 167 chars

```
Your coding agents, now remote-controlled. Run Claude Code, Codex, Gemini & more in parallel on all your machines—review diffs, manage GitHub PRs, ship with your team.
```

**Description** (4000 max — not indexed)

```
Lody is the remote control for your coding agents. Start a task from your phone, and Claude Code, Codex, or any CLI agent runs it on your own computer or server—then review every change, anywhere.

■ One remote for every coding agent
• Works with Claude Code, Codex, Gemini CLI, OpenCode, Kimi, and any ACP-compatible agent
• Bring your own subscription or API key—Lody runs the agents on your machines, with your models
• Switch models, modes, slash commands, and Fast Mode right inside the chat

■ Control all your computers and servers
• Connect every laptop, dev box, and cloud server to one account
• Start a session on any online machine from your phone or browser
• Machines stay private by default—share a build server or cloud worker with your team in one tap
• Daemon mode keeps agents running in the background and recovers automatically after a restart

■ Run agents in parallel, safely
• Every task gets its own isolated Git worktree—no collisions between parallel runs
• Sandboxed execution with native runtime controls and fewer permission prompts
• Session tabs keep the main chat, sub-agents, files, and diffs together in one view

■ Review everything from anywhere
• Each turn ends with an in-context diff, so you can review without opening your IDE
• A real-time file tree and project file browser stay synced with the working directory
• Search inside a conversation across messages, tool calls, terminal output, and diffs
• VS Code themes give you familiar code and diff colors
• Lody Preview opens a live UI preview with desktop, tablet, and mobile viewports—drop visual annotations and send them straight back to the agent

■ GitHub, built in
• Start a task from any Issue or Pull Request with a simple #mention
• PR status, CI checks, and review comments sync automatically—no tab-switching
• Mark drafts ready for review, merge, and delete branches without leaving Lody
• Leave line comments on diffs and sync them to GitHub PR Review; replies post back both ways
• Auto commit & push and "Fix PR comments" keep your branch moving
• Act as yourself on GitHub for comments, reviews, and merges

■ Built for your team
• Share agent configs and full conversation context so everyone stays aligned
• Invite members, set roles, and view your teammates' sessions
• Track AI token usage and cost by member

■ Made for mobile
• Native iOS and Android apps designed for small screens
• Live Activities on iPhone show running agent status on the Lock Screen and Dynamic Island
• Push notifications when a task finishes, an agent needs approval, or a PR is ready
• Approve permissions, review diffs, and reply on the go
• Works offline for cached conversations and saved diffs

Install Lody, run `npx lody daemon start` on your machine, and take your coding agents with you—everywhere.
```

**Keywords** (100 max — indexed) · 99 chars

```
vibe,gemini,opencode,kimi,cli,AI,github,PR,review,diff,terminal,ssh,parallel,acp,mobile,ci,worktree
```

---

## 简体中文 (Simplified Chinese)

**标题 / Title** (30 max — indexed) · 16 chars

```
Lody - 远程操控编程智能体
```

**副标题 / Subtitle** (30 max — indexed) · 26 chars

```
随时随地运行 Claude Code 与 Codex
```

**推广文本 / Promotional Text** (170 max — not indexed)

```
用手机远程操控 Claude Code、Codex 及所有编程智能体。在你的每一台电脑和服务器上并行跑任务，随时查看 diff、管理 GitHub PR，和团队一起把需求做到合并。
```

**描述 / Description** (4000 max — not indexed)

```
Lody 是你所有编程智能体的远程遥控器。在手机上发起任务，Claude Code、Codex 或任意 CLI 智能体就会在你自己的电脑或服务器上执行，而你可以随时随地审阅每一处改动。

■ 一个遥控器，掌控所有编程智能体
• 支持 Claude Code、Codex、Gemini CLI、OpenCode、Kimi 以及任意兼容 ACP 的智能体
• 用你自己的订阅或 API Key——Lody 在你的机器上、用你的模型运行这些智能体
• 在对话中直接切换模型、模式、斜杠命令与 Fast Mode

■ 管理你的每一台电脑和服务器
• 把所有笔记本、开发机与云服务器接入同一个账号
• 从手机或浏览器，在任意在线机器上发起会话
• 机器默认私有——一键把构建服务器或云端 Worker 共享给团队
• 守护进程模式让智能体在后台持续运行，异常退出也能自动恢复

■ 并行运行，安全可控
• 每个任务独享一个隔离的 Git worktree——并行运行互不干扰
• 沙箱化执行，配合原生运行时控制，更少的权限打断
• 会话标签页把主对话、子智能体、文件和 diff 收纳在一处

■ 随时随地审阅一切
• 每一轮回复都附带上下文内 diff，不必回到 IDE 就能 review
• 实时文件树与项目文件浏览，始终与工作目录同步
• 会话内搜索：消息、工具调用、终端输出与 diff 一并可搜
• VS Code 主题，代码与 diff 配色一如既往
• Lody Preview 实时预览，可在桌面 / 平板 / 手机视口间切换，圈选元素写批注并直接回传给智能体

■ 深度集成 GitHub
• 用 #提及 任意 Issue 或 Pull Request，直接据此开始任务
• PR 状态、CI 检查与评审评论自动同步，无需来回切换标签页
• 在 Lody 内把草稿转为可评审、合并 PR、合并后删除分支
• 在 diff 上写行内评论并同步到 GitHub PR Review，双向回复
• 自动 Commit & Push 与「修复 PR 评论」，让分支持续推进
• 以你本人的 GitHub 身份进行评论、评审与合并

■ 为团队而生
• 共享智能体配置与完整对话上下文，让团队始终保持一致
• 邀请成员、设置角色、查看队友的会话
• 按成员统计 AI Token 用量与成本

■ 专为移动而生
• 原生 iOS 与 Android 应用，为小屏精心设计
• iPhone 实时活动（Live Activities）：锁屏与灵动岛随时显示智能体运行状态
• 任务完成、智能体请求授权、PR 可评审时推送通知
• 在路上即可批准权限、审阅 diff、回复消息
• 离线也能查看缓存对话与已保存的 diff

安装 Lody，在你的机器上运行 npx lody daemon start，把你的编程智能体随身带走——无处不及。
```

**关键字 / Keywords** (100 max — indexed) · 95 chars

```
claude code,codex,gemini,vibe coding,AI编程,编程助手,代码智能体,远程控制,终端,服务器,并行,代码评审,github,cli,自动化,团队协作,PR
```

---

## 繁體中文 (Traditional Chinese)

**標題 / Title** (30 max — indexed) · 15 chars

```
Lody - 遠端操控程式代理
```

**副標題 / Subtitle** (30 max — indexed) · 26 chars

```
隨時隨地執行 Claude Code 與 Codex
```

**宣傳文字 / Promotional Text** (170 max — not indexed)

```
用手機遠端操控 Claude Code、Codex 及所有程式代理。在你的每一台電腦與伺服器上並行執行任務，隨時查看 diff、管理 GitHub PR，與團隊一起把需求做到合併。
```

**描述 / Description** (4000 max — not indexed)

```
Lody 是你所有程式代理的遠端遙控器。在手機上發起任務，Claude Code、Codex 或任意 CLI 代理就會在你自己的電腦或伺服器上執行，而你可以隨時隨地審閱每一處變更。

■ 一個遙控器，掌控所有程式代理
• 支援 Claude Code、Codex、Gemini CLI、OpenCode、Kimi 以及任意相容 ACP 的代理
• 使用你自己的訂閱或 API Key——Lody 在你的機器上、用你的模型執行這些代理
• 在對話中直接切換模型、模式、斜線指令與 Fast Mode

■ 管理你的每一台電腦與伺服器
• 把所有筆電、開發機與雲端伺服器接入同一個帳號
• 從手機或瀏覽器，在任意上線的機器上發起工作階段
• 機器預設私有——一鍵把建置伺服器或雲端 Worker 分享給團隊
• 常駐模式讓代理在背景持續執行，異常結束也能自動復原

■ 並行執行，安全可控
• 每個任務獨享一個隔離的 Git worktree——並行執行互不干擾
• 沙箱化執行，搭配原生執行階段控制，更少的權限打斷
• 工作階段分頁把主對話、子代理、檔案與 diff 收納在一處

■ 隨時隨地審閱一切
• 每一輪回覆都附帶情境內 diff，不必回到 IDE 就能 review
• 即時檔案樹與專案檔案瀏覽，始終與工作目錄同步
• 對話內搜尋：訊息、工具呼叫、終端機輸出與 diff 一併可搜
• VS Code 佈景主題，程式碼與 diff 配色一如既往
• Lody Preview 即時預覽，可在桌面 / 平板 / 手機視埠間切換，圈選元素寫註解並直接回傳給代理

■ 深度整合 GitHub
• 用 #提及 任意 Issue 或 Pull Request，直接據此開始任務
• PR 狀態、CI 檢查與審查留言自動同步，無需來回切換分頁
• 在 Lody 內把草稿轉為可審查、合併 PR、合併後刪除分支
• 在 diff 上寫行內留言並同步到 GitHub PR Review，雙向回覆
• 自動 Commit & Push 與「修復 PR 留言」，讓分支持續推進
• 以你本人的 GitHub 身分進行留言、審查與合併

■ 為團隊而生
• 共享代理設定與完整對話情境，讓團隊始終保持一致
• 邀請成員、設定角色、查看隊友的工作階段
• 依成員統計 AI Token 用量與成本

■ 專為行動而生
• 原生 iOS 與 Android 應用，為小螢幕精心設計
• iPhone 即時動態（Live Activities）：鎖定畫面與動態島隨時顯示代理執行狀態
• 任務完成、代理請求授權、PR 可審查時推播通知
• 在路上即可核准權限、審閱 diff、回覆訊息
• 離線也能查看快取對話與已儲存的 diff

安裝 Lody，在你的機器上執行 npx lody daemon start，把你的程式代理隨身帶走——無所不及。
```

**關鍵字 / Keywords** (100 max — indexed) · 96 chars

```
claude code,codex,gemini,vibe coding,AI程式,程式助手,程式代理,遠端控制,終端機,伺服器,並行,程式碼審查,github,cli,自動化,團隊協作,PR
```

---

## ASO Notes & Caveats

- **Phrase coverage (English):** Title + Subtitle + Keywords combine to rank
  for `remote control`, `remote coding`, `coding agent(s)`, `claude code`,
  `codex`, `vibe coding`, `gemini cli`, `code review`, `github pr`,
  `ai agent`, `cli agent`, `parallel agents`, and more — without spending a
  keyword slot on any word already in the Title/Subtitle.
- **Third-party names** (`claude`, `codex`, `gemini`, `opencode`, `kimi`):
  used as genuine _compatibility_ claims (Lody really runs these). This is
  normally accepted, but Apple review occasionally flags competitor/brand
  terms. Fallback if rejected: drop the brand from Subtitle to
  `Remote control for coding agents` and remove brand words from Keywords.
- **`worktree`/`acp`/`ssh`** are niche but high-intent for the exact developer
  audience Lody targets; swap for `automation`, `devops`, or `pair` if you'd
  rather chase broader volume.
- **Localization choice:** the China/zh keyword fields keep `claude code`,
  `codex`, `vibe coding` in English on purpose — Chinese developers search
  these terms in English far more than any translation.
- **Maintenance:** Promotional Text can be updated anytime without a new build
  — use it for launch lines, new-runtime support, or seasonal pushes.

```

```
