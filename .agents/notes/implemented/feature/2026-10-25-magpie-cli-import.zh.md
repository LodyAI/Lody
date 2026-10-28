# 无桌面 Magpie Provider 导入

Status: implemented
Translation: current
PR: [#1866](https://github.com/LodyAI/Lody/pull/1866)

[English](2026-10-25-magpie-cli-import.md)

## 摘要

服务器用户无法调用仅限桌面的 Magpie 导入，通用 Provider CLI 也不能保存网关元数据。
`agent-config import-magpie` 现在可在运行命令的本机创建全部七种映射，并支持目标
子集或已有导入链接。它复用 daemon 准备队列与原生模型目录生成，保留已有 Provider，
并可重试失败任务。导入只确认配置持久化，不代表运行时就绪或推理成功。

## 决策与边界

用户要求在服务器上一条命令导入。本次扩展[现有草稿 Spec](../../../../specs/magpie-provider-import.zh.md)
的显式授权入口，不代表批准 Spec，也不弱化桌面链接确认。限定服务器本机执行，
使回环地址归属明确，不增加远程机器选择。命令使用现有云版工作区命令运行时；OSS
纯本地命令支持留待独立工作。没有新增协议、后端或任意凭据导入。
[此前决策](2026-10-09-magpie-provider-import.zh.md)继续定义运行时隔离与公开 token。

写入前校验全部目标能力，通过已有文件锁 facade 按工作区和机器串行化 CLI 导入，
同步机器目录后去重。写入现有 Flock schema，flush 后再发布。发布失败保留已持久化
数据并报告 `synced: false`；重跑复用匹配 Provider/任务 ID，失败任务沿用原配置重试。
运行中或等待认证的任务不重启。安装、验证和取消仍由 daemon 负责。
并发桌面写入沿用现有 Flock 行为；CLI 锁只串行化本机 CLI 导入。

按 Effect feature/fix 模式评估：命令框架和 Repo manager 仍是 Promise 链。
同步导入逻辑保留普通 TypeScript，锁使用已有原生实现的 Legacy 边界。迁移工作区
所有权会牵入未完成的 Repo 消费者链，依选择指南暂缓。没有改变运行时生命周期或
迁移台账边界。

## 验证

扩展既有命令测试，通过真实 Flock 验证七种映射、重复导入、已有部分结果、失败任务
重试、非法地址、链接目标限制和能力预检。命令测试检查调用机器归属和上传失败后的
持久化状态。原运行时模型目录测试保持不变。未进行真实供应商推理或 Linux 成品部署。

当前工作树的 agent-config、Magpie runtime 和 provider setup 共 52 项测试通过；CLI
类型检查、改动文件 Oxfmt/Oxlint 和公开边界检查通过。验证复用了已安装工作区依赖。
全仓 `pnpm check` 在 DSH 子模块构建因依赖缺失而停止；`docs check` 仍报告六条指向
未初始化 Kimi/Pi 子模块的既有链接错误。没有改变依赖版本或子模块固定提交。

站点独立教程提供中英双语的服务器准备、目标选择与结果说明，并接入侧栏和 CLI 命令参考。

站点验证：内容生成、59 项站点测试和生产构建通过；已检查中英文 Magpie 静态页面正文及 CLI 参考页链接。
