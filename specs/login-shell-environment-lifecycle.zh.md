# 登录 shell 环境生命周期

Status: draft
Translation: current

[English](login-shell-environment-lifecycle.md)

GUI 或 daemon 启动继承较短 PATH。Lody 在启动用户工具前探测 interactive login shell，
恢复 profile 安装的工具路径。损坏的 profile 不能用成功的环境 fallback 隐藏进程清理失败。

## 探测所有权与结果

有限原生探测接收 host 选择/环境与进程服务，每个候选命令都有 Scope。本地取消传入命令，
清理完成后返回；未解决的释放失败可观察且保留进程恢复拥有者。Windows、缺失/不支持的
候选耗尽，或 shell 正常结束却没有探测输出，可以返回环境缺失。只有已结束的非零退出或
executable 缺失允许尝试下一候选；其它启动、stream、输出上限、执行超时与释放失败须
保留完整失败及恢复所有权。

所有候选命令等待共用原始默认 15 秒 Clock 期限，fallback 不得到新预算。既有有界进程
释放等待另算。保留候选顺序、profile argv、多行值、输出上限及探测专用变量恢复。纯输出
解析保持普通函数，不新增进程后端。

## 兼容缓存

尚存的 CLI/Electron 缓存显式标为 Legacy，并共用单一探测内核。CLI 保留三秒本地等待
上限：pending 探测可晚于早期空 overlay 结束，并向后续读取提供真实环境。早期探测失败
拒绝；迟到失败保留并报告，后续异步读取拒绝同一失败，同步读取抛出，不能变成成功的空
缓存项。opt-out 保留既有空/缺失 overlay。Electron 在既有缓存 Promise 中保留失败。

这些缓存尚未迁移后台生命周期。原生缓存属于应用 runtime/根 Scope；本地等待上限不证明
取消、完成清理或 daemon 关停已 join。两个应用拥有者都接收原生服务后删除探测 Legacy 门面。

## 证据

实现为 packages/shared/src/node/login-shell-env.ts 及 CLI/Electron 消费方。
[迁移决定](../.agents/notes/implemented/architecture/2026-10-10-effect-login-shell-probe.zh.md)
记录依据；行为套件使用注入时钟/signal 和真实临时 profile 导出。draft 记录失败行为变化，
检查与翻译不代表批准。
