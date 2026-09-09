# language: zh-CN

功能: Agent Role 执行目标冻结

  @lody @P1 @essence @runtime-simulator @LODY-ROLE-001
  场景: 用户用 Agent Role 创建 Session 后编辑并删除 Role
    假如 已配置确定性 Agent 的隔离桌面用于 Agent Role 旅程
    当 用户创建并在 composer 选择一个 Agent Role
    并且 用户用该 Role 启动一个等待中的 Session
    那么 Session 接受时冻结 Role 标识、版本和精确执行目标
    当 用户在 dispatch 后编辑该 Agent Role
    那么 等待中的 Session 仍保留接受时冻结的 Role 配置
    当 用户删除该 Agent Role 并让 Session 完成
    那么 Role 目录项和 Session 均可被永久清理
