# Session events

```js
const { value: events } = await ctx.read('events', {
  since: 0,
  limit: 20,
});
```

`since` is an inclusive epoch-millisecond observation timestamp, default `0`.
`limit` is 1–100, default `20`. Results are newest ingestion first. The result is a bounded list, not a complete history;
an absent event does not establish that the corresponding work succeeded or failed.
Read `skill://lody-automations/references/events.schema.json` for the event envelope. Event `data`
belongs to its source; check the event type and its data before using it.

Events are scoped to this Session. A custom event predicate requires an installed
source that actually publishes that fact. Registering a wait does not create a
source or subscribe to an arbitrary external system. Return `false` for missing or
incomplete evidence. Use `ctx.read('github.workflowRuns')` for current CI state;
an old completion event alone does not establish the current HEAD/run outcome.
