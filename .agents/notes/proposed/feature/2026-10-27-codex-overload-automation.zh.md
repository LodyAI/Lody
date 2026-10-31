# 将 Codex 高负载恢复纳入会话自动化

日期：2026-10-27
Status: proposed
Translation: current

[English](2026-10-27-codex-overload-automation.md)

## 摘要

`recoverCapacity` 会话开关在机器本地的自动化执行方统一处理结构化额度耗尽与 Codex
`serverOverloaded` 错误。满载恢复保留原生 Session 和输入，最多重试三次，最短等待
分别为 5、10、20 秒。开关关闭时保留前端重试，开启时由 Host 负责自动恢复。Claude
的定时继续通过同一个 Session 接收边界去重。

## 边界与验证

只有结构化 Codex `serverOverloaded` 触发满载恢复。Host 在派发前持久化待处理工作，
要求释放和工具边界，并在准入时重新检查 Session、绑定及授权。停止和新输入保持原有
语义；中断和未确认提交使用现有账本恢复。设置作用于后续事件；开启恢复时也会接纳当前输入已记录的失败一次。即使隐藏 beta
界面，前端仍读取该设置，避免启动第二条自动重试。CLI/MCP 的活动记录可查看恢复状态；
会话提示目前只显示条件等待，不显示原生恢复工作。

[自动化协调器](../architecture/2026-10-25-session-automation-coordinator.md)负责持久化
Session 边界。[定时继续](../bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)
仍由 Schedule 执行方负责。合成测试覆盖额度和满载观察在重启后的恢复；真实 Provider 恢复尚未验证。
