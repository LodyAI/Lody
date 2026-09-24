# 独立桌面通道身份

Status: proposed
Translation: current

[English](2026-09-23-desktop-channel-identity.md)

## 摘要

可独立安装的桌面通道必须将浏览器回调和凭据存储路由到发起登录的应用。桌面身份现在与共享的本地执行
安装配置分开解析，启动入口在凭据模块执行前设置数据目录。登录 attempt 保留现有认证 client，
通过经过校验的通道选择回调协议。浏览器转交和固定版本认证端点已有测试覆盖。早期 OS 租约现在控制应用模块加载；
打包后的跨通道启动和系统协议分发仍需验证。

## 决策与边界

公开 main 通知 workflow 仅把已接纳的源码 SHA 发送到配置的发行 workflow。
它不 checkout 或构建产品，也不持有安装包签名和存储密钥。通知 App 仅安装到一个目标仓库，
使用 Actions write；该权限并非单 workflow 权限，必须视为受信任的发布自动化。
目标发行流程就绪后才由维护者启用通知。

`desktop-channel.ts` 只覆盖桌面身份，不改变 CLI 命名空间、数据根目录和 Host 端点。
`desktop-bootstrap.ts` 是入口的第一个导入，因为认证和 onboarding 存储会在模块求值时打开。
Stable 保留默认数据路径、协议和 Windows 备用 IPC 命名空间；Nightly 使用独立桌面存储、协议与备用 IPC。
共用协议需要转发和旧安装支持；独立协议避免这一依赖。

[登录协调器决策](../../implemented/architecture/2026-09-17-desktop-login-coordinator.zh.md)
继续负责 PKCE 与 state。通道身份只选择回调，不能削弱 attempt 校验。
公开 local-only 构建拒绝云端通道注入，不引入部署地址或凭据。

Better Auth 1.5.5 每个 Electron 插件只接受一个 client。两个通道继续使用 `client_id=electron`，
白名单 `desktop_channel` 查询参数在浏览器回调中保留并选择固定应用协议，无需第二个插件或新的服务端
token 格式。上线前需要部署 Nightly 原生来源白名单。测试显式启用 origin/CSRF 校验，因为 Better Auth
在测试环境下默认跳过来源校验。

## 启动所有权

入口同步注册 URL 和同应用第二实例监听，取得 Electron 单应用锁，再取得 cloud 桌面共用的
loopback 租约，最后动态加载 `application.ts`。必须早于 ready 的配置保留在
`desktop-bootstrap`，有界回调缓冲覆盖异步门控期间。桌面租约独立于 CLI Host 所有权，
control-only 模式也持有。正常退出不会提前关闭它，进程退出时由 OS 回收。
CLI 停止失败会阻止退出并允许重试，不再把 shutdown barrier 的拒绝当作成功退出。

独立 TCP 租约避免残留文件恢复竞态，也不需要新原生依赖；代价是占用机器级 loopback 端口
17790，与现有 POSIX cloud Host 的机器级互斥一致。其他监听者占用该端口时拒绝启动并提示。
这不构成旧版兼容：旧桌面没有取得该租约，支持版本下限仍是发布条件。
未打包的隔离 E2E 保留既有绕过行为，打包版本不能通过该环境变量绕过。
Nightly 还会在应用模块导入前取得现有执行 Host。先检查再启动会留下 daemon 竞态，
因此真正的 Host 租约保留到应用退出。借用适配器为 Supervisor 提供相同的 instance ID
以及不释放租约的 release，Worker 重启、认证重启和 control-only 模式都不能让出预约。
Nightly 的运行时策略始终为 `reject`，包括绕过早期预约的隔离 E2E。
已有 daemon、前台 CLI 或桌面 Host 会被拒绝，但不会被停止；Host 元数据损坏时仍由
内核绑定保证拒绝。Stable/local 保留原有 attach 策略。代价是 control-only Nightly
窗口存活时也不能启动外部 daemon，但设置关闭期间不会启动 Worker 探测。

目标契约见[桌面通道执行](../../../../specs/desktop-channel-execution.zh.md)。

## 验证

桌面端与 Web 在「设置 → 关于」的「下载应用」下方提供「下载 Nightly 版本」，
链接至对应语言的独立 `/download/nightly` 页面。普通下载页不再嵌入 Nightly。
独立页面复用下载布局和单一营销 shader 宿主，仅将背景层改为低饱和灰紫色；保留
深浅主题、降级渐变与 shader 采样。页面说明真实数据、手动切换和已验证最低正式版。
解析器要求完整六种不可变安装包，并仅构造配置 HTTPS 根地址内的链接；无效或缺失清单
显示暂无下载与重试。应用本身不读取清单，因此无需修改应用 CSP 和存储的官网来源 CORS。
真实下载及跨通道安装兼容性仍是发布条件。

关于页面接受可选的构建时桌面通道与源码身份。发行 composition 注入固定候选的时间和
源码版本；存在两个 revision 时分别显示，悬浮提示提供完整哈希。未注入这些可选常量的
composition 保留原有单提交展示。关于页面、崩溃报告和问题描述共用构建常量读取器。
问题描述附加带标签的报告客户端信息，与远程机器日志区分，不读取路径、环境变量或账号数据；
表单说明会附带构建信息。发行构建还可向主进程启动日志及内置 CLI 的文件/混合日志
初始化注入不可变的序列化构建身份。CLI 的协议/包版本保持独立，继承的运行环境变量
不能修改构建身份；发行打包必须检查已暂存 CLI 清单与桌面候选一致。真实 bundle 测试
执行编译后的 CLI 身份模块并与生成清单比较；仍需检查真实安装包中的日志。

行为测试位于 `desktop-channel.test.mjs` 和现有 `auth-callback-transaction.test.mjs`。
仍需类型检查和真实打包登录验证。`desktop-exclusion.test.mjs` 覆盖竞争持有、崩溃恢复、
启动缓冲与退出失败重试。`desktop-startup.test.mjs` 构建真实 main bundle，验证冲突时不加载
业务/凭据模块，成功时重放早期回调。真实 Host 端点覆盖已有所有者、损坏记录和旧所有者
退出后的启动；真实打包 Supervisor 验证停止/重启不会释放借用的 Host。测试替代 Electron UI 与应用执行，因此不证明安装包
或系统回调路由；后端来源白名单部署也仍是发布条件。

## 通道图标

Nightly 使用低饱和铜金色水母、柔和月牙和深色底板。
`apps/electron/resources/icon-nightly.png` 是 1024 像素透明 PNG 主图。
分发 composition 将其用于平台安装包，并将主进程窗口/托盘和开发 Dock 图标
别名指向同一主图；Builder 转换原生格式，Stable/local 保留已有资源。
图标通过内置图像生成工具编辑，再由 `sips` 调整尺寸；颜色修改降低饱和度和亮度，
保留轮廓与布局。留白修订将底板四周透明边距调整至约 10%，并缩小水母以匹配
Stable macOS 图标的视觉大小。格式转换不能证明安装后系统图标或小尺寸托盘的可辨识度，
这些仍需安装包视觉验收。

安装包文件名在扩展名前使用 `-nightly` 后缀，例如
`Lody-<version>-arm64-nightly.dmg`，Windows 为
`Lody-<version>-x64-setup-nightly.exe`；下载清单校验与打包命名保持一致。
