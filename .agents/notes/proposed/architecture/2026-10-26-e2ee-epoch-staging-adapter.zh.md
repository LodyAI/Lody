# 设备凭证鉴权的 epoch 暂存适配器

Status: proposed
Translation: current

[English](2026-10-26-e2ee-epoch-staging-adapter.md)

## 摘要

epoch 发布成功后，即使发布设备丢失，其他接收者仍须取得新钥。core 已负责候选钥保护、完整组暂存、精确读回和原记录对账。本改动补上可选云端请求契约与仅宿主使用的传输适配器，沿用已绑定设备凭证，不增加请求签名。它不启用换代 UI、发送屏障、远端认证或任何暂存产品调用；这些仍需后续接线与验收。

## 责任与恢复

`EpochStagingStore` 只提供存储，不提供账本权威。云请求携带 `workspaceId`、`credential` 和可选 `cliToken`；暂存和删除不增加签名证明。宿主签名工具继续保留，供其他宿主选择额外验签层。服务端验证已绑定设备并查询当前投影；客户端安装前仍验证发布原件、资格、签名、HPKE 与 commitment。读回组必须与请求的完整位置键相符。

Electron main 复用现有请求 owner，提供每次请求独立的鉴权、取消、关闭及 30 秒期限。暂存适配器在 yield 前拥有访问参数和全部输入原件；重新运行同一 Effect 只重发原字节。没有网络锁或跨工作区锁。超时、回执丢失均表示结果未知，core 继续保留持久原件供明确对账。取消或关闭会拒绝迟到结果，不关闭无关工作区请求。

删除每次只推进一批物理清理。`done: false` 返回可重试的 `BackendError(unavailable)`，不冒称完成，也不自行循环。调用者保留相同位置键和已占用 commitment，后续再次调用；清理不能改写已经确认的发布结果。结构解码和有界错误阻止 SDK 原始错误或凭证进入 IPC、遥测。

服务端 `e2ee_staging_invalid` 与 `e2ee_staging_corrupt` 拒绝映射为终态 `BackendError(invalid-response)`，与坏回应一致，不能当作网络不可用重试；后续修正后的调用仍可用。容量冲突、超时和清理未完成各自保留原语义。

## 证据与限制

core 既有真实 SQLite/密码学换代测试覆盖暂存读回、CAS 未知结果、发布者丢失及冲突清理。新增 `checkEpochStageRequest` 对照区分历史外签名有效与当前 epoch 权限，并拒绝签名、上下文和原件篡改。注入 HTTP 回应、明确信号与 TestClock 覆盖固定传输原件、回执丢失、清理进度、坏回应、取消、正常慢请求及期限后的恢复；不使用真实网络或钥匙串。

产品启用前仍需独立接入后端发布引用与保留规则。atomic-removal 旧草案要求适配器验签的文字，在 Lody Cloud 中由 backend guide 的必需层规则取代；本记录不批准或修改该草案。Member 自撤后的换代责任、可信新鲜度、远端身份、完整换代屏障及安装应用验收均不属于本切片。
