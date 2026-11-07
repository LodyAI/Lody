# cloudflared 安全版本固定升级

Status: implemented
Translation: current
English: [2026-10-27-cloudflared-emudhra-update.md](2026-10-27-cloudflared-emudhra-update.md)

## 摘要

Cloudflare 针对 eMudhra 中间证书事件要求 cloudflared 不低于 2026.10.2，非 Homebrew 安装的 macOS 还有更高的最低版本要求。CLI 管理的 Quick Tunnel 原先固定在 2026.9.1，因此将原生下载产物与捆绑许可声明一并升级到 2026.10.4。既有按版本隔离的缓存和可执行文件完整性校验保持不变；公共 Runtime 分发通道部署对应产物仍是独立的上线前提。

## 决策与证据

- 固定 [2026.10.4 Release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.4) 的五种独立产物，Windows ARM64 继续明确复用 AMD64 产物。`.tgz` 使用**压缩包** SHA256，其余使用直接二进制 SHA256；五项实测结果均与 GitHub 资产元数据一致。
- Release 正文在 `.tgz` 文件名下列出的是**解压后 macOS 可执行文件**的 SHA256，而不是压缩包摘要；`github_release.py` 在发布校验值前先解压。若照抄正文将错误拒绝真实下载。
- 五项产物的 `go version -m` 均显示 Go 1.27.3，以及同一标签的主模块修订 `dc3b264da64a801bc3a8d5301a6db21401910ad5`，同时带有修改标记。按各平台 GOOS/GOARCH/CGO 参数分别运行 `go-licenses/v2@v2.0.1 save ./cmd/cloudflared`，再结合已核验摘要的 Go 1.27.3 源码重新生成安装声明。
- 无须迁移旧版本缓存：`ensureCloudflaredBinary` 使用 `<root>/<manifest.version>/<platform>`，复用时验证可执行文件与许可文本。损坏或不完整的安装仍明确失败。
- 托管 Quick Tunnel 的 Origin 是本机 loopback HTTP 代理。其他使用受影响 eMudhra 中间证书的 HTTPS Origin，需要实例所有者在替换已部署连接器前独立检查，不能由 Lody 的固定版本推断。

## 验证与限制

下载器、进程生命周期和 Quick Tunnel 共五个定向测试套件通过（50 项），许可生成器测试通过。当前环境只能直接执行官方 Linux x64 原生文件；macOS 和 Windows 的原生执行需要平台 CI。实际 Linux Quick Tunnel 测试已尝试请求分配，但环境无法解析 `api.trycloudflare.com`，因此未验证公开 Origin。`go-licenses` 对无法分析的汇编/非 Go 源码发出警告，编译产物的 dirty 标记也不支持声明可复现构建。10 月 27 日，公共 Runtime 通道旧版 `2026.9.1/linux-x64` 返回 HTTP 200，新版 `2026.10.4/linux-x64` 返回 HTTP 404。**在让用户获得这一 CLI 固定版本前，必须先上传并独立核验新版本不可变产物。**
