# language: zh-CN

功能: Session 目标控制

  @lody @essence @P1 @runtime-simulator @LODY-GOAL-001
  场景: 用户跨会话管理、恢复并清理持久化的 Session 目标
    假如 已配置目标控制用的确定性 Agent 隔离桌面
    当 用户启动一个持续运行的目标 Session
    那么 用户能看到运行中的目标及其可用控制
    当 用户在第二个 Session 中完成独立工作后返回目标 Session
    那么 两个 Session 的目标状态和 ACP 事件彼此隔离
    当 用户暂停运行中的目标
    那么 Pause 通过 ACP 控制请求到达且目标显示为已暂停
    那么 重复或当前状态不允许的目标操作不会产生错误状态
    当 用户更新已暂停目标的目标和用量元数据
    那么 ACP 更新快照和 UI 显示更新后的目标元数据
    当 用户恢复已暂停的目标
    那么 Resume 通过带目标元数据的 ACP prompt 恢复目标
    当 用户重新加载桌面界面并重新打开该 Session
    那么 更新后的活动目标在界面重载后仍然存在
    当 用户暂停已重载的目标并清理它
    那么 状态机完成暂停到清理且非法后续操作不会留下错误状态
    当 用户归档并恢复已清理的目标 Session
    那么 恢复的 Session 保留已清理目标且两个 Session 最终从 UI 中消失
