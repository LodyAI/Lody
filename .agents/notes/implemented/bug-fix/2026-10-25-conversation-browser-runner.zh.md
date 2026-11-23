# 将对话浏览器测试 runner 固定到 Ubuntu 24.04

Status: implemented
Translation: current

[English](2026-10-25-conversation-browser-runner.md)

## 摘要

对话浏览器测试在执行测试前失败，因为 `ubuntu-latest` 选中了 Ubuntu 26.04，
锁定的 Playwright 1.58.2 无法在该平台安装 Chromium。仅将此 job 固定到其浏览器
与原生依赖表支持的 Ubuntu 24.04。保持依赖锁与浏览器测试不变；升级 runner 时
需核对锁定 Playwright 版本的平台支持。

## 证据与验证

[PR #1876 失败日志](https://github.com/LodyAI/Lody/actions/runs/40192373936/job/121165910613)
显示 Ubuntu 26.04.1、冻结依赖安装成功，随后 `playwright install --with-deps chromium`
报告不支持该平台，测试步骤未执行。此问题与项目绝对路径的 UI 改动无关。

工作流 YAML 解析成功，Playwright dry run 可解析 Ubuntu 24.04 的 Chromium 下载，
52 项 CI 范围选择与测试规划测试通过。两个对话浏览器套件的 18 项测试在本地
macOS 全部通过；`pnpm format` 通过。全量 `pnpm check` 被本地缺失的 ACP 子模块
阻塞，文档检查仍有 31 个指向未初始化子模块的链接错误。macOS 本地执行不能
验证 Linux 原生包安装，这部分仍由托管运行验证。
