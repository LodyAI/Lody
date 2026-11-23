# 会话切换时的消息头像连续显示

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1736

[English](2026-10-20-message-avatar-switch-continuity.md)

## 摘要

切回会话、滚动虚拟化消息行或将待发送消息交接为已水合历史时，消息头像与多成员发送者名称可能短暂回退为占位或消失。`use-stable-avatar-src.ts` 预加载稳定头像实际使用的缓存 blob 并在渲染期同步派生来源更新；`useWorkspaceSenderProfile` 与 `lib/workspace-sender-identity.ts` 则在同账户／工作区范围内跨卸载与重载保留成员目录及发送者资料。同一 Chromium 隔离实验中，首次切回 blob 从占位图变为立即显示已加载图片，前后均只有一次头像 HTTP 请求。解码异步进行且仅针对实际使用的头像，缓存读取和首次显示不等待；确实缺失的资料仍保留占位。

## 职责与本次范围

`lib/avatar-cache.ts` 拥有按规范化 URL 索引的渲染进程内存缓存、有界 IndexedDB
`lody:avatar-image-cache` 持久存储（兼容迁移 `lody-avatar-image-v2` CacheStorage，
使打包态 Electron `file://` 与移动端 `capacitor://` 来源同样可靠持久化），以及同步
`lody:avatar-cache-index` 键索引。超过 24 小时后的读取先返回旧图，再后台校验；字节
不变则保留现有 URL。导航不会清理该缓存，可恢复缓存清理会一并移除存储与索引。

`hooks/use-stable-avatar-src.ts` 在新页面或新窗口挂载时尚未完成异步预热的情况下，
若 `hasPersistedAvatar` 命中本地持久记录则抑制远程 `<img>` 网络请求并直接切至本地
blob；仅对首次见到的冷头像保留原始远程 URL 并发起后台填充。它在填充完成或实际使用
恢复条目时预加载离屏 `Image`（异步解码），且 `useWorkspaceMembers` 会预热当前工作区
成员头像。已预热条目的替换也会预热新条目；仅启动恢复本身不会解码所有已存图片，首次
显示与缓存读取均不等待解码。

Hook 还将输入身份与解析结果一起保存。新来源、移除来源和刚取得的来源在渲染时直接
派生当前值。因此来源变化不会提交上一个用户的图片，也不需要等待 effect 才选择已经
可用的图片。后台状态更新继续遵循原有来源清理边界。

`UserAvatar` 仍然将图片就绪和坏图占位交给 `@lody/ui` 与 Base UI 1.7.0。
它的同步 `complete` / `naturalWidth` 路径可以复用已预热图片。完全冷的图片、尚未
完成的预加载或浏览器内存压力淘汰，仍可能需要正常加载占位。

[发送者身份决策](../feature/2026-09-08-chat-sender-identity.md)和
[UI 头像迁移](../feature/2026-09-13-ui-avatar-kbd.md)仍然适用。

## 合成浏览器证据

实验基于 `4cc74cae8` 及工作区已有的无关改动，使用 Node 24.14.0 和无界面的
Chromium 145.0.7632.6。临时 Vite 页面导入生产 `UserAvatar`、稳定来源 Hook、
缓存和 UI 原语。唯一头像是本地生成的合成 SVG，不涉及产品数据或外部图片服务器。

| 状态                                                                      | 修复前：立即／下一帧 | 修复后：立即／下一帧 |
| ------------------------------------------------------------------------- | -------------------- | -------------------- |
| 原始 URL 已加载、blob 字节已缓存；切到没有头像的界面后返回，首次使用 blob | 占位／占位           | 已加载／已加载       |
| 同一个 blob 已解码，资料就绪，再次返回                                    | 已加载／已加载       | 已加载／已加载       |
| blob 仍然热缓存且已解码，但返回时缺少资料                                 | 占位／占位           | 占位／占位           |
| 为该已挂载头像补上资料                                                    | 占位／已加载         | 已加载／已加载       |

前后两次实验各只有一次头像 HTTP 请求到达本地服务器。第一次返回前，原始 URL
已经加载；每次实验内的两次返回复用同一个缓存 blob URL。样本观察绘制前的 DOM
可用状态，不是像素呈现测量，也不保证延迟帧数。已解码的热返回在修复前就能立即
显示，不能说每次 Base UI 重新挂载都会闪。

## 生命周期与 Effect 评估

稳定来源 Hook 触发预加载，共享缓存条目拥有图片及解码。组件卸载会阻止其本地更新，
但不终止其他头像可能使用的共享图片。沿用已有的条目替换、对象 URL 延迟撤销和内存
清理职责释放资源。解码拒绝被处理，保留已有占位。每个实际使用的缓存头像保留一个
图片对象；解码像素是否继续保留仍由浏览器控制。UI 交接前不增加新的等待。

Effect 功能／修复评估：本次是在已有 Promise 缓存中修正浏览器适配和 React 来源
派生。完整原生单元还需改变抓取、后台校验、持久化和应用所有权，超出这个小范围行为
修复，因此延后迁移，不增加运行时或依赖，也不改变迁移台账。

## 发送者资料连续性

`ai-gui/index.tsx` 与 `SessionChatInterface` 通过 `useWorkspaceSenderProfile`
（`hooks/use-workspace-sender-profile.ts`）及 `lib/workspace-sender-identity.ts`
解析人类发送者。若缺少 `user.image` 或 `user.name`，按行订阅的 `auth:getUserById`
在虚拟列表卸载或会话切换后重连期间既无法命中图片缓存键，也会使多成员用户行的发送者
名称短暂消失。

`useWorkspaceSenderProfile` 优先采用实时 `auth:getUserById` 结果（含显式 `null`
以清理已删除账户），在加载期间依次回退到保留的发送者资料、同范围 `useWorkspaceMembers`
成员目录以及匹配的 `userAtom` 当前登录用户。保留项按 CloudApi 实例、账户 ID 与工作区
ID 隔离（生产云适配器写入持久缓存并纳入 `clear-local-cache.ts`），账户、工作区或适配器
切换会立即丢弃旧标签，不放宽任何授权查询的过期访问保护。

## 验证与限制

`tests/avatar-cache.test.ts`、`tests/use-stable-avatar-src.test.tsx`、
`tests/user-message-sender-identity.test.tsx` 与
`tests/session-pending-message-row.test.tsx` 覆盖了原图首次显示、预热与离线持久恢复
返回、解码失败、来源首次提交到达／移除、`auth:getUserById` 返回前的成员目录名称兜底、
虚拟行重挂载与冷重载保留、显式 `null` 删除清理、跨账户／工作区隔离，以及待发送消息到
已提交历史的连续交接。浏览器内存压力淘汰与真机帧耗时分布仍未测量。
