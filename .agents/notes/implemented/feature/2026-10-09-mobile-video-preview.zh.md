# 移动端共用视频文件预览

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1363

[English](2026-10-09-mobile-video-preview.md)

## 摘要

Lody 的文件卡片能够识别 WebM 视频，但移动端文件查看器此前显示不支持的二进制文件提示。
会话查看器和移动端项目文件浏览器现在共用原生视频元素，播放浏览器可以解码的视频容器。
播放器使用已有授权字节或资源 URL，隐藏时停止播放，解码失败时保留文件操作。
远程视频仍受现有的 5 MiB 二进制传输限制；本次不增加转码或大文件传输。

## 决策和职责

- `SessionFileBinaryPreview` 将 WebM、MP4/M4V、MOV 和 OGV 交给静态导入的
  `SessionFileVideoPreview`；移动端项目文件浏览器复用同一播放器。
- `video-file-preview.ts` 将扩展名映射为生成 Blob 时使用的 MIME 类型。
  扩展名只代表候选容器，不保证支持内部编码；真实媒体错误显示本地化提示及调用者已有的文件操作。
- provider 快照继续负责授权和传输。播放器不解析机器路径、不启动 agent、不请求新的云端接口。
- 原生控件提供进度和播放操作，`playsInline` 保持移动端页内播放。不自动播放。
  非活动时卸载媒体元素、清空播放源并释放自行创建的对象 URL。
  应用进入后台时暂停，返回时不自动续播。

```text
已授权的 provider 快照
  → 会话二进制预览 / 移动端项目文件预览
  → 共用视频播放器
    → 资源 URL 或指定 MIME 的 Blob URL
    → 原生播放控件 / 文件操作提示
```

只增加文件类型图标不能实现播放。转码或提高远程传输上限会改变独立的传输契约，因此不在
本次范围内。本次扩展[本地文件契约](../../../../specs/local-file-link-actions.zh.md)，并保留
[原生分享决策](2026-09-14-native-file-sharing.md)中的文件操作模型。

## 验证

生命周期测试扩展 `session-file-binary-preview.test.tsx`；浏览器验收使用 `WebmVideo`
和 `UnsupportedVideo` stories。视频夹具由 FFmpeg 的 `testsrc2` 生成，为 160×90、
两秒的合成 VP8 图案，不含用户录制内容。

已通过：`session-file-binary-preview.test.tsx` 和 `session-file-content-view.test.tsx`
共 51 项测试、组件类型检查、改动范围的 Oxfmt/Oxlint，以及 `pnpm lint:i18n`。
通过以下命令运行的两项 WebKit 浏览器验收也通过：
`pnpm --filter @lody/components exec playwright test tests/e2e/session-video-preview-acceptance.spec.ts --browser=webkit --workers=1`。
验证了 390×844 窄屏下 Blob 字节支持的 VP8 实际播放，以及真实媒体错误后的分享/复制操作。
已检查窄屏截图，控件没有溢出。`pnpm run docs check` 仍报告六处指向未初始化 Kimi/Pi
子模块的既有链接错误，不在本次改动内。`pnpm format` 通过。
`pnpm check` 通过全工作区类型检查和 lint，随后停在无关的 CLI
`github-git-transport.test.ts` 递归 SSH 子模块夹具：本机 Git 凭据助手返回
`context_unreadable`（CLI 测试 3653 项通过、1 项失败）。其余根目录测试未全部完成，
未进行原生壳测试。
浏览器测试不能证明原生 iPhone/Android 壳或已发布应用版本的播放行为。
