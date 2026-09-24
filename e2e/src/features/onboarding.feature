# language: zh-CN
@lody @P0 @essence @runtime-none @LODY-ONBOARDING-001
功能: 本地桌面首次启动

  场景: 新用户通过真实 bundled CLI 进入本地 workspace
    假如 一个全新隔离的 Lody Desktop 已启动
    那么 bundled CLI 拥有本地 runtime 并完成 workspace 初始化
    当 用户跳过 Agent 配置并进入本地 workspace
    那么 真实产品会话输入界面可用
