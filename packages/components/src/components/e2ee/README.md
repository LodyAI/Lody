# E2EE status prototypes

`E2eeAccessStatus` presents approval, key delivery, incomplete content, offline,
revoked access and item verification failures. `E2eeRecoveryStatus` presents
recovery setup, import, partial recovery and failure, with per-workspace evidence.
Both use the existing i18n provider, UI primitives and StyleX tokens.

Callers own state and callbacks. They must supply `scope` explicitly for access
states. Neither component changes permissions, generates keys, reads a recovery
file, calls a service or infers a workspace-wide stop policy. An omitted callback
omits the action. `pending` suppresses activation while retaining keyboard focus;
the caller supplies the eventual result. Unmounting does not persist progress:
real flow ownership and persistence remain future integration work.

A recovery file unlocks a cloud encrypted recovery library. Recovery identities
are independent per workspace. Saved information and recovery verified for a
particular key update are separate results. A login or file-open event is not
proof of access or successful recovery.

## Preview and checks

From the repository root after the normal submodule and dependency setup:

```sh
STORYBOOK_DISABLE_TELEMETRY=1 pnpm --filter @lody/components storybook --ci --host 127.0.0.1 --port 6016
LODY_STORYBOOK_URL=http://127.0.0.1:6016 pnpm --filter @lody/components test:e2e tests/e2e/e2ee-status.spec.ts --workers=1
pnpm --filter @lody/components typecheck
pnpm lint:i18n
```

Open `http://127.0.0.1:6016/?path=/story/e2ee-status--all-states`.
Use Storybook's locale/theme toolbar for English/Chinese and light/dark. `Retry`
and `Recovery Retry` show explicit synthetic pending → failed results: Tab to
Retry, Enter, Tab to Simulate failed result, Space, Shift+Tab, retry again. No
button simulates successful authorization. The result control stays mounted so
focus does not fall back to the document body.

The browser suite exercises both languages at 360 and 1280 CSS pixels, captures
screenshots as Playwright attachments, inspects accessible names/list content,
and checks keyboard activation, pending suppression and focus after failure.
Also inspect at 200% zoom and with a real screen reader. Accessible-tree checks
alone do not establish spoken announcement quality.

These examples do not select the pending single-document versus workspace-wide
failure policy. They add no product route or user entry point. Full platform Beta
acceptance, cryptographic correctness, durable recovery and real services remain
outside this prototype. See the [implementation note](../../../../../.agents/notes/implemented/feature/2026-10-10-e2ee-status-prototypes.md).
