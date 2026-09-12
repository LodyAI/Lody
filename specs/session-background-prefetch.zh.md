# 会话后台预同步

Status: draft
Translation: pending

用户启动 App 并查看短对话时，其他长对话的预同步不得在 UI 主线程加载
LoroDoc、转换完整 history 或创建 Loro Mirror。预同步是可取消的缓存优化，
不能成为打开会话、保留未上传编辑或正常前台同步的前置条件。

## 职责与边界

主线程根据会话元数据选择候选，并沿现有目标路由选择本地或云端同步。
Worker 负责原始文档加载、更新导入、快照导出和独立缓存持久化，不创建
Mirror，不产生会话业务写入。成功后只返回完成状态，不把完整文档传回 UI。

每个 renderer 同时最多执行一个预同步 Worker 任务；工作区切换也不能绕过
这一限制。任务完成后释放文档。超时、隐藏窗口、关闭侧栏、运行时销毁或
用户打开目标会话时，取消适用的后台任务并释放对应传输资源。

用户打开会话时，将完整缓存快照合并到前台已有文档，保留未上传的本地编辑。
Worker 不与前台 Repo 共享持久化目录或远端游标。快照和对应活动进度必须
原子保存；缓存失败不能被记录为同步成功。缓存可以按容量淘汰，清除缓存
必须覆盖它。已有前台 store 的会话由前台同步负责。

本次不承诺解决主动打开长对话时的全量导入／Mirror 成本，也不移走 CLI
发送端的原始文档加载。多个独立窗口分别拥有各自的串行预同步队列。

## 实现依据

- [预同步客户端](../packages/components/src/providers/eager-sync-worker-client.ts)
- [Worker 任务](../packages/components/src/providers/eager-sync-worker-task.ts)
- [快照缓存](../packages/components/src/providers/eager-sync-snapshot-cache.ts)
- [渲染成本说明](../.agents/docs/sessions-render-cost.md)
