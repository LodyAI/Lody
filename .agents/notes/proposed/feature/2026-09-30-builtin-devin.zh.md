# 内置 Devin 与 registry 去重

Status: proposed
Translation: current

[English](2026-09-30-builtin-devin.md)

## 摘要

Devin 此前只能通过外部 ACP registry 发现。本次接入固定提交的 adapter submodule，
并让 builtin 从托管渠道使用经过校验的官方运行时。发现列表移除重复的 Devin、
Dimcode、Kimi 条目，同时保留已有配置的启动契约。源清单与协议检查已通过，
完整发布及验证仍待完成。

## 决策与证据

与 [Pi](../../implemented/feature/2026-09-17-builtin-pi.zh.md) 不同，Devin 是随 CLI
打包的代理，调用官方原生运行时，而非独立 Node 依赖闭包。其固定版本清单提供
六个平台的源哈希。Unix 归档转码，Windows ZIP 做可复现重打包，不改动运行时
字节。正式校验值必须在全部上传并回读验证后才能更新。

Devin 3000.11.3 的空 HOME 初始化公布了 `devin-browser` ACP 登录方法，因此使用
现有 ACP 登录流程，不猜测原生命令，也不能落入 Claude 默认分支。发现列表清理
不转换已有 provider 身份或原生 session ID。

Adapter 只声明 bin，没有包根导入入口，因此导入发布的 `dist/index.js`。它通过
相对文件路径读取 manifest，打包后该路径失效；public/cloud Vite 共用
`devinRuntimeContractPlugin`，内联固定源清单并保留原来的校验。加载器变化时
显式中止构建。开发构建仍从原目录外部加载 adapter。

## 验证限制

Registry 生成/过滤和源清单拒绝测试通过，共享包与组件类型检查、39 个 adapter
测试和两种重定位 bundle 测试通过。独立 checkout 使用本地候选校验值，通过了
121 个 CLI 测试、CLI 类型检查、2 GB Vite 构建与发布 bundle 检查。Draft PR 包含本地验证的候选校验值以保证可构建。
渠道发布仍未完成；合并或发布前必须完成六个平台正式对象的上传与回读验证。
由于已预置校验值，上传后应再次运行 mirror，验证全部远程对象。
[契约草案](../../../../specs/builtin-devin.zh.md) 不代表已经可以发布。
