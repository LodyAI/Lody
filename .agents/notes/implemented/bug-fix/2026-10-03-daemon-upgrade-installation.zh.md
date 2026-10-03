# 将 daemon 升级交接绑定到已验证的安装位置

Status: implemented
Translation: current

[English](2026-10-03-daemon-upgrade-installation.md)

## 摘要

远端升级原先全局安装 Lody，却通过旧 watchdog 的 argv 启动替代 watchdog。
从 npx 缓存启动的 daemon 因此可能反复安装成功，却一直运行旧版。现在安装器
从执行安装的 npm 全局目录返回明确入口，验证入口实际版本，并要求交接后的
就绪回执版本一致。外部自启动定义仍需修正一次；旧 watchdog 下载新版代码
不能追溯改变其自身的交接行为。

## 决策与范围

通过执行全局安装的同一 npm 环境运行 `npm root -g`。读取安装包声明的 bin，
不假设打包布局；校验包身份与指定精确版本（`latest` 则取实际安装版本），
约束解析入口位于包内，并在释放旧 Host 租约前执行该入口的 `--version`。
不采用 PATH 查找 `lody`，因为继承的 npx 或其他 Node 安装路径仍可能选中旧包。

```text
npm install -g -> npm root -g -> 校验 package/bin 及实际入口版本
  -> 释放旧 Host -> 启动明确的安装入口 -> 收到版本一致的就绪回执
```

普通启动继续使用现有 argv，并兼容旧版就绪回执。升级交接将验证后的入口与版本
跨终止边界传递。回执版本缺失或不一致时，沿用针对本次子进程的清理及遵守所有权
的恢复流程，不记录升级成功。不支持版本化回执的旧目标需要明确执行本地重启。
恢复不会还原 npm 已覆盖的包文件。

本修复补充了 [Windows npm shim 修复](2026-09-08-windows-daemon-upgrade.zh.md)：
后者解决命令执行，并未解决目标位置选择。新的
[草案契约](../../../../specs/daemon-upgrade-installation.zh.md)与
[CLI 恢复说明](../../../../apps/cli/README.md#daemon-upgrades-and-autostart)
描述当前行为。不会扫描或改写用户维护的自启动脚本；Windows 与 WSL 的安装
需要分别修复。

## 验证与限制

合成 npm shim 和真实 Node 子进程覆盖安装成功/失败、含空格全局目录、旧 npx
argv、精确版本拒绝、缺失或越界入口、入口版本不匹配、全局目录查询失败、取消、
参数保留及版本化就绪回执。测试不访问 registry，也不执行真实全局安装。
尚未验证真实 npm 文件替换和 Windows/WSL 实机行为；本地测试通过不代表这些
部署保证已得到验证。

四个相关测试套件通过，共 36 项。仓库类型检查、lint、格式化、i18n/import/
platform/public-boundary 检查及 `pnpm run docs check` 通过。
`pnpm check` 在未修改的 `workspace-git-service.test.ts` GitHub remote 回填
断言处中断（CLI：3490 项通过、1 项失败、4 项跳过），该失败单独运行同一
套件也能复现。不宣称其余全仓测试已通过。
