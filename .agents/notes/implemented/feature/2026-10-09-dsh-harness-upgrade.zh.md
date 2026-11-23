# DSH 运行时升级到 Harness 0.2.0-rc.2

Status: implemented
Translation: current

[English](2026-10-09-dsh-harness-upgrade.md)

Provider PR：[acp-extension-dsh #28](https://github.com/LodyAI/acp-extension-dsh/pull/28)
宿主 PR：[Lody #1353](https://github.com/LodyAI/Lody/pull/1353)

## 摘要

按用户要求，将 Harness 从 0.1.5-rc.2 升级到 npm latest 的 0.2.0-rc.2，未选择
独立 alpha 通道。升级替换了已移除的预置和设置接口，同时保留模型设置、预置身份
与原生会话恢复。宿主增加版本化会话文件识别，避免格式迁移后将 raw 根目录误判为
压缩格式。新建及升级的 JSONL/zstd 会话通过真实运行时验证；本检出尚未验证完整
桌面打包和 Windows 原生执行。

## 决策与实现

- 从发布包重建 286 项运行时依赖闭包，固定 Harness、Cordis、Cosmokit、pi-ai、
  Schemastery 版本，profile revision 升至 v17。普通 npm 10 安装成功，未使用
  force 或 peer-dependency 绕过。2026-10-09 查询的 latest/next 为 0.2.0-rc.2，
  alpha 为 0.2.1-alpha.2。
- 通过新原生 registry 在 profile 模块解析作用域注册预置。复制 dsh-web-app
  预置 patch，仅去除外层插入包装；Creator skills 来自固定的 dsh-agent-preset。
  保留旧用户声明和默认选择，禁用重复宿主工具行，挂载 Creator 所需的原生检查
  服务。首次 ACP 能力查询等待 Loader 完成加载。
- 不能简单用 settings 替代已移除的 settings-file：新版会将 settings.yaml
  改名并导入当前 profile。Lody profile 是生成且按内容命名的，这会使设置在后续
  升级时遗失。因此禁用自动迁移，将旧模型配置节只读传入原生 Config，保留共享
  文件和默认预置。错误文档拒绝初始化；设置按启动快照读取，修改后需重新连接。
- 除既有遥测和产品清单禁用项外，还禁用新版引入的账户组件及账户 provider。
  保留 API-key 路由和原有原生/宿主凭据职责。
- CLI 发布和 Electron after-pack 检查采用新的 `presets/<id>.yml` 平铺布局。CI
  暴露了两处旧假设：启动测试仍要求已移除的 `dsh-agent-presets` 包，资产检查仍
  查找 `<id>/agent.cordis.yml`。测试改为要求原生 preset registry 并验证生成的
  profile 文件；配置行为由原生 profile 验证负责，不再重复源码字符串断言。
- 宿主只读编码检测识别旧文件名及 session.vN JSONL/zstd。受支持格式的 V4
  迁移由原生 write-open 执行并保留前代文件；不实现压缩转换或自动降级。

本决策替代[设置记录](../bug-fix/2026-09-08-dsh-settings-provider.zh.md)中的旧文件
provider 机制，保留首次请求目录及源文档保证，并扩展
[会话恢复决策](2026-10-09-dsh-session-restore.zh.md)。
[设置 Spec](../../../../specs/deepseek-harness-settings.zh.md)继续保持 draft。
此前 Core 能力研究基于 0.1.5-rc.2，在新版实现更多接口前需重新核对原生证据。

## 验证与边界

- 扩展构建和 42 项单测；真实 profile 覆盖四种预置切换、模型/权限/预置恢复、自定义
  预置与默认值兼容、错误设置、文件保持不变，以及缺凭据时在 provider I/O 前失败。
- 原生恢复测试覆盖两种编码的冷 load/resume、中断尾部、身份/上下文延续和增量
  记账，并用 0.1.5-rc.2 创建会话再以 0.2.0-rc.2 恢复。原生 fork/压缩历史重放及
  提问/审批归属测试也通过，未调用真实模型。
- 14 项宿主测试使用隔离 Vitest 配置并指向构建后的扩展运行宿主 runtime 测试，覆盖版本化/混合
  编码目录和合成 Windows 转发边界；未执行 Windows 原生二进制。
- CI 修复在独立克隆中按冻结 lockfile 安装依赖验证：64 项启动/runtime 测试、完整
  CLI 构建（含预置复制与导入检查）、桌面 CLI 同步及应用构建、根 format、docs
  check、i18n 和三项导入/platform/public 边界检查通过。移走 `standard.yml`
  时，发布包检查也按预期失败。
- 根 `pnpm check` 通过 typecheck/lint，随后在未修改的
  `github-git-transport.test.ts` 递归 SSH fixture 处停止：本地 Lody Git 包装器
  报 `context_unreadable`。CLI 组其余 3,577 项通过、四项跳过。因此不能声称
  全仓检查通过；桌面 E2E 场景及安装包 after-pack 执行尚未在本地验证。
