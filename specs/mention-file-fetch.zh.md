# GitHub 文件 mention 获取

Status: draft
Translation: current

[English](mention-file-fetch.md)

多个输入框与草稿 hydration 可能在 mention 菜单打开前需要同一仓库文件树。
相同工作区、仓库和分支的请求应合并，各消费者仍分别获得结果或失败。

## 失败与重试

GitHub 和本地文件发现失败仍向消费者显示错误，但不发送
`mention/file/fetch_error` 或 `mention/file/local_fetch_error`。消费者卸载不取消共享请求。
OSS 本地遥测遵守平台契约，保持强制禁用。

失败不缓存。后续调用启动新尝试，即使错误值相同也不受影响。不新增自动重试定时器；
失败 hook 在重新挂载或仓库、工作区变化时重试。分析客户端不参与获取依赖。
仅重新打开菜单不重试文件发现
（Worker 搜索有独立重试生命周期）。

保留成功缓存的新鲜度与过期刷新行为。同仓库刷新失败可以保留旧路径；
切换仓库失败不得保留上一仓库路径。草稿 hydration 的后台获取继续存在。
移除埋点不得改变缓存归属、重试行为或可见错误状态。

## 证据

- [缓存与请求归属](../packages/components/src/lib/repo-file-paths-cache.ts)
- [Mention hook](../packages/components/src/components/mentions/file-at-mention.tsx)
- [行为测试](../packages/components/tests/mention-file-fetch.test.tsx)
