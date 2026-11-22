# 在公开 runner 上构建私有组合

Status: implemented
Translation: current

[English](2026-11-11-private-composition-public-runners.md) | 中文

## 摘要

Lody 的签名发布产物由私有组合构建：它拥有云端 Web 入口、云端 CLI 和 Electron 构建配置，以及嵌入本仓库的根工作区。在私有仓库里跑这些构建，每分钟托管 runner 都要计费，而本仓库的标准 runner 免费。现在 `build-private-composition.yml` 以只读方式检出准入的私有 SHA，运行私有仓库自己的构建 Action，再加密上传结果；签名和发布仍在私有仓库完成。此前用公开配置拼装"云端输入"的做法构建出的是另一个产品，已删除。

## 问题

私有 Nightly 和发布 workflow 在私有仓库的 `macos-15`、`windows-2022` 和 Ubuntu runner 上编译打包，按分钟计费，预算曾经耗尽。签名和发布需要私有凭据，编译不需要。

## 决定

- 公开 workflow 只是一层薄壳：校验 dispatch，用仅有 Contents 读权限的 App token 检出 `loro-dev/lody` 的指定 SHA，运行该检出中的 `public-runner-build` composite action，再用固定版本的 Buildgraph `upload` Action 上传输出（AES-256-GCM，绑定仓库、run、SHA 和 artifact 名）。每个目标另有一个明文索引，只含 artifact ID、digest 和源码 SHA。
- 构建什么、用什么命令和配置，都由私有仓库在该 SHA 决定。修改构建不需要改这个 workflow。
- 私有消费方下载时固定本仓库、workflow 路径、`main` 分支和 run，然后签名、公证、生成更新源并发布。Windows 和 Linux 安装包目前不签名，因此公开侧的 stage 就是最终产物；macOS 应用以未签名状态装在 tar 里传输，因为 Buildgraph 拒绝符号链接。

## 备选方案

- **用公开配置编译**（LodyAI/Lody#2474：`release.vite.config.mjs`、`release-builder.config.mjs`、`build-release-artifacts.yml`）。已否决并删除。云端产品的 Web 入口、CLI 和 Electron 配置、工作区 overrides 与 patches 都在私有组合里；在公开侧复刻会漂移，产出单机版或细节不同的应用。也没有任何地方使用它。
- **独立的公开构建中心**（Buildgraph fork 或专用仓库）。已否决：本仓库已有子模块源码和免费 runner，Buildgraph 的 Action 可以直接引用，无需 fork。
- **不加密的普通 GitHub artifact。** 已否决：公开仓库的 artifact 任何人都能下载，而产物包含私有 bundle 和 source map。

## 影响

- 运行日志、dispatch 输入和索引都是公开的。请求只能携带本来就会打进客户端 bundle 的值；构建步骤不得打印源码或环境变量。
- 能在本仓库 dispatch 的人可以构建任意私有 SHA。dispatch 需要本仓库写权限，environment 的分支策略把凭据限制在 `main`。
- 在 `private-build` environment 及其 App 和密钥配置好之前，这个 workflow 不会生效。

## 验证

私有消费方的请求校验、mac 签名一致性检查和更新元数据合并由其自身测试覆盖。真实 dispatch、跨仓库下载、签名后启动以及从上一个 Nightly 更新，要等凭据配置好后的第一次 Nightly 运行才能验证。
