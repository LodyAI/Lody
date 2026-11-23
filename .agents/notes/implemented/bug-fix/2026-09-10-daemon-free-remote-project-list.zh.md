# 无需客户端 daemon 列出远程项目

Status: implemented
Translation: current

[English](2026-09-10-daemon-free-remote-project-list.md)

## 摘要

过去，即使用户只想读取 workspace 内另一台机器已同步的项目目录，`lody project list` 也要求
当前机器的 daemon 正在运行。现在，显式 workspace 或 machine selector 会使用一次性的云端读取，
而不带 selector 的命令继续保留本地 daemon 行为。远程结果会先完成同步，并使用与 Session 创建
相同的 requester 权限检查进行过滤；local platform 则会在发生 cloud I/O 前拒绝这条路径。

## 决策

显式传入 `--workspace` 或 `--machine` 会选择远程目录路径。即使指定的是当前 CLI 登录所关联的
machine 也同样如此：传输方式由 selector 意图决定，而不是由 machine id 是否相同决定。不带
selector 时，现有的本地 IPC 行为保持不变。

远程路径先解析用户可访问的 workspace，同步其中的 machine metadata，再用 CLI Session 创建所用
的非委托 `canRequestMachineForCliToken` 能力过滤机器。机器 selector 支持精确 id，或在已授权机器中
唯一匹配的名称。随后，命令会等待目标 Machine Flock 文档完成同步，将其中的项目行覆盖到旧版
Machine metadata 上，并在返回任何名称或路径前执行 project scope 权限检查。Metadata、Flock 或
授权传输失败都会使命令失败，而不会展示陈旧或未经筛选的目录。

开源 local platform 会在认证或 workspace transport 建立前拒绝远程 selector，同时继续支持不带
selector 的 daemon-backed list。

## 范围与验证

本次实现处理 [issue #582](https://github.com/LodyAI/Lody/issues/582) 请求的项目目录行为，不修改项目
注册、删除、Session 创建或远程项目内容。

合成行为测试模拟了无 daemon 的客户端和另一台目标机器。测试验证：同步后的 Flock 行会覆盖旧版
数据；被拒绝项目的路径不会进入响应；显式 selector 会选择远程路径；精确 id 与唯一名称可以确定性
解析；Flock 同步被拒绝时，会在读取缓存项目之前失败。该测试使用注入的 transport，并非真实云端或
设备测试。
