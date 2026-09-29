# Default app entry

Status: draft
Translation: current

[中文](app-startup-landing.zh.md)

When the app opens at its default entry, an available workspace opens at chat
landing (`/$workspaceName/chat`). The previously visited conversation or work
view must not determine the startup destination.

Workspace selection retains its existing rules: the local workspace in local
mode, or the preferred/active available workspace in authenticated mode. Login,
onboarding, provisioning, and workspace-creation gates still apply.

Do not persist the last visited route. Legacy `lody:lastAppRoute` values are
ignored, including by the initial boot shell. An explicit deep link or requested
auxiliary-window target still opens its requested destination. Reloading a
specific URL and returning focus to an already open window retain their current
navigation semantics.

## Evidence

- Entry routing: [index.tsx](../packages/components/src/routes/index.tsx).
- Regression coverage: [home-route.test.tsx](../packages/components/tests/home-route.test.tsx).
- Decision: [remove route restoration](../.agents/notes/implemented/simplification/2026-09-29-startup-chat-landing.md).
