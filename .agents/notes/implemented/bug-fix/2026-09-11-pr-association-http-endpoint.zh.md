# 将 PR 关联请求路由到 HTTP action 端点

Status: implemented
Translation: current

[English](2026-09-11-pr-association-http-endpoint.md)

## 摘要

Cloud CLI 的 PR 关联把 `/api/action` 请求发往公开的 Convex RPC 端点，而该端点无法调用
内部关联函数，于是产生
`Could not find public function for 'github:associatePullRequestForCli'`。
该请求现在改用既有的 `authSiteUrl`，从而抵达 HTTP action 代理，同时兼容显式配置的
site URL 与推导出的默认值。

## 决策

端点选择由 `cloud-cli-port.ts` 拥有。PR 关联使用它既有的 site URL，与其他 HTTP action
消费者保持一致。请求负载、token 校验与响应处理均不变。把后端函数改为公开是不必要的：
既定的 HTTP 代理本就支持该操作。

## 验证限制

一次隔离的运行时检查执行了转译后的 cloud port，桩掉无关服务并拦截 fetch 请求。推导出的
Convex site URL 与显式配置的 site URL 都收到了预期的 POST 与关联负载。改动文件的格式检查
通过。该 checkout 中缺失嵌套 ACP 模块，导致完整检查无法运行；文档检查会报告指向这些模块
的链接。

本次改动不包含针对托管部署的真实关联验证。请把端点选择与未改动的关联负载、后端授权分开
审阅。
