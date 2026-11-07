## 结论

刷新失败的根因是 **token 过期后没有重试**：`AuthSession.refresh()` 在收到 `401` 时直接抛出，调用方把它当成了网络错误，所以界面一直停在 *Syncing…*。

### 修改方案

1. 在 `refresh()` 里区分 **凭证失效** 和 **网络失败**
2. 凭证失效时清空本地 token，并回到登录页
3. 网络失败保持现有的指数退避，最多重试 `5` 次
   - 第一次等待 1s
   - 之后每次翻倍，上限 30s

> 注意：重试期间不要清空已缓存的会话目录，离线时仍然需要显示。

### 代码

```kotlin
suspend fun refresh(): Token {
    val response = api.refresh(current)
    return when (response.code) {
        200 -> response.token.also(store::save)
        401 -> {
            store.clear()
            throw AuthExpired()
        }
        else -> throw NetworkFailure(response.code)
    }
}
```

对应的 Swift 版本基本一致：

```swift
func refresh() async throws -> Token {
  let response = try await api.refresh(current)
  switch response.status {
  case 200: return try store.save(response.token)
  case 401: store.clear(); throw AuthError.expired
  default: throw NetworkError.status(response.status)
  }
}
```

### 影响范围

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `AuthSession.kt` | 区分 401 与网络错误 | 低 |
| `CatalogRepository.kt` | 失效时断开订阅 | 中 |
| `HomeActivity.kt` | 回到登录页 | 低 |

### 验证

- [x] 单元测试覆盖 `401` 和超时两种路径
- [x] 断网时目录仍显示缓存，标题显示 **Offline · showing saved chats**
- [ ] 真机上验证后台恢复后的重新授权

如果需要，我可以继续把同样的处理补到 iOS 的 `AuthSession.swift`，详见 [设计说明](https://example.com/auth-refresh)。
