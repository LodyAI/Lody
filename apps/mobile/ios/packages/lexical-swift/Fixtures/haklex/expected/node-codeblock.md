```typescript
type User = {
  id: string
  name: string
  role: 'admin' | 'editor' | 'viewer'
}

type ApiResult<T> = {
  data: T
  status: number
}

function assertOk<T>(result: ApiResult<T>): T {
  if (result.status >= 400) {
    throw new Error(`Request failed: ${result.status}`)
  }
  return result.data
}

async function fetchUsers(): Promise<User[]> {
  const response = await fetch('/api/users')
  const result = (await response.json()) as ApiResult<User[]>
  return assertOk(result)
}

async function bootstrap() {
  const users = await fetchUsers()
  const visible = users.filter((user) => user.role !== 'viewer')
  console.table(visible)
}

void bootstrap()
```