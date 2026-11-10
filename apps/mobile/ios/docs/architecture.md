# Router、present() 与 LodyKit

这套结构基于声明式的 `src/lib/presentation`，统一管理路由与原生呈现方式。Lody 的主题采用 Expo Router Theme，原生关闭控件由 LodyKit 提供。

## 页面如何组织

```text
┌────────────────────────────────┐
│ Root Stack                     │
├────────────────────────────────┤
│ NativeTabs                     │
│  电脑 Stack / 设置 Stack         │
├────────────────────────────────┤
│ /environment  稳定路由入口        │
│ /presented/:id 临时呈现入口       │
└────────────────────────────────┘
```

`src/app` 只维护路由与导航布局。业务页面与 `definePage` 放在 `src/screens`。`src/features` 是领域逻辑，不得引用 screens。打开会话经 `sessionNav` mailbox，由 `hooks/screens` 调用 `present`。`src/screens/` 只有 `*Screen` 文件（`debug/` 可另放 `uiVerify.ts`）。`src/lib/presentation`、`src/lib/i18n`、`src/lib/theme` 是与业务无关的基础设施。

### 定义一次，两种入口

实际示例在 `src/screens/EnvironmentScreen.tsx`：

```tsx
export const EnvironmentScreen = definePage<EnvironmentParams, RuntimeInfo>({
  id: 'environment',
  title: '运行环境',
  Component: View,
  parseRouteParams: ({ message }) => ({
    message: (Array.isArray(message) ? message[0] : message) ?? '直接路由入口',
  }),
  presentation: { style: 'pageSheet', headerVariant: 'transparent' },
});
```

稳定 URL 的路由文件 `src/app/environment.tsx` 导出 `EnvironmentScreen.Route`。调用 `router.push('/environment')` 或 `<Link href="/environment">` 即可打开。URL 参数在 `parseRouteParams` 中解析、验证；直接路由的 `finish` 返回上一页，不向调用者返回结果。冷启动没有上一页时返回根入口。

### 等待 Sheet 的结果

```tsx
const result = await present(
  EnvironmentScreen,
  { message: '从设置传入的参数' },
  {
    style: 'formSheet',
    sheetAllowedDetents: [0.5, 1],
    sheetGrabberVisible: true,
  },
);
if (result.status === 'completed') {
  console.log(result.value.systemVersion);
}
```

页面内通过统一 runtime 取参数、完成或取消：

```tsx
const { params, source, finish, cancel, present } = usePageRuntime<
  EnvironmentParams,
  RuntimeInfo
>();

// finish(runtimeInfo) -> { status: 'completed', value: runtimeInfo }
// cancel()           -> { status: 'cancelled' }
// present(...)       -> 可继续打开下一层，并等待它的结果
```

原生手势关闭、返回或路由卸载会回收 session 并返回 `cancelled`；完成后再触发清理也不会改变结果。导航抛错时 Promise 拒绝并释放 session，调用端应捕获异常。

`pageSheet`、`formSheet`、`fullScreen`、`overFullScreen` 分别交给原生 Stack 的 page sheet、form sheet、full-screen modal 和 transparent modal。`dismissible` 控制原生关闭手势与公共关闭按钮；`headerShown`、`headerVariant`、动画和 detents 都可按页面声明、按调用覆盖。透明覆盖层由业务页面自行提供需要的背景与关闭交互。

复杂参数和回调只存在内存中，URL 只含 session id。不要把该 URL 当成可恢复链接；冷启动、刷新后的失效 id 会安全退回。需要可分享的页面应使用稳定 Route。`presentationPath` 与 `PresentedPageProvider` 也保留，用于需要独立静态路由布局的呈现页面，参考迁入实现。

## Native Module 怎么用

只有一个自研桥接模块 `LodyKit`。`modules/lody-kit/expo-module.config.json` 注册 `LodyKitModule`，Podspec 收集该 Kit 下的 Swift 文件，Expo 自动链接它。原生实现按功能目录增长，业务页面只导入 `@lody-ios/kit`。

