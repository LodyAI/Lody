# GitHub observations

These resources read PRs already associated with this Session. They do not accept
an arbitrary repository or PR URL. JavaScript may filter the returned associations.

`github.workflowRuns` returns one of:

```ts
{
  status: 'unknown';
  reason: string;
}
// or
{
  status: 'observed';
  pullRequests: Array<{
    prUrl: string;
    headSha: string;
    runs: Array<{
      runId: number;
      attempt: number;
      workflowId: number;
      headSha: string;
      branch: string | null;
      status: string;
      conclusion: string | null;
      updatedAt: number;
      url: string;
      repository: string;
      headRepository: string | null;
      prNumbers: number[];
    }>;
  }>;
}
```

Only the current associated PR per repository is checked. Missing, stale, fork or
incomplete evidence yields `unknown`; return `false` then. The poller owns GitHub
requests and quota limits. `intervalMs` controls JS checks, not GitHub polling rate.
An observation covers available workflow runs, not a guarantee that every required
check has been created. Do not infer merge readiness from all returned runs passing.

Read `skill://lody-automations/examples/wait-for-ci.js`, then pass its complete
function source as `command.program`. It matches completed runs whose conclusion is
`failure`. Add other conclusions only if the requested condition includes them.
It can match an existing failure immediately; it does not mean “only failures after
registration.” Lody captures HEAD/run evidence and rechecks it before delivery.

`github.pullRequests` returns an array:

```ts
Array<{
  url: string;
  status: string;
  observation: Record<string, unknown> | null;
  observedAt: number | null;
}>;
```

`status` is association metadata; the optional poll observation carries the source
snapshot. For automatic archive after merge, use the built-in setting described in
[settings.md](skill://lody-automations/references/settings.md), which also waits for group settlement.
