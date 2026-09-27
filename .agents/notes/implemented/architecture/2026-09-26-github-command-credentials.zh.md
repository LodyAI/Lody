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

参见[规格草案](../../../../specs/github-command-credentials.zh.md)。
实现和确定性的策略、生成命令及原生 Git advertisement 测试已存在；修正后对标准 URL 支持范围的对抗式复审未发现剩余阻断项。
未部署线上服务、未修改真实用户凭据。准备 ACP adapters 和 review assets 后，CLI bundle 构建也已通过。

PR：[#1034](https://github.com/LodyAI/Lody/pull/1034)。
