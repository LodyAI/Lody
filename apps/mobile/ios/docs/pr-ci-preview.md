# PR / CI 界面预览

入口：Settings → Debug → GitHub PR / CI 预览。使用真实 NativeChat、
LodyGroupedList、原生 Stack / Toolbar；PR → 检查 → 单项检查逐层 push。
正式会话的右上角现已接入关联 PR；单 PR 直接进入，多 PR 用原生菜单选择。
目录投影读取 OSS `pullRequests` 和独立的 `pullRequestState` CI 提示。
详情、检查和普通评论由 LodyKit 经官方 token broker 读取；写评论使用 operation=write。
凭据不进入新的 RN 接口。仅当前可见 PR 页面在前台每 30 秒刷新，支持手动刷新；
页面共享单一内存快照，离开或切换账号/工作区后丢弃。

Debug 保留默认离线预览，并有空检查、授权失败后重试、评论失败后成功场景。
所有 Debug 动作均不发布真实评论或助手请求。

正式评论成功才关闭编辑器；失败保留草稿，结果不明时停止再次发送并提示先在 GitHub 核对。
“让助手排查”追加到当前会话原生草稿，保留已有文字和附件，不自动发送。
文件变更与提交仍只展示统计；审查、行内讨论、完整运行日志在 GitHub 查看。

## OSS 数据边界

读取本机官方 `LodyAI/Lody` 仓库，基线
`1ce45684a5ee052df68653186c5b2be67ce21cbf`（非最新远端承诺）。

- `packages/shared/src/schema.ts`：`SessionPullRequestMeta` 只保留 `url`、
  `status`，会话 `pullRequests` 是数组。编号 / 仓库从 URL 解析；后续入口需支持多 PR。
- `packages/shared/src/session-comment-types.ts`：详情提供标题、正文、分支、
  `headSha`、增删统计和 mergeability。checks 提供 status / conclusion / htmlUrl，
  没有日志正文或 annotations。单项页面不捏造这些字段。
- `packages/shared/src/github-api.ts`：PR 详情按仓库及编号读取；checks 通过
  `/repos/{repo}/commits/{headSha}/check-runs` 获取。评论、Review、Review thread
  是不同读取结果。后续接入应按 head SHA 关联，避免将旧提交通过状态展示为新提交结果。
- `packages/components/src/hooks/use-github-pr-details.ts`：桌面负责详情缓存及刷新；
  `pr-tab-view.tsx` 消费聚合后的 PR、checks、reviews、threads、issueComments。
- iOS 只定义 RN-safe 本地投影，不从 `@lody/shared` 根入口导入。正式读取应沿用
  LodyKit 的 GitHub / Keychain 边界，不向 RN 或 WebView 暴露凭据。
- 未授权、权限不足、离线缓存、无 checks 和待计算的 mergeability 应各自显示；
  不将缺失或未知状态当作通过。当前实现没有持久化 PR 缓存，离线显示请求错误，
  已读取后刷新失败时明确标记旧内容。检查和评论各限一页 100 项，截断时明确提示。

## 上传图片诊断（未修改）

OSS `apps/cli/src/lib/message-handler.ts` 的上传路径写入助手历史项
`{type: 'image_group', images: [...]}`。`ai-gui/view.tsx` 的
`ImageGroupBubble` 将它渲染成两列缩略图，并接入会话图片预览。
iOS `data-runtime/project.ts` 仅投影单张 `image`，`image_group` 落入
未知类型分支，只剩 itemId/rev/type；`ChatTranscript.swift` 也无该类型的图片行。
完成的助手回合还会把非最终文字项折叠进执行过程，因此不能只补一个 Image 组件。
需要同时补组图片投影和助手附件分组/预览；此次按用户“看看实现”的要求仅诊断。

## 验证

`pnpm verify:ui --app <Debug.app> --case pull-request --language zh-Hans --output .artifacts/pr-ci`

运行会捕获浅色 / 深色的会话入口、PR 详情、检查列表、单项检查，以及返回手势录像。
