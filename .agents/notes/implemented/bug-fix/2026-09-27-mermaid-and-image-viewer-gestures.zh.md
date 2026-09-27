# 稳定图片与 Mermaid 查看器手势

Status: implemented
Translation: current

[English](2026-09-27-mermaid-and-image-viewer-gestures.md)

## 摘要

共享图片灯箱中，点击图片可能在原缩略图仍处理同一次点击时关闭查看器并再次打开，垂直拖动
也可能进入灯箱的下拉关闭动画。Mermaid 全屏查看器则没有触摸双指缩放路径，居中溢出的超大
图表还可能把边缘推到不可见位置。现在图片点击和下拉关闭均被禁用，Mermaid 查看器在自身表面
接管单指平移与双指缩放，并使用安全溢出对齐。

## 决策

继续使用共享的 `react-photo-view` 图片查看器。`photoClosable={false}` 让图片保持为平移/缩放
表面，工具栏和背景仍是退出方式；`pullClosable={false}` 防止垂直平移变成关闭动画。

Mermaid 全屏表面仅在该表面设置 `touch-action: none` 并使用 Pointer Events。单指更新滚动偏移，
双指围绕手指中心缩放并跟随中心移动。内嵌预览保留浏览器原生触摸行为，点击仍打开全屏查看器。
查看器包装器使用安全居中对齐：适合视口的图表保持居中，超大图表从可达边缘开始。

没有选择继续把触摸交给浏览器滚动，因为全屏查看器无法提供双指缩放；也没有把触摸输入带到
消息内嵌预览，因为那会抢走会话滚动。

## 验证

`packages/components/tests/markdown-mermaid-fullscreen.test.tsx` 的 34 项测试全部通过，覆盖单指
平移、双指缩放、触控板捏合和背景关闭保护。`packages/components/tests/image-preview-context-menu.test.tsx`
的 9 项测试全部通过，包含图片点击不得关闭查看器的回归测试；定向 Oxlint 也没有发现问题。当前
工作树没有已安装的包管理器或本地依赖，测试通过临时依赖链接运行。完整 `tsgo` 检查仍被无关的
Electron/ACP 工作区缺失包阻塞，仓库文档检查仍保留这些文件之外原有的断链。
