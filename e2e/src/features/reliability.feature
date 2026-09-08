# language: zh-CN

功能: Electron Renderer 生命周期可靠性

  @lody @P1 @essence @runtime-none @LODY-RELIABILITY-001
  场景: 网络抖动广播撞上 Renderer 销毁时主进程继续运行
    假如 本地数据平面已连接 Renderer
    当 网络抖动发生在 Renderer 存活检查和 loro.status 广播之间
    那么 Electron 保持运行并在重连后继续响应
