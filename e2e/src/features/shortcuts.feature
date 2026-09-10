# language: zh-CN
@lody @essence @P0 @runtime-none @LODY-SHORTCUT-001
功能: 桌面应用快捷键

  场景: 用户改绑同步到另一个窗口并在 renderer 重载后保持一致
    假如 用户已进入一个隔离的本地 workspace
    那么 默认命令面板和设置快捷键可用
    当 用户打开第二个 workspace 窗口
    那么 第二个窗口中的默认快捷键也可用
    当 用户把切换侧栏改绑到一个带 Shift 的数字键组合
    那么 两个窗口中的旧绑定都停止生效且新绑定立即生效
    当 第二个 renderer 重新加载
    那么 第二个窗口中的用户改绑仍按相同的物理键生效
