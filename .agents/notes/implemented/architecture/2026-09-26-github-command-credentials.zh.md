# 按命令选择 GitHub 凭据

Status: implemented
Translation: current

[English](2026-09-26-github-command-credentials.md)

## 摘要

为启动仓库注入会话级 token 会妨碍后续访问其他已授权仓库，也会覆盖机器本地权限。
实现改为共用按命令选择策略，并由 broker 绑定请求者上下文。机器本地凭据只对机器主人
可用，显式开启的个人身份优先。只读预检查会增加延迟，但避免换身份重放写操作；
这不是操作系统级隔离。

## 决策

保留单仓库 installation token，不扩大到所有已授权仓库。分别申请个人/App 候选凭据，
使检查偏好不必先签发 App token，也不必抢在本地权限前使用托管身份。
Git 只委托原生 helper 读取凭据，不能转发 store，否则会泄露托管 token。
恢复使用工作区专属 broker 文件，不使用由最后启动者覆盖的全局文件。
标准 HTTPS、SSH transport 都进入选择器，因为 HTTP Authorization header 会绕过
credential helper。长期运行的原生 Agent 通过会话文件发现轮换后的上下文，无需重启。

## 依据与限制

启动路径修正：之前的认证测试只到 `ensureRepo`，漏掉 `createWorktree` 内部第二次 fetch，
该操作丢失请求者上下文，导致新会话无法启动。现由 worktree 创建在仓库锁内统一准备，
并把固定的凭据上下文传到 checkout 及重试。缓存缺失时先克隆再验证恢复分支；
没有 broker 的原生执行不再安装托管 helper。原生 Git 测试现通过生成的 helper 验证
克隆、拉取、预创建、缓存丢失后的恢复、需要认证的 smudge filter，以及本地认证、
请求者隔离和拒绝无效上下文。远端 Git 和 broker 响应是测试替身，不代表真实 GitHub
或系统 keychain 冒烟验证。
HTTPS transport 同时修正空 `GIT_CONFIG_PARAMETERS` 前多加空格的问题，原生 Git
会在连接远端前拒绝该格式。原生解析器测试覆盖配置缺失、空值和继承配置下的 App/个人身份。
生成的 Git 包装器把 checkout 视为远端读取，并让 credential 子进程继承该分类；
嵌套 push 仍要求写权限。smudge 测试实际经过包装器，使用只读个人 token 且无 App 回退。

审查修正：`gh` 原先跳过写权限预检。现对明确的命令检查 push/admin 后再选择身份；
评论、评审和 fork 分支更新不能套用该要求。策略故障与会话上下文失效分开提示，
不缓存可能过期的身份偏好。无法确定目标时解释托管身份限制，不静默使用本地权限。

PR 面板和 diff 评论现统一传递 PR 所属会话 ID。共用身份 hook 同时约束读写，
评论写入还会向 GitHub 核对数字 ID。旧记录身份未确认时显示错误和重试入口，
并自动尝试一次安全修复；仅名字相同不能解除阻止。Hook 测试覆盖修复、重试、
旧名复用和阻止写入，评论错误提示新增独立 Storybook 状态。线上部署和平台冒烟仍待验证。

参见[规格草案](../../../../specs/github-command-credentials.zh.md)。
实现和确定性的策略、生成命令及原生 Git advertisement 测试已存在；修正后对标准 URL 支持范围的对抗式复审未发现剩余阻断项。
未部署线上服务、未修改真实用户凭据。准备 ACP adapters 和 review assets 后，CLI bundle 构建也已通过。

CI 发现一条过时的全局 helper 断言；现以原生 Git credential-fill 测试验证仅接管 GitHub，
并保留其他 host 的 helper 链。桌面 PR E2E 改为检出 merge ref，使本地 action 与合并后的
工作流配套，避免新工作流搭配旧 head 源码。

PR：[#1034](https://github.com/LodyAI/Lody/pull/1034)。
