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
ctx.exec(options: { command: string, args?: string[], cwd?: string }): Promise<{
  exitCode: number | null, signal: string | null, stdout: string, stderr: string
}>
ctx.fetch(url: string, options?: { method?: 'GET' | 'HEAD', headers?: Record<string, string> }): Promise<{
  ok: boolean, status: number, url: string, headers: Record<string, string>,
  text(): Promise<string>, json(): Promise<unknown>
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
than all observations. Each check permits up to 32 read, fetch or exec calls and each observation is
bounded to 128 KiB; the result is bounded to 64 KiB. Five consecutive check errors
fail the wait; a successful check resets that counter.

`ctx.fetch` reads HTTP or HTTPS endpoints accessible from the Host, including local services. It rejects redirects, URL credentials and request headers other than `accept` and `accept-language`. Responses are buffered up to 64 KiB; HTTP errors return their status, while transport failures fail the check. Checks may repeat, so use observational endpoints and never embed secrets in the program. `ctx.fetch` shares the call and concurrency limits with `ctx.read`.

`ctx.exec` runs an executable in the Session workdir; `cwd`, when supplied, is relative to it. Arguments are passed directly, without shell interpolation. For shell syntax, invoke a shell explicitly. Nonzero exit codes are returned as data. Commands have the local OS user's authority, receive a limited environment, and may run again after interruption or restart; use checks that are safe to repeat.

```js
async ({ ctx }) => {
  const result = await ctx.exec({ command: 'git', args: ['status', '--short'] });
  return result.exitCode === 0 && result.stdout.trim() === ''
    ? { resumeText: 'The working tree is clean. Continue.' }
    : false;
}
```

The program has no direct Node, filesystem, shell, MCP tool call, import, or credential access. `ctx.exec` can run a shell and access files or the network through the invoked command. The registration tool runs outside the interpreter; its presence does not make it callable inside JS.
