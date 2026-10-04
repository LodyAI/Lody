# 同步模拟器输入并隔离原生 Git 测试环境

Status: implemented
Translation: current

[English](2026-10-04-cli-transport-fixture-isolation.md)

## 摘要

CLI 传输测试依赖 WebSocket 握手顺序和继承的 Git 状态。模拟器输入测试现在先等待上游
ping/pong，再发送触摸；递归 Git 测试清除外部 Git/SSH 环境变量，并在执行测试的仓库之外
运行。保留已有行为断言，不修改超时时间和生产传输逻辑。

## 证据与决策

模拟器服务端触发 `connection` 时，网关不一定已处理 HTTP upgrade。网关若在上游仍处于
连接中时收到输入，会关闭流，测试则一直等待触摸转发。上游自动返回的 pong 能明确证明
握手完成，无需 sleep 或重试。双指和底部边缘测试使用这一信号；普通触摸测试已有视频往返
作为同步信号。

原生 Git 测试原先仅过滤部分配置变量，仍继承 `GIT_DIR`、askpass 和 SSH 设置，凭据探测
也会使用执行测试的仓库作为当前目录。传入 `GIT_DIR` 已复现测试环境准备失败。递归克隆
测试现在主动注入无效的仓库/askpass 路径及冲突的 SSH variant，再用清理后的环境和明确的
临时目录验证真实递归 checkout。这覆盖环境污染，但没有捕获用户报告 `access_denied`
时的确切环境。模拟 broker 仍返回 503，SSH 替身仍只访问本地仓库，不连接 GitHub。

## 验证与范围

两个定向套件共 22 个测试通过。验证覆盖本地 WebSocket 和原生 Git，不代表生产 GitHub
或真实模拟器验证。相关决策：[GitHub 回退](../architecture/2026-10-03-github-identity-fallback.zh.md)
与[模拟器手势](../feature/2026-10-03-ios-simulator-two-finger.zh.md)。
