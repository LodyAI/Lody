# 机器在线标记的呼吸动画

Status: implemented
Translation: current

[English](2026-10-20-machine-online-motion.md)

PR: [#1742](https://github.com/LodyAI/Lody/pull/1742)

## 摘要

用户希望机器卡片原本静态的绿色在线标记具有动态效果。
现在外圈以 2.8 秒为周期匀速放大、匀速缩小并改变透明度，中心绿点保持常亮。
离线机器保持静态；启用减少动态效果时，在线外圈也恢复静态。
本次只改变展示，机器是否在线仍由现有的 presence 状态决定。

## 决定

`WorkspaceMachineAccordionRow` 统一渲染折叠和展开卡片中的标记。
独立的装饰外圈只动画化 transform 和 opacity，圆点的布局尺寸、可访问状态标签及
卡片交互保持不变。使用线性时序，放大与缩小各用 1.4 秒，每个方向的缩放速度保持
恒定。`isOnline` 变为 false 时卸载外圈。循环和减少动态效果偏好
交给 CSS 处理，不增加定时器、逐帧 React 更新或网络请求。
中心始终保持可见，避免动画让在线机器看起来断开了连接。

现有 MachinesDesktopLayout stories 增加受控在线状态预览，使用真实的折叠卡片，
无需真实机器或传输连接即可检查在线和离线切换。

## 验证

现有折叠卡片行为测试通过。组件类型检查、针对修改文件的类型感知 lint，以及修改的
TypeScript 文件格式化通过。浏览器运行真实的 OnlineStatusMotion story，在等间隔的
确定动画时间点取样：每个方向的等间隔时间产生等量缩放变化，中心颜色、中心透明度
及圆点布局尺寸保持不变。另验证了在线／离线／在线切换，以及减少动态效果会取消动画
并保留静态外圈。浏览器录制的两个循环用于动态预览。

完整的 `pnpm check` 通过，包括工作区类型检查、类型感知与 Effect lint、全部配置的
工作区测试、国际化验证和边界检查；`pnpm format` 也通过。文档检查仍有
subagent-events 双语笔记中原有的六个本地 Kimi/Pi 子模块缺失链接。

以下为使用合成机器数据的真实卡片局部录制：

![Linear online halo animation](../../assets/machine-online-motion/linear.gif)
