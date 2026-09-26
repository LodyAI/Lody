# 前端头像裁剪编辑器

Status: implemented
Translation: current

[English](2026-09-26-avatar-crop-editor.md)

## 摘要

头像上传之前会直接发送用户选择的源文件，调用方无法选择正方形构图。设置
页面现在会在上传前打开支持拖动和缩放的正方形编辑器，并导出受尺寸限制的
Canvas 文件；头像展示继续使用 cover 填充，兼容历史上的非正方形上传。对比
现有 React 裁剪库后选择了 `react-easy-crop`；客户端编辑仍然是便利功能，并
没有把服务端改成正方形图片契约。

## 决策

交互层使用 `react-easy-crop` 6.2.3。它以较小的依赖提供指针、触摸、键盘和缩放
行为，不需要维护命令式裁剪器实例。`react-image-crop` 更轻量，但缩放和媒体定位
需要调用方自行完成；`react-cropper` 功能更多，却会引入 CropperJS 和命令式集成
模型，超出头像流程的需要。

`AvatarEditor` 先验证原始文件、打开 `AvatarCropDialog`，只有
`cropAvatarFile` 将选中的像素区域渲染完成后，才调用现有上传回调。个人头像和工
作区头像共用正方形比例，个人头像预览使用圆形遮罩。当浏览器编码得到的 PNG 或
WebP 文件在头像一兆字节限制内时保留原格式；其他图片使用 JPEG，Canvas 输出不
支持或过大时尝试使用受限的 JPEG。现有 `@lody/ui` 头像原语已经使用
`object-fit: cover`，因此没有再添加单独的展示补丁。

行为记录在[头像图片编辑 Spec](../../../../specs/avatar-image-editing.zh.md)中。

## 证据与限制

导出测试覆盖正方形输出尺寸、源图片区域传递、JPEG 背景处理、文件名/类型转换
以及 object URL 清理。Storybook 在现有头像状态旁增加了打开裁剪器的状态。定向
导出测试通过两项测试，定向类型感知 Oxlint 零诊断，格式化和翻译键检查均通过。

由于当前 checkout 中 ACP 扩展子模块目录没有 package manifest，完整 workspace
类型检查无法完成；隔离安装依赖时也只能使用当前环境可取得的包元数据。浏览器中
真实指针交互和不同原生图片解码器的差异不在本次验证范围内。
