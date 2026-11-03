# 把 CLI 的 zstd.wasm 放到加载它的 chunk 旁边

Status: implemented
Translation: current

[English](2026-11-03-cli-zstd-wasm-init-hang.md)

## 摘要

Nightly 的 CLI 后台进程会留下旧的 Loro 文档，因为快照压缩一直等着 zstd。生产包从包含 `@loro-dev/streams-crdt` 的 `chunks/` 模块解析 `./zstd.wasm`，打包却把文件复制到 CLI 入口旁边。wasm 初始化只等成功，文件缺失或损坏时 `modulePromise` 一直 pending，上传任务就继续持有文档。现在 wasm 放在每一个引用它的产物模块旁边。初始化失败会拒绝，并且不缓存。等待者超时后，已经开始的运行时仍可继续使用。上传那次 await 结束后，文档就可以回收；共用的快照管理器仍然保留自己的 adapter。

## 决策

`copy:wasm` 把 `zstd.wasm` 放到每一个源码里含有 `./zstd.wasm` 的 JavaScript 产物旁边。产物里没有这个说明符时，复制失败，而不是去写 `dist/zstd.wasm`。开发构建把该包留在外部，所以仍然从包目录解析这个文件。

打过补丁的 `@loro-dev/streams-crdt@0.19.2` zstd 加载器，在读取、获取、编译或实例化 wasm 失败时拒绝。每个调用方最多再等 10 秒。这次超时只拒绝当前等待者。已经开始的实例化继续跑，后来的调用方加入同一次尝试。Emscripten 已经把 `calledRun` 设上之后，后来的调用方直接使用这个运行时，不再调用 `Module.init`。实例化回调记住启动它的那次尝试，所以旧尝试迟到的成功或失败不能结束一次更新的尝试。真正失败且 `calledRun` 还没置位时，下一次尝试会清掉 Emscripten 的 run dependency 计数，然后可以重新实例化。失败的加载不缓存。成功的初始化继续缓存。

`TransportSnapshotManager.dispose` 仍然只清防抖计时器。失败的 join 和重连都会继续用这个管理器，所以 dispose 不能丢掉 `adapter`。`disposeJoinState` 在 dispose 之前已经把 join 标成关闭；压缩一旦结束，`maybeUpload` 就返回，不再上传。在同一个 pending Promise 外包一层调用方超时，不能放开文档，因为挂住的是上传任务自己。

## 后果

如果运行时已经调用过 `abort()`，同一次进程里的重试仍可能无法启动，因为那条路径会设置 Emscripten 的 `ABORT`。缺失和损坏的文件不会走这个标志。这不会缩小已经涨上去的 wasm 线性内存，也不改变 Loro 的 decoded-value 缓存。

## 验证

`apps/cli/tests/zstd-wasm-packaging.test.ts` 覆盖文件放置。重定位运行时检查把 zstd 入口放到 `chunks/` 目录：缺少 wasm 时压缩拒绝，跨过这次 await 持有的文档可以被回收；把 wasm 放到模块旁边后可以来回压缩；损坏的 wasm 连续两次拒绝，且没有未处理的 rejection。同一次检查会按住 `WebAssembly.instantiate`，并直接触发捕获到的 10 秒计时器。超时之后，后来的压缩用同一次实例化完成来回压缩，不会再启动第二次实例化，已经超时的 Promise 保持拒绝。失败或迟到失败的尝试留下的旧计时器，不会结束它的替代尝试，替代尝试随后可以来回压缩。重叠的压缩共用一次实例化，并各自还原自己的字节。这里没有重新构建已安装的 Nightly。