### 常量、异步方法、模块事件

实际类型与封装在 `modules/lody-kit/src/runtime/LodyKit.ts`，对应 Swift 注册在 `ios/LodyKitModule.swift`：

```tsx
import {
  runtimeInfo,
  selectionFeedback,
  addAppActiveListener,
} from '@lody-ios/kit';

console.log(runtimeInfo.systemVersion);
await selectionFeedback(); // Swift AsyncFunction，UIKit 调用在 main queue

useEffect(() => {
  const subscription = addAppActiveListener(() => {
    // Swift OnAppBecomesActive -> sendEvent -> typed NativeModule listener
  });
  return () => subscription.remove();
}, []);
```

Swift 异常应通过 Promise 拒绝传回；调用端处理错误。触感反馈在模拟器只验证调用完成，实际触感需要真机。

### 原生 UI 的 props 与事件

```tsx
import { NativeCloseButton } from '@lody-ios/kit';

<NativeCloseButton
  label="关闭运行环境"
  onPress={cancel}
  style={{ width: 44, height: 44 }}
/>;
```

完整路径：

```text
┌────────────────────────────────┐
│ TS NativeCloseButton wrapper   │
└──────────────┬─────────────────┘
               ▼
┌────────────────────────────────┐
│ requireNativeView              │
│ (LodyKit, LodyCloseButton)      │
└──────────────┬─────────────────┘
               ▼
┌────────────────────────────────┐
│ Swift View + Prop(label)       │
│ UIKit UIButton                 │
└──────────────┬─────────────────┘
               ▼
┌────────────────────────────────┐
│ EventDispatcher(onClose)       │
│ TS onPress -> runtime.cancel() │
└────────────────────────────────┘
```

新增不适合用 RN 实现的 UI：在同一个 Kit 添加 Swift `ExpoView`，在 `LodyKitModule` 注册 `View/Prop/Events`，添加对应的类型化 TS wrapper，并从 Kit 的 index 导出。SwiftUI 可放在该 ExpoView 内承载。需要命令式方法时沿用 Expo View 的 `AsyncFunction` 和类型化 ref；没有这类需求的控件无需预先创建 ref API。不要创建 Android fallback。

## 验证

```sh
pnpm test       # 参数、嵌套 session、结果、取消、重复清理、导航失败
pnpm check
pnpm bundle
pnpm ios        # Swift 更改后重新编译，不仅刷新 Metro
```

在设置页依次检查 Route / 四种呈现样式；完成后应显示系统版本，关闭或下滑后应显示“已取消”。在 Sheet 中打开下一层，完成或取消后应留在上一层。点击触感按钮应显示 Swift 异步调用完成；将 App 切到后台再返回应收到 Swift 前台事件。最后用原生关闭按钮退出。

## Cloud POC 数据入口

`src/cloud/auth/AuthProvider.tsx` 管理设备授权、恢复与退出；`src/cloud/auth/api.ts` 访问官方 Better Auth。凭据通过 Kit 的 `readAuthToken` / `saveAuthToken` / `clearAuthToken` 保存在 Keychain，`openAuthBrowser` / `closeAuthBrowser` 使用 Swift 的 SFSafariViewController。

`src/cloud/catalog` 订阅 Swift DataRuntime 的投影事件。原生端从 Keychain 获取 Better Auth session token，仅把短期 Streams grant 交给本地 WebView。`modules/lody-kit/data-runtime` 持有 Flock、副本游标和增量请求，`src/cloud/catalog/model.ts` 负责必要字段投影。旧离线 `decodeFlock` 保留作比较路径，项目页不再使用它们。

项目页持续订阅目录。点击会话通过 `requestOpenSession` 进入 mailbox，Tab 上的 bind hook 再 `present(SessionScreen, { session })` 打开正文。Kit 内 Loro WASM 订阅会话流；发送持久化用户历史与派发指针，再通过 Machine RPC 通知目标机器。RN 只渲染投影。Swift 看门狗负责重建，详见 [运行时验收](webview-runtime-poc.md)。
