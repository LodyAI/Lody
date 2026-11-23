# 限制会话用户身份查询等待时间

Status: implemented
Translation: current

[English](2026-09-16-bounded-session-user-identity.md)

## 摘要

仓库会话可能因云端用户资料查询不返回而一直初始化，即使机器主人正在本机 Electron 操作。
主人现在跳过查询，由 Session 在实际 worktree 中读取 Git 配置，缺失时使用中性 LodyAI 身份。
其他请求者仍查询自己的资料，但最多等待 60 秒。这个期限只约束资料查询，不代表整个启动流程
在一分钟内完成；已安装客户端尚未验证。

## 决策

MessageHandler 和 SessionManager 预启动路径都向解析器传入已认证的机器主人身份。
解析器与本轮冻结的请求者比较，不使用 Session 创建者或传输方式判断。主人路径返回携带请求者 id
的占位资料，再由现有 Session 绑定流程读取 worktree Git 配置。机器授权和 GitHub 凭据仍独立检查。

其他用户的查询由 Effect 限制为 60 秒。失败或超时返回占位身份，只清除属于该请求的缓存，
允许后续重试。晚到的结果不能发布资料或清除较新的请求。CloudPort 的这项查询暂不支持取消信号，
所以等待结束后底层请求仍可能继续。这里不自动重发消息。

本决定部分替换了[之前决策](../feature/2026-09-08-machine-owner-git-identity.zh.md)中主人回退到
云端资料的部分。仅加超时仍会让主人不必要地等待，因此选择跳过查询。
新意图已写入 [draft Spec](../../../../specs/git-commit-identity.zh.md)。

## 验证

两个定向套件通过 20 项测试，使用假时钟覆盖主人跳过、其他用户身份、精确 60 秒期限、重试、
晚到结果和计时器清理。复用了本机已有构建依赖；由于 shared 入口依赖不匹配的 ACP 子模块，
临时 Vitest 别名直接加载当前 shared auth 模块。常规测试配置和完整 CLI 类型检查仍受依赖与
子模块版本不匹配阻塞。格式化和 diff 空白检查通过。没有重新构建或替换已安装的 Electron 应用。
