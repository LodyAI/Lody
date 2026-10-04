# 本地项目目录排序与元数据

Status: implemented
Translation: current

[English](2026-09-19-local-project-directory-ordering.md)

## 摘要

`local-project/list-dir` 过去会先按文件系统遍历顺序截断、再排序，因此有限结果并不是所声明顺序中的前 N 项。协议现在通过带版本的机器能力协商目录排序与可选 stat 元数据，在应用 limit 前对完整可浏览目录排序，并且只在请求时返回 `mtimeMs` 与 `size`。这种选择性响应保持旧客户端严格响应结构不变，代价是截断前需要读取所有合格子项。

## 决策

请求新增 `sort`（按 `name`、`mtime` 或 `size`、方向及目录分组）和 `include: ['stat']`。守护进程原本就会为类型和路径边界检查 stat 每个合格子项，因此直接复用这些值排序，不增加额外文件系统调用。新的 `localProjectDirectoryMetadata` 机器能力防止客户端把严格 schema 扩展发送给旧守护进程。

## 验证

共享协议守卫与能力测试已通过。CLI 边界测试验证了 size 排序发生在截断之前，并在请求时返回元数据。发布前仍需运行完整仓库检查。
