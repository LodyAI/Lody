# 快捷指令 runtime 的生命周期失效处理

Status: implemented
Translation: current

[English](2026-09-25-prompt-shortcut-runtime-lifecycle.md)

## 摘要

快捷指令 Provider 保持挂载时，同一工作区从就绪变为未就绪再恢复，可能导致应用崩溃。
清理逻辑销毁了 runtime，却仍将其保存在 React state 中；账号和工作区再次匹配时，
目录 effect 就会访问这个已销毁的对象。现在清理时立即撤下实例，渲染时也检查所属
effect 的生命周期和全部初始化依赖。原有的持久化关闭等待机制保持不变；原生设备
上的实际交互仍需手动验证。

## 原因与决策

`MainLayout` 在工作区就绪状态变化时保持 Provider 挂载，因此工作区 ID 可以经历
A → null → A，而组件 state 不会重置。关闭再开启功能、A → B → A 也有同样问题。
`setDirectory` 会同步断言 runtime 仍然有效，所以旧引用会触发路由错误边界。

Provider 现在只清除属于正在结束的 effect 的实例。生命周期谓词也会拦截保留下来的
旧 state；platform 和云能力检查覆盖其余初始化依赖。新实例仍会等待上一个写入方
完成持久化关闭。如果改成让已销毁 runtime 的方法静默忽略调用，就会掩盖旧消费者，
并使 Provider 继续指向不可用的服务。

这与[移动端 beta 开关](2026-09-25-mobile-prompt-shortcuts-beta.zh.md)互补：该开关
可以触发实例清理，但生命周期问题影响所有平台。

## 验证

Provider 测试在 StrictMode 下挂载，使用真实快捷指令 runtime，并注入存储和网络边界。
覆盖就绪状态变化、功能开关、切换工作区后返回、持久化关闭阻塞以及 platform 替换。
通过显式 Promise 屏障暂停重新初始化，验证消费者收到加载状态而非已失效实例。
测试不依赖计时器或远程服务。

修复后五个用例全部通过。原始 Provider 有四个用例失败，其中三个出现完全一致的
`Shortcut runtime disposed` 错误。组件类型检查、修改文件的 lint/格式检查和文档
校验均通过。
