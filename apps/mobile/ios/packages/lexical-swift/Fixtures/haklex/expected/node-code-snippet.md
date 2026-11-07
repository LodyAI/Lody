::: code-snippet
::: file{name="index.ts" lang="typescript"}
```typescript
export function hello(name: string): string {
  return `Hello, ${name}!`
}
```
:::
::: file{name="test.ts" lang="typescript"}
```typescript
import { hello } from './index'

console.log(hello('World'))
```
:::
:::