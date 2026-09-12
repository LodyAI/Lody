# language: zh-CN

功能: Agent Provider 配置生命周期

  @lody @P1 @essence @runtime-simulator @LODY-AGENT-001
  场景: 用户跨配置、重载和 Session 管理 custom command Agent Provider
    假如 用户已进入隔离桌面并准备管理 Agent Provider
    当 用户测试无效 custom command 后取消配置
    那么 失败的 Provider 不会进入目录
    当 用户创建并测试一个 custom command Agent Provider
    那么 新 Provider 在重开 Settings 后保留名称、命令和自定义提示
    当 用户编辑草稿后取消
    那么 已保存 Provider 不受取消的编辑污染
    当 用户保存重命名后的命令和自定义提示并创建第二个 Provider
    并且 用户重载桌面
    那么 编辑后的 Provider 和第二个 Provider 均保持可用，旧名称不会出现在目录或 composer
    当 用户明确选择编辑后的 Provider 创建第一个 Session，再选择第二个 Provider 创建第二个 Session
    那么 两个 Session 的选择和历史彼此隔离，并由各自的 ACP command 与提示完成
    当 用户删除编辑后的 Provider
    那么 catalog 不再提供该 Provider，而既有 Session 保留其完成历史
    当 用户永久删除两个 Session 并移除第二个 Provider
    那么 Session 和 Agent Provider 目录项均被清理
