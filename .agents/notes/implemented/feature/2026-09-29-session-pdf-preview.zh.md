# 会话 PDF 预览

Status: implemented
Translation: current

[English](2026-09-29-session-pdf-preview.md)

## 摘要

大型本地 PDF 过去只会显示通用二进制提示；若把 Electron 自定义资源 URL 直接交给 PDF.js，也会关闭其 HTTP Range 读取。现在会话文件预览使用 PDF.js，并通过自定义 Range transport 从现有的不透明、带版本校验的本地资源中按 64 KiB 分块读取和校验。查看器支持页码导航、缩放和文本搜索，每页画布限制为 8 百万像素；读取或解析失败时回到现有文件操作。远程 provider 的限制没有变化；真实 Electron renderer 的 CORS 路径仍待验证。

## 决策与证据

会话查看器采用 PDF.js；`lody-resource://` 文件使用 `PDFDataRangeTransport`。PDF.js 只把 HTTP(S) URL 视为可使用 Range 的资源，因此直接传入 Electron 自定义 URL 可能导致读取整个文件。Range transport 先读取一个有界数据块，校验 `Content-Range` 和精确响应长度，再响应 PDF.js 的后续范围请求。组件卸载时会中止未完成的请求；不会新增完整文件快照传给 renderer。

Electron 将本地 `.pdf` 资源识别为二进制 `application/pdf`，避免只含 ASCII 的 PDF 被文本页大小限制误判，也避免为文本检测读取文件前缀。资源响应会向跨源读取者暴露 `Accept-Ranges` 和 `Content-Range`。现有文件版本校验、renderer 所属关系和资源撤销机制保持有效。

PDF.js 查看器负责分页渲染，每页画布限制为 8 百万像素。界面提供页码选择、上一页/下一页、缩放和文本搜索。读取或解析失败时使用原有二进制提示卡片和文件操作。字节快照 provider 继续使用既有的有界预览字节，远程文件大小限制不变。

这会让 `@lody/components` 增加 `pdfjs-dist` 依赖。不扩展远程文件传输、不增加 PDF 专用 endpoint，也不放宽本地文件授权。本地资源单测覆盖 PDF MIME 和有界 Range 响应；跨源响应头在服务边界有断言。

## 验证

- PDF Range、解析与预览分发针对性测试：5 项通过。
- Electron 本地文件资源测试：10 项通过。
- `@lody/components` 类型检查和翻译 key 检查通过。
- Storybook 生产构建通过，且成功打包 PDF.js worker 资源。
- 真实 Electron renderer 的 scheme/CORS 路径在当前工作树尚未验证。
