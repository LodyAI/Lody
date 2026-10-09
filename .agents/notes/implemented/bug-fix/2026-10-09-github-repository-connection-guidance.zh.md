# 为仓库连接失败提供修复入口

Status: implemented
Translation: current

[English](2026-10-09-github-repository-connection-guidance.md)

## 摘要

会话可以已记录 PR，但尚无法确认它与工作区的 GitHub 连接。反复执行报错和只有重试
按钮的提示无法告诉用户如何修复。界面现在提供本地化的管理员操作指引和 GitHub
设置入口，已有旧 PR 缓存时也显示该提示。权限校验及既有仓库冷却保持生效；组件
测试并未验证生产环境的安装修复流程。

## 决策与职责

本改动扩展[观测与关联分离修正](../../proposed/bug-fix/2026-10-01-pr-observation-association.zh.md)。
机器上的 GitHub 访问权限证明观测有效，并不证明工作区的 App 连接有效。既有身份门控
返回有类型的错误；共享展示辅助函数也识别 token 边界的 `repo_not_linked` 代码。
PR 和评论界面复用设置打开器，保留桌面对话框及移动端路由。已知连接阻塞期间，PR
视图隐藏缓存详情及修改入口，保留底层缓存与评论草稿供恢复后使用。普通网络错误仍
沿用原有展示方式。

可选云端关联的 HTTP 契约仍对拒绝返回非成功状态，使旧客户端保留 15 分钟冷却。
不新增同步状态、schema、轮询或 toast。未采用 HTTP 200：旧客户端将 `response.ok`
视为关联成功。设置按钮只用于修复配置；重试仍执行安全的身份修复，不能绕过
canonical association 及后台冷却。

## 验证

定向 PR 视图/容器、身份/详情、评论和 diff 面板测试覆盖读写阻塞、本地化指引、设置
入口、已有缓存时的拒绝状态及恢复。既有客户端关联测试覆盖 HTTP 403 冷却和恢复。
组件类型检查通过。浏览器验证使用真实 PR 错误 story，不涉及生产工作区或安装。

契约：[本地 PR 观测](../../../../specs/local-github-pr-observation.zh.md)。
