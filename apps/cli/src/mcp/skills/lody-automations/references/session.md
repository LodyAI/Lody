# Session observations

`const {value: session} = await ctx.read('session')` returns:

```ts
{
  id: string;
  latestInputId: string | null;
  lastHandledInputId: string | null;
  archived: boolean;
  stopped: boolean;
}
```

Reads require a live registration and an available, owned Session. A stopped or
archived Session can reject the read; do not depend on polling those flags to bypass
Stop or reactivate it. Matching input identifiers alone does not establish group
settlement.

`const {value: group} = await ctx.read('session.group')` returns:

```ts
{
  value: 'yes' | 'no' | 'unknown';
  reason: string;
  retryAt?: number;
}
```

The group includes related Sessions, queues, Goals, native work and other automation
work. This wait is excluded so it does not wait for itself. Continue only when
`group.value === 'yes'`. The outer `value` is the observation; the inner `value`
is the settlement verdict.
