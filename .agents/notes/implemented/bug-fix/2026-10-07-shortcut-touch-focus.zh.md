# Prompt Shortcut 触摸聚焦顺序

Status: implemented
Translation: current

[English](2026-10-07-shortcut-touch-focus.md)

## 摘要

移动端触摸 Prompt Shortcut 时，菜单可能闪一下却没有插入 Prompt。WebKit 在点击前让输入框失焦，重新聚焦时又短暂暴露第 0 位光标，因此先启动异步准备、再聚焦会取消刚启动的请求。现在行选择先恢复焦点和保存的选区，再启动准备；准备期间保持菜单打开以显示加载和错误信息。手机和平板尺寸的 WebKit 浏览器测试通过，尚未验证真实 iOS App。

## 原因与决策

观察到的顺序为 `触摸 → 失焦 → 点击 → 准备 → 聚焦（光标 0）→ 取消`。临时的第 0 位光标导致查询关闭，选区恢复后又重新打开，表现为闪烁。这与下载耗时无关：立即返回准备结果也能复现。

`MentionItem` 保存选区两端，聚焦并恢复选区，然后调用 `onMentionAdd`。`MentionRoot` 在准备开始时重新打开菜单，确保临时关闭查询不会隐藏加载和重试反馈。现有中止信号和代次保护继续拒绝编辑、关闭及过期结果。修复调整聚焦顺序，不放宽取消机制，也不引入延时。此前的[正文预取](../feature/2026-09-29-prompt-shortcut-body-prefetch.zh.md)减少下载等待，但不能避免本次取消。

## 验证

导航测试用显式 Promise 完成信号和 WebKit 临时聚焦光标模拟，覆盖浮动／停靠菜单选择、准备失败以及完成前关闭菜单。新增四例在原代码上均因请求已经被中止而失败。已有菜单／导航测试共 59 例通过。

新增的 Shortcut Storybook 示例及 Playwright 触摸测试在 390px、820px 的 WebKit 下通过，检查插入文本、保留焦点和提交后菜单关闭。

组件全量测试通过，共 556 个文件、4,836 项测试。全仓类型检查、lint、格式化、i18n、导入／平台／公共仓库边界检查以及文档检查通过。完整 `pnpm check` 在两项未修改的 CLI 测试中停止：进程组终止报 `kill EPERM`，递归 Git 传输被环境中的 Git 凭证包装器以 `context_unreadable` 拒绝。
