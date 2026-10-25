# E2EE M1：保留状态与宿主运行时

Status: implemented
Translation: current

[English](2026-10-21-e2ee-m1-runtime-boundaries.md)

## 摘要

基于公开 `698df2f281a40f9d63b086a8e48f5404a885f5da`。M1 接通桌面账本运行时，
不启用加密内容、机器配对或普通用户入口；普通工作区不打开 custody、不增加网络等待。
内容面仍由现有 control-only 准入关闭。

## 已实现的边界

- core、Lab 使用当前 catalog Streams 版本。独立仓与嵌入式组合分别验证。
- shared 持有必填的 WorkspaceStreamsContent；已有普通调用显式选择 plaintext。
  CLI、建流 helper、预取、Shortcut、OSS 导入在不支持保护时先拒绝，再做任何传输副作用。
  Worker 仅传可克隆的模式标记，个人 Shortcut 的资源域保持独立。
- LedgerFeed 的 retained 起点包含完整 v2 导出与 offset；恢复不升级验证来源。
  VerifiedLedger 是唯一 pin 守卫：先推进 pin，再由 SQLite rebase CAS 换起点、删覆盖行。
  pin 更长时必须通过后缀证明其哈希；缓存比 pin 新时可重建；真实冲突不能重置 pin。
- 桌面按需创建账号 owner，复用创建时的 custody；工作区有独立 feed、pin、installed-key
  存储。recordCreated 核对本机原始 creation，持久绑定 workspace 与 genesis，不覆盖改绑。
  已有工作区只 openDevice，epoch0 insertIfAbsent 后核对承诺，创建原件不删除。
- 账本页先显示本地视图，再从持久位置读原始后缀，由主进程验证；Web/手机继续原有路径。
  IPC 仅产品窗口、明确方法和工作区借用者可用。返回公开投影，不导出密钥或任意签名。
- 经过 core 验证的新原始记录先写 history.sqlite，再提交 feed，最后推进 pin。
  验证或存储失败关闭该 owner；重开从原件对账。缓存损坏先证明 pin 再重建；成功后清理被替换的 feed 文件。
  rebase 完成但 envelope 未保存的中断也从原件恢复；不会降低 pin。
- 每窗口持有工作区借用；关闭窗口释放借用。退出账号、切换账号、退出应用先停止接入，
  等待实际原生操作结束，再释放工作区存储和账号保管。
- 通用 node-custody 保留原有格式、AAD、原件发布及 rewrap 行为。Electron 包装器保持
  原有后端资格检查。CLI 初次实际写入/读回钥匙串测试项后选择保护；不存在可用钥匙串时
  自动选 file，此后永不自动切换。file 仅允许 machine，POSIX 0600/0700 与 owner 检查，
  Windows 检查真实 DACL。缺少模式文件或 KEK 的已有原件拒绝，不生成替代钥。

## Owner 决定与限制

2026-10-21 owner 明确批准机器初次创建自动选择文件保护；个人设备仍必须系统安全存储。
未来机器配对批准必须显示保护类别；本轮不接配对，不让普通 CLI 启动接触钥匙串。
这项批准优先于旧 D10 文档的概括，协议相关修订由 owner 的 PR-06a 处理。

保留状态仅恢复本方导出；原始记录与单独 pin 是重建依据。没有原件证明的冲突不得自动修复。
状态检查使用 InstalledEpochKeys.check，临时密钥在 core 内释放，不为了 UI 领取秘密。
合成存储测试不证明真实 OS 钥匙串、Windows ACL 或 Electron 原生 ABI 的打包验收。

首次接管也保留 renderer 已验证的 checkpoint。主进程原件不足时只显示 continuityPending，
不授予密钥就绪或权限；这个限制落入持久 pin，重启后也不能遗忘。

真实打包启动测试按模块归属定位 application，不绑定单一 facade 形状；仍要求仅动态导入，并在取得启动所有权后才加载。共享动态入口可能导出 application 命名空间，生产启动配置不变。

## 复审修正

同页导航保留占用。退出时 E2EE 与其他独立资源一并清理；E2EE 关闭失败不挡登出。失败 Scope 必须继续隔离，不能让第二次幂等 close 的成功授权新 owner；取消退出只恢复健康 owner 的准入。

retained 起点跨重启累计新增 64 条才压缩。原始历史完整验证、新缓存提交且旧 feed Scope 关闭后，仅清理被替换的 SQLite 及 sidecar；保留原始记录、pin 和冲突证据。完整账本只在本地首屏、末页或需要升级时经过 IPC，不随每个中间页回传。

机器钥匙串调用在受管 helper 中每次限时 10 秒，凭证走 stdin。确认进程已终止才允许首次回退文件；混合错误/释放失败必须保留恢复所有者，不能回退。既有 OS 保管不降级。Windows 一个 ACL 进程检查整个目录；初始化锁竞争异步有界重试最多 60 秒，不阻塞首个 JS owner。


账号 IPC 同步读取主进程已确认的身份，原生开启后再核对身份和认证代数，不持全局锁等待认证网络。
冷启动尚无主进程身份时不信任 renderer accountId；账本沿用原有只读验证。只有保管/账号不可用、
宿主关闭或缺绑定允许回退，pin 补绑定失败也遵守这条规则。genesis 与 observed 检查保留；
冲突、存储损坏和验证失败继续阻断。诊断只暴露稳定错误码。

多个读者可提交相同或部分重叠的页：在已验证前缀内逐字节比对最多 64 条原件，只追加新后缀，
不回退 offset/pin。旧终点必须匹配本地已验证的 head。缺口/错误输入不关闭共享 owner；
矛盾字节、验证/存储错误关闭 owner 并保留证据。行为测试覆盖有/无 pin 的回退、pin 冲突、
缓存身份离线使用、开启中切换账号、明确登出、重复/部分/空旧页和缺口。
真实 OS 钥匙串、Windows ACL 初始化中断及打包 Electron 仍未验收；CLI custody 尚无 daemon 调用方，
ACL 初始化中断保留为 PR-10 接入前事项。
