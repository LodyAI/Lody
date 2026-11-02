# Condition context

The argument is `{ctx}`, not a global object. Available members:

```ts
ctx.sessionId: string
ctx.workspaceId: string
ctx.now: number // Epoch milliseconds for this check.
ctx.read(resource: string, parameters?: object): Promise<{
  value: unknown
  observedAt: number // Epoch milliseconds for the observation.
}>
```

Workspace is the storage/runtime scope; Session is the fixed continuation target.
`ctx.now` is not evidence that an external service is ready. `observedAt` is the
observation timestamp, not a promise of freshness for every nested field.

| Resource              | Parameters         | Read when                                                                                          |
| --------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `session`             | None               | [Session state](skill://lody-automations/references/session.md): compare input identifiers         |
| `session.group`       | None               | [Session state](skill://lody-automations/references/session.md): wait for related work to settle   |
| `github.pullRequests` | None               | [GitHub](skill://lody-automations/references/github.md): inspect associated PRs                    |
| `github.workflowRuns` | None               | [GitHub](skill://lody-automations/references/github.md): evaluate CI results for current PR HEAD   |
| `provider.capacity`   | None               | [Capacity](skill://lody-automations/references/capacity.md): inspect an existing quota observation |
| `events`              | `since?`, `limit?` | [Events](skill://lody-automations/references/events.md): compose predicates over persisted facts   |

For resources with no parameters, omit the argument or pass `{}`. Arbitrary resource
names and extra parameters are rejected. For exact context, return and read parameter
schemas, read `skill://lody-automations/references/context.schema.json`.

Reads return data; the condition uses CodeMode’s supported JavaScript subset. Unknown/incomplete observations
must not be treated as success. Payloads must be JSON; return concise results rather
than all observations. Each check permits up to 32 reads and each observation is
bounded to 128 KiB; the result is bounded to 64 KiB. Five consecutive check errors
fail the wait; a successful check resets that counter.

No Node, filesystem, shell, arbitrary network, MCP tool call, import, or credential
access is exposed inside the program. If the required data has no listed source,
report that missing capability instead of inventing `ctx` methods. The registration
tool runs outside this sandbox; its presence does not make it callable inside JS.
