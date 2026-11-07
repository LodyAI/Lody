# 封闭的 StyleX 字重 writer 对

Status: implemented
Translation: current

PR: [#1875](https://github.com/LodyAI/Lody/pull/1875) (draft)

[English](2026-11-03-stylex-font-writer-pair.md)

## 摘要

历史实现：声明桥接及其私有字体 writer 已移除。下文证据记录旧适配器；当前样式所有权见[直接 StyleX 与框架退役](2026-10-22-tailwind-to-stylex-migration.zh.md)。

只迁字重而省略私有 writer 会改变受支持的 CSS 合同。声明桥现支持一个封闭的 `font-medium` 对，把两条原生 StyleX 声明放回原规则，保留 class 身份、顺序与注册。一个真实 ACP 选择器 label 通过 24 对浏览器状态与六条构建路径。该声明对仍依赖 Tailwind alias 与排序；组合 Root 资格及全部历史视觉差异与这项隔离验收分列。

## 边界

[已实施的声明桥](2026-10-31-stylex-cascade-compatibility.zh.md) 继续拥有编译、producer 阶段及公开优先级合同，只支持以下 literal 对：

```css
.font-medium {
  --tw-font-weight: var(--font-weight-medium);
  font-weight: var(--font-weight-medium);
}
```

两个右值都保留元素本地的同一变量引用。保留 writer 在前、原 selector、utilities 层、物理槽位与 `@property --tw-font-weight` 注册；两个原生 atom 只折回一次原 alias。不走普通 collector，不改私有属性名，不省 writer，不按 metadata 顺序猜 atom 身份，也不扩成 variants 或任意规则语言。

原生编译器产生 priority 1 的 writer atom 和 priority 3000 的字重 atom，可按属性与 atom 的双射关联，而不依赖顺序。生产提取必须拒绝缺失、重复、不等或意外字段，先验证全部替换再修改 CSS。既有单字段声明与编译绑定保持不变。

## 证据与验收

本地证据位于 `packages/components/artifacts/visual/`。

| 证据                                          | 结果                                                                                                                                | 限制                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `review-font-medium-feasibility-opinion.json` | 原序 donor 克隆在六个真实或锁版优化阶段保持完整 CSS 字节同。                                                                        | 可行性探针，不是生产 adapter 实施。                     |
| 原生前缀检查                                  | 记录切面的 58 key 与 80 导出不变。                                                                                                  | 后续 Root 追加仍需独立前缀检查。                        |
| 真实 Chrome 合同                              | 24 组根、本地、CSS-wide DOM 合同放在三张真实 Chrome 图（原始、完整 pair、删 writer 负控）中；正对图同，负控使 46 个可观察字段不同。 | 合成 CSS 合同，不是产品 UI 或硬件覆盖。                 |
| 生产实施                                      | 56 项真实 compiler 测试覆盖封闭 pair，包括真实 raw／优化规则、两个 author map 与拒绝变异。                                          | 其它多声明规则仍不支持。                                |
| 真实 ACP label                                | 24 对真实产品 PNG 全同；3,969 body 与 255 target 记录除 48 个精确 URL 载体外一致。六条真实构建路径保持 108 对 CSS 相同。            | 隔离候选；组合 Root69 key／70 声明／89 绑定的资格另验。 |

leaves240-delivery.json、leaves240-acceptance.html 与
review240-final-independent-verification.json 拥有产品证据与独立审查。24 对产品截图不同于
研究中的 24 组 DOM 合同／三张图。已覆盖公开调用方、本地／CSS-wide 变量及原 writer 读者，
不证明原生操作系统行为。报告原异步关闭失败与修复后 viewer 均保留；新通过状态不关闭旧视觉 OPEN。

分别统计样式 key、物理声明、绑定及保留 utility 位置：一个声明对是一 key、两物理声明。
本次采用迁移一处声明归属，净依赖移除为零。
