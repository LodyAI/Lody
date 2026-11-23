# Provider capacity observations

Prefer `recoverCapacity` in [Session settings](skill://lody-automations/references/settings.md) for resuming interrupted
work. That policy retains the original native conversation and unfinished input.
A custom wait sends a new continuation message and is not a substitute for recovery.

`const {value: capacity} = await ctx.read('provider.capacity')` returns an existing
observation's eligibility:

```ts
{
  status: 'yes' | 'no' | 'unknown';
  reason: string;
  windows?: Array<{
    id: string;
    usedPercent: number;
    resetsAt?: number;
    observedAt?: number;
    validUntil?: number;
  }>;
  authentication?: 'valid' | 'invalid' | 'unknown';
  billing?: 'valid' | 'invalid' | 'unknown';
  validUntil?: number;
}
```

The read does not actively contact the Provider. `unknown` is not available
capacity. A reset timestamp only suggests when to check again; it is not proof of
capacity. All relevant windows and binding freshness participate in eligibility.
