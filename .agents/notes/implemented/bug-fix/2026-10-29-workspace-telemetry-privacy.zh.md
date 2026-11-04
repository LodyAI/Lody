# 工作区遥测隐私

Status: implemented
Translation: current

[English](2026-10-29-workspace-telemetry-privacy.md)

## 摘要

正文遮罩不会清理 replay 的 DOM 属性。加密或模式未知的工作区因此关闭 replay，
自动异常只保留固定错误码。已确认的普通工作区继续录制并保留原有异常行为。
本地诊断与用户明确提交支持报告的能力保持不变。

## 决策和约束

`CloudPlatformProvider` 同时匹配登录账号、路由目标、工作区 ID 和已验证的
`plaintext` 描述符。临时普通运行时、`legacy-unclassified` 准入和列表都不能授权
录制；列表可以否决。读取当前 render 快照并同步订阅 store，封住 effect 更新前的
窗口。路由在目标提交前关闭门禁；激活失败只能恢复自己的未被替换的切换。
门禁不阻塞正文读取、运行时或执行。

锁定的 `posthog-js@1.396.6` 停录会 flush，且可能异步排空压缩队列。远端禁录
`onRemoteConfig` 则丢弃缓冲并使压缩失效。随后删除
`$session_recording_remote_config`，避免已在加载的脚本拿到一个被禁用但仍为真的
配置对象后启动。受限期间保留真实远端响应，只在当前普通工作区获确认后恢复。
发行 bundle 会改写私有方法名，不能按源码名称调用它们。

仅有捕获时的 `before_send` 挡不住发送队列和重试。封装发行类型和 bundle 保留的
`_send_request`，在批量、重试和卸载发送前复查实时范围与事件代次。敏感请求使用
SDK 同步编码，因为原生 gzip 会先序列化再让出执行，旧请求体可能跨过切换。
已经发出的请求无法收回。升级 SDK 必须运行真实浏览器回归；缺少录制控制时禁录。

未知范围的延迟异常在入队前就脱敏，不能在初始化延后时恢复原件。主进程和 daemon
服务多个工作区，始终只报固定诊断；React 启动前的信标只报固定错误类型。
[预期认证异常](2026-10-09-posthog-auth-error-filter.zh.md)仍在隐私投影前过滤。
此版 SDK 不暴露 replay 属性遮罩，故用支持的 `blockSelector` 隐藏图片及带
`alt`、`title`、`aria-label` 的元素作为纵深保护。

## 证据和限制

`pnpm --filter @lody/components test:posthog-browser` 编译实际产品配置，使用锁定
SDK、全新 Chromium/WebKit 上下文和本地接收端，覆盖未知/普通范围、缓冲切换、
恢复、属性、脚本晚到、挂起的原生 gzip，以及 Web、桌面、原生 shell 标记。
真实 HTTP 500 响应验证切换后 SDK 重试不会补发旧录制。`--negative-control`
移除门禁/遮罩，必须失败。Node SDK 接收测试覆盖 main/CLI 脱敏和本地硬禁用，
provider 测试覆盖账号、目标和模式错配。这些是本地合成证据，不代表安装包、真机
或生产部署验收。旧客户端需要运维关闭远端录制开关直至更新；新代码无法追溯保护它们。
