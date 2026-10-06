# 独立的 Nightly 下载

Status: implemented
Translation: current

[English](2026-10-05-independent-nightly-downloads.md)

## 摘要

桌面和 Android 共用一份清单会使 Android 下载依赖桌面发布。页面现在独立加载 `version.json` 和 `android-version.json`，分别展示每组平台的版本与重试状态。一个端点失败时，另一组下载仍然可用。发布端需要提供独立 Android 清单；解析器测试不证明线上已经可用。

## 决策与证据

本改动调整[Android 下载](2026-10-04-nightly-android-download.zh.md)中的共用清单展示方式，保留不可变文件名与 HTTPS 根路径校验。每组平台独立管理请求、超时和状态；Android 不要求桌面最低正式版字段。保留单一请求会延续失败耦合。[草案契约](../../../../specs/desktop-channel-execution.zh.md)记录独立可用性的要求。

六项解析器测试通过，覆盖独立 Android 元数据、版本不匹配与不安全地址。限定范围的严格 TypeScript 检查与独立 React 渲染冒烟测试也通过：任一端点失败或重试时，另一组下载仍然可见，两组可展示不同版本。网站生产构建也通过，生成 253 个静态页面。此工作区尚未验证浏览器布局和线上端点。发布与部署不属于这份公开代码改动。
