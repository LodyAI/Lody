# 设置账户头像的基线偏移

Status: implemented
Translation: current

[English](2026-09-30-settings-avatar-baseline.md)

## 摘要

桌面设置中的账户头像相对用户名向上偏移。头像与图片均为 24×24px，但外层包装产生了
带有额外下降部空间的行内行盒。将包装改为 flex 容器后，额外空间消失，头像在行内
垂直居中。现有的横向对齐与等比 cover 裁剪保持原有行为，Playwright 验证实际渲染几何。

## 证据与决策

[行首列对齐决策](2026-09-27-leading-icon-column.zh.md)
为头像引入了带负向水平 margin 的包装。14px 界面字号下，Chromium 测得包装尺寸为
24×29.296875px，头像为 24×24px。包装本身居中，导致头像比用户名和按钮中心高
2.6484375px。

`settingsSurface.listRowAvatar` 现在使用 `display: flex` 和 `alignItems: center`，
在包装的拥有者处消除行内基线贡献。调整图片尺寸或裁剪规则无法解决测得的包装缺陷。

## 验证

- [sidebar-nav-leading-column.spec.ts](../../../../packages/components/tests/e2e/sidebar-nav-leading-column.spec.ts)
  中的设置用例修复前失败、修复后通过。它检查图片头像和首字母头像在浅色、深色及
  12/14/18px 字号下的方形尺寸、垂直居中与图标中心列对齐。
- [SettingsAccountEntry stories](../../../../packages/components/src/stories/SettingsAccountEntry.stories.tsx)
  使用合成的非正方形图片，图片以 `cover` 填满 24px 头像盒。
- `@lody/components` 类型检查通过。前后截图使用同一组件、合成图片和视口，属于本地
  验收产物，不包含真实账户数据，也不代表已登录桌面的集成验收。
