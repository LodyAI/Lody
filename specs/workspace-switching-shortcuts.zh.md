# 工作区切换快捷键

Status: draft
Translation: pending

桌面多工作区用户可用一个数字快捷键进入指定工作区，无需展开侧栏。数字 1–9 是可配置 slot，默认绑定为 `Mod+1..9`；`Mod` 在 macOS 表示 Command，在其他桌面平台表示 Control。Web、移动端和公开 local-only 桌面组合不承诺多工作区切换能力。

## Slot 身份

首次得到可导航的工作区列表时，客户端按当时的目录顺序填充最多九个 slot，随后持久化 workspace ID。目录重排不得改变已有编号；失去访问权限或删除工作区只清空它所在的 slot，不得让后续编号前移。同一 workspace ID 最多占一个 slot，用户在键盘快捷键设置中把它分配到新 slot 时，旧 slot 同时清空。

Slot 是按用户隔离的设备偏好，不写入 workspace 数据或跨设备同步。同一桌面 session 的多个 renderer 共享 localStorage；任一窗口修改后，其他窗口必须在不重载的情况下使用新映射。损坏或引用不可用 workspace 的存储值被当作未分配，不触发未知路由。

## 命令与切换

只有已分配且当前可访问的 slot 注册应用命令。命令通过统一 registry 和 `useCommand` 接入，因此出现在键盘快捷键设置中，并复用普通应用命令的录制、解绑、平台标准化及应用内/操作系统全局冲突检测。默认数字绑定只在 Electron 生效；用户改绑完整替换该命令默认值。

选择当前工作区是成功的无操作，保留当前页面或 Session。选择其他工作区时，一个统一入口更新 preferred slug 和当前 slug/ID 上下文，请求激活对应 organization，并只把接收操作的窗口导航到目标工作区首页。侧栏、移动选择器、旧 organization selector、数字命令和后续 swipe 手势不得各自复制这组状态写入。

## 后续手势

Issue #288 的侧栏 swipe 仍是后续工作。手势只负责方向、阈值、防误触与边界判断；确定目标后必须调用相同的 workspace-ID 切换入口，不得按渲染位置直接拼路由。

## 验证边界

组件测试使用两个合成工作区覆盖真实状态边界、slot 稳定性、删除、重新分配、用户隔离和跨窗口 storage 更新。公开 OSS Electron E2E 只能启动一个隐式本地工作区，因此它验证真实 renderer 中 slot 命令注册、默认绑定和多窗口可见性，但不能伪造云端第二工作区；跨工作区导航由组件集成测试承担。

需求：[Issue #288](https://github.com/LodyAI/Lody/issues/288)。
