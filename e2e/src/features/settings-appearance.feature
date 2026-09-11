# language: zh-CN

功能: Settings 外观主题预览与持久化

  @lody @P1 @essence @runtime-none @LODY-SETTINGS-001
  场景: 用户取消主题预览后已提交主题保持不变
    假如 用户已进入无需模型运行时的隔离桌面并打开 Appearance 设置
    当 用户提交浅色主题
    那么 已提交的浅色主题在重开 Settings 后保持可见
    当 用户预览深色主题后取消
    那么 取消预览不会覆盖已提交的浅色主题
