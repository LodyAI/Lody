# Built-in Session settings

All features default off. Call `lody_automation` with:

```json
{
  "command": {
    "type": "configure",
    "settings": {
      "recoverCapacity": true,
      "compactWhenIdle": {
        "contextTokens": 300000,
        "cacheTtlMs": 600000,
        "leadTimeMs": 60000
      }
    }
  }
}
```

Only include the features the user requested. This patches this Session's settings;
omitted fields retain their value. Inspect with `{command: {type: "settings"}}`.
Exact defaults and limits are in `skill://lody-automations/references/commands.schema.json`.

| Setting                   | Behavior                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recoverCapacity: true`   | Preserve interrupted native work after a structured quota failure or Codex model overload and attempt recovery when eligible. A reset time triggers a recheck, not assumed capacity. Model overload permits up to three attempts with increasing delays. Original conversation, release and permission boundaries still apply.   |
| `compactWhenIdle: {...}`  | After a completed turn reaches `contextTokens`, schedule native compaction before the configured cache estimate expires, provided the same turn remains idle and the adapter supports `/compact`. New input invalidates maintenance. |
| `archiveAfterMerge: true` | After observing merge, wait for the Session group to settle and archive under existing admission rules.                                                                                                                              |

Times are milliseconds. `cacheTtlMs` is an operator estimate, not a detected Provider
cache expiry or a guaranteed discount. `leadTimeMs` must be shorter than
`cacheTtlMs`, including when using its default. Enable settings before the expected
event: configuration applies to future observations, not a scan of past failures.

Disable a feature by setting it to `false`, including `compactWhenIdle: false`.
Disabling prevents new submissions; inspect `activities` and cancel the returned
activity ID for already accepted work. Settings persist until changed, unlike
one-shot JS registrations. Recurring scheduled tasks continue to use Lody Schedules.
