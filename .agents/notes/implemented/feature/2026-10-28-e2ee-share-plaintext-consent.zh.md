# 加密工作区分享明确发布明文副本

Status: implemented
Translation: current

[English](2026-10-28-e2ee-share-plaintext-consent.md)

## 摘要

静态分享会把可读的对话内容复制到工作区成员范围之外。owner 为保留现有分享流程，选择允许加密工作区在明确提示并确认后发布。副本是服务器可读的明文，撤销不能收回已经被看过或复制的内容。普通工作区保持现有流程，不新增读取端解密密钥或分享格式。

## 决策

加密工作区编辑器在读取内容、申请部署、上传对象及发布之前请求确认。提示明确说明解密副本会离开 E2EE、服务器可读，以及撤销不能收回已被看过或复制的内容。对话框、内联编辑器、设置中的更新和 MCP 批准均使用同一个发布 hook。取消会返回编辑器或批准卡片，不发布内容；取消此提示不会拒绝 MCP 请求。每次发布动作，包括重试和更新，均重新确认。确认仅留在当前编辑器及运行时的内存中，不保存为偏好，也不是 agent 授权。

确认后，客户端通过同一个工作区源适配器读取内容，生成、上传并提交与普通工作区相同的静态分享包。现有 URL 片段中的 bearer 仍是访问凭据，不是内容解密密钥。owner 明确排除了 URL 片段解密密钥方案，选择现有服务器可读的发布边界。不需要修改账本、密钥保管或匿名读取协议。

此决定落实了[文件与预览可用性](2026-10-28-e2ee-file-preview-availability.zh.md)中待定的分享决策，并部分取代 [M2 接入](../../proposed/architecture/2026-10-22-e2ee-m2-product-integration.zh.md)中的公开链接限制；两份记录的其他决策保留。

## 证据与限制

[发布 hook 测试](../../../../packages/components/tests/use-session-share-management.test.tsx)挂载生产管理器，覆盖中英文文案、确认前及取消后零读取、零变更、零上传，并在确认后解码真实 HTTP 对象上传字节。[源适配器测试](../../../../packages/components/tests/session-share-publisher.test.ts)以两种工作区模式运行真实压缩打包路径。[MCP 卡片测试](../../../../packages/components/tests/session-share-request-cards.test.tsx)覆盖批准及取消的生产装配。这些合成测试证明客户端顺序与内容行为，不代表线上后端或已安装设备验收。
