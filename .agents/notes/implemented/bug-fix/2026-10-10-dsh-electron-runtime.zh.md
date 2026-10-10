# 让桌面运行时匹配 DSH 原生加载器

Status: implemented
Translation: current

[English](2026-10-10-dsh-electron-runtime.md)

## 摘要

DeepSeek Harness 0.2.0-rc.2 在 Electron 43.7.6 下尚未初始化 ACP 就退出，原因是
node-addon-require-builtin 0.1.9 拒绝其 Node/V8 指纹。将 Electron 固定为 44.7.0 后，
使用现有打包适配器和运行时依赖的 macOS arm64 隔离探针恢复了能力发现。此次升级同时
将图片剪贴板写入迁移到 Electron 44 异步 API，并将 macOS 最低版本提升到 13。
完整安装包和其他平台验证仍未完成。

## 决策与证据

DSH 继续使用宿主的 `process.execPath` 和 `ELECTRON_RUN_AS_NODE=1`，保留
[内置运行时决策](2026-09-16-dsh-bundled-node-runtime.zh.md)。桌面版本和精确的发布年龄
豁免均改为 44.7.0，不豁免后续 Electron 版本。现有 electron-vite 6.0.0-beta.5
目标表已经将 Electron 44 映射到 Node 24.18 和 Chromium 152。

同一份合成配置、打包 ACP 适配器及已安装 Harness 依赖，在现有 43.7.6 Helper 下失败，
在官方 44.7.0 的 Node 模式下通过。两者都内置 Node 24.21.0；V8 从
15.0.245.31-electron.0 变为 15.2.124.28-electron.0。新运行时返回初始化能力，
新会话返回模型、推理强度、权限和四个预设。对照不需要真实凭据或模型请求。

Electron 44 移除了 `clipboard.writeImage`。先解码并验证图片，再编码为 PNG，构造
带 MIME 类型的 `ClipboardItem`，等待 `clipboard.write` 完成后才返回成功。
写入被拒绝仍通过 IPC 返回可恢复错误。这完成了
[API 准备决策](2026-09-13-electron-api-preparation.md)中推迟的图片迁移。

此变更替代 [Electron 43 决策](../process/2026-09-30-electron-43-runtime.zh.md)中的运行时
选择及 macOS 12 支持。[原生交互 Spec](../../../../specs/desktop-native-interactions.zh.md)
仍为草案。此前 [Harness 升级](../feature/2026-10-09-dsh-harness-upgrade.zh.md)
尚未验证桌面打包路径。

## 验证与限制

- 复用已安装依赖链接并指定 Electron 44.7.0 后，桌面主进程和渲染器类型检查及全部
  214 个桌面测试通过。冻结锁文件一致性、修改代码格式和公共边界检查通过。文档校验
  剩余六处既有断链，均指向未初始化的 Kimi/Pi 子模块文件。
- 提交前复用已安装的格式化工具，根目录 `pnpm format` 通过。根目录 `pnpm check`
  在构建 Claude ACP 适配器时停止：此嵌套工作树缺少包括 `@tsconfig/node22` 在内的依赖。
  这不代表全仓检查通过。
- macOS arm64：使用现有打包原生依赖，在 44.7.0 下通过真实 ACP 初始化与新建会话对照、
  CLI `--help`、SQLite 插入读取、PTY 子进程执行、Loro 导入导出及 Roost Worker 持久化探针。
  使用 44.7.0 Electron Helper 二进制也通过了 ACP 初始化和新建会话。
- 已打包修改后的图片服务，并在隔离 Electron 44 主进程运行。受控剪贴板写入器验证了
  等待完成、写入失败、无效字节和 PNG ClipboardItem 内容，不改变用户的系统剪贴板。
  原生剪贴板读写往返仍未验证。
- 这些探针复用现有打包 CLI，不代表新安装包构建、签名公证、完整桌面 E2E 或
  Windows/Linux 验证。用户正在运行的应用未改变。
