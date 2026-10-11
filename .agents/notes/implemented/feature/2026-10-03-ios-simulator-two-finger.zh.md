# 模拟器双指输入

Status: implemented
Translation: current

[English](2026-10-03-ios-simulator-two-finger.md)

## 摘要

此前 viewer 忽略第二指，网关只接受单指消息。现在触屏通过现有 WS/RTC 输入通道发送稳定的双指坐标，交给原生识别缩放、旋转和平移。固定版本 Baguette 已实现 touch2，无需升级运行时。单指切换双指会先结束原触摸，不承诺原生手指身份连续。

## 边界与取舍

两个触点共用现有逆旋转映射，移动按动画帧合并，按下和抬起立即发送。第二指落下先释放单指再启动双指；任一指结束便释放双指，剩余手指须抬起才能重新开始。忽略第三指。鼠标和滚轮行为保持不变；桌面修饰键手势及三指以上暂不实现。

网关验证两个坐标与手势类型，保留租约检查，并在关闭原生连接前发送对应的双指抬起事件。不重放命令。原生 touch1 与 touch2 使用不同 HID 路径，因此不伪造无缝切换。复用固定 viewer，不另加触控层。

## 证据与限制

62 项 viewer、网关及 RTC 定向测试通过，覆盖双指位置、移动合并、额外手指、剩余手指阻断、取消、非法坐标和断线释放。独立对抗审查未发现 P0/P1。临时 iPhone 17 Pro / iOS 26.5 模拟器里的 UIKit 探针接收到两个触点，单指抬起后执行双指按下、移动、抬起，UIPinchGestureRecognizer 完整开始、变化和结束，最终缩放约 1.22。七条原生输入均返回 ok=true；临时设备已关闭并删除。尚未验证真实手机浏览器到远端设备的旋转和平移体验。

Spec：[iOS Simulator preview](../../../../specs/ios-simulator-preview.md)。PR：https://github.com/LodyAI/Lody/pull/1227。
