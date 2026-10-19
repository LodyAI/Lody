# Roost 浏览器回执恢复

Status: proposed
Type: bug-fix
Translation: current
PR: [#1699](https://github.com/LodyAI/Lody/pull/1699)

[English](2026-10-18-roost-remote-receipt-latency.md)

## 摘要

Roost 输入可能在浏览器替换“连接仍在但不交付响应”的监听之前，等待其他 RPC 超时。
客户端现于输入 append 成功后两秒仍无回包时，以 long polling 续读共享响应流一次，
保留原请求、位置和期限。回归与渲染适配器测试验证真实加密回执的恢复，不重放输入。
这不要求更新远程 CLI，约束的是恢复触发时间，不是 owner 处理或端到端送达时间。

## 证据与边界

调查使用锁定的 streams-client 0.12.0 和本地源码 `17c76466b`，补丁也已应用到
`fbc850c99`。尚未确定线上客户端和 daemon 的 revision。一次获授权的已有远程会话
发送前，已开启 DevTools Network/Performance 录制；更早的耗时来自保留的诊断缓冲。
这里不包含捕获的会话内容或标识。

| 修复前观测 | RPC 耗时 | 请求 append |
| --- | ---: | ---: |
| 更早的首条输入 | 27,739 ms | 939 ms |
| 后来录制的输入 | 2,140 ms | 402 ms |

更早的 append 后等待约 26.8 秒，其间客户端在响应超时后切换到 long polling。
这是恢复启发式，不能证明 owner 当时已经回包；两项都不是修复后测量。后来录制时
已在使用 long polling 和增量 history-watch，CPU 与网络工作重叠，无法拆分原始
请求送达、owner 工作与响应送达的耗时。

两个后端共用 RPC 响应流，但 Loro 还能通过文档同步暴露已送达历史状态。Roost 的
权威历史/状态也依赖 RPC，控制 cursor 只是失效提示；它和来源端写入的人类 provenance
都不代表接收成功。Loro 的 human Inbox 接收也可能等待 I/O，并非始终纯内存。
Roost 还需等待 owner/backend 元数据与原生接收/activation；真实回执不能消除这些
等待。桌面连接本机 Docker 仍可能走 Streams，本地成功不能排除这些远程等待。

## 恢复契约

仅启用 policy、没有显式 pin 的客户端，在 `accept_input` 或
`accept_input_and_dispatch` append 成功后启动计时。两秒仍无回包时，从保存的
位置续读共享响应流；SSE 降级为 long polling，已有 long poll 也刷新连接。
一次续读覆盖当时已 append 的重叠输入，每个输入最多参与一次。其他回包不会推迟
计时；空闲 history-watch 不触发恢复。

原 pending 请求、加密校验和期限保持不变，不重放、不推测送达。回执、超时、取消
和关闭会移除计时资格；主动中断后不进入错误退避，诊断输出失败不会阻止恢复。
显式 pin 和未配置 policy 的客户端保持原行为；现有五分钟 cooldown 防止立即
重新尝试 SSE。处理正常但较慢的 owner 也会触发额外 GET/CORS，两秒只是延迟启发式。

dispatcher 拥有计时器和读取 controller。取消结束本地等待，不撤销 owner 已接收的
工作；不新增 writer 或订阅 owner。已评估并暂缓 Effect 迁移：上层请求、读取和
取消消费者仍为 Promise 编排，本修复不增加 facade 或 runtime。

## 验证与发布

假时钟回归覆盖 SSE/long-poll 续读、延迟 append/owner、重叠输入、无关/重复回包、
中断/诊断失败、正常 SSE、pin、取消、超时及关闭。去掉计时调度后，恢复回归按预期
失败。渲染 bridge 使用真实锁定 SDK、加密和合成 HTTP/SSE，从 offset 42 找回
回执，只有一次写入，无需读回历史，也不把历史写进控制文档。

另一项前后对照让真实加密回执已就绪而 SSE 暂扣：基线在两秒仍等待，直到实验在
十秒放行才确认；修复版在两秒续读并确认。健康 SSE 下，两版都在虚拟零时刻确认。
这是假时钟故障对照，不是网络实测，也不是说基线总等十秒。临时源码和 suite
变更已精确恢复。

RPC、bridge 和发送端测试通过，全库检查见 PR。文档检查仍有六条指向缺失 ACP
源码的既有坏链接，没有受保护主题变更。wire schema 和能力协商不变，浏览器可先于
远程 CLI 更新发布。尚未上线或在原会话复测，原 26.8 秒仍未归因；owner 元数据、
排队、存储和请求送达不属于这次恢复触发时间的保证。
