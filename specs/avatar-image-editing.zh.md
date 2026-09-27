# 头像图片编辑

Status: draft
Translation: current

[English](avatar-image-editing.md)

## 场景

用户选择个人头像或工作区头像后，编辑器会在发起网络请求前打开。用户可
以在固定的正方形选区内拖动图片并调整缩放，然后取消或确认。确认后的结果
通过现有头像接口上传，只有上传和持久化回调成功后才会成为新的头像。

## 职责

- 浏览器沿用现有头像的 MIME 类型、扩展名和大小规则，在打开编辑器前验证
  选择的文件。
- 两种头像都使用正方形选区。个人头像可以显示圆形选区遮罩，工作区头像显
  示方形遮罩，但两者导出的图片数据都是正方形。
- 确认时先把选中的源图片区域渲染为有尺寸上限的 Canvas 文件，再调用现有的
  上传回调。取消、关闭或导出/上传失败时，当前头像保持不变。
- 头像展示使用 cover 填充并保持源图片比例，因此旧客户端上传的头像在编辑
  器未打开时也不会被拉伸。

裁剪是客户端便利功能。服务端仍负责认证和校验上传文件，绕过该编辑器的客
户端仍可能上传非正方形图片。因此，展示规则仍需要覆盖历史头像和外部上传的
头像。

## 交互

编辑器是模态窗口，并为当前选择的文件维护临时 object URL。缩放滑块以及指针
和键盘裁剪交互只更新本地状态。裁剪器报告像素区域前，确认按钮保持禁用；Canvas
导出和上传期间，确认操作保持忙碌。每次 change 事件后都会清空文件输入，因此取
消后可以再次选择同一个文件。

## 证据

实现位于
[`avatar-editor.tsx`](../packages/components/src/components/settings/avatar-editor.tsx)、
[`avatar-crop-dialog.tsx`](../packages/components/src/components/settings/avatar-crop-dialog.tsx)
和 [`avatar-crop.ts`](../packages/components/src/lib/avatar-crop.ts)。导出路径由
[`avatar-crop.test.ts`](../packages/components/tests/avatar-crop.test.ts) 覆盖，组件
状态位于 [`ProfileSettings.stories.tsx`](../packages/components/src/stories/ProfileSettings.stories.tsx)。
