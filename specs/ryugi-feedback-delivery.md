# Ryugi feedback delivery

Status: draft
Translation: current

[中文](ryugi-feedback-delivery.zh.md)

## Scenario

An agent in a Lody Session opens a [Ryugi](https://github.com/Innei/ryugi) artifact:
an artboard, document, whiteboard, slide deck or verify report. The user picks an
option, pins a comment or passes the result on that page. The feedback should reach
the same Session, appear in its history and be handled like any other input, whatever
provider runs the Session.

Ryugi currently delivers feedback through each harness's native route, and inside Lody
those routes either bypass Lody or never arrive:

- The Pi and DeepSeek Harness extensions start a provider turn Lody did not submit.
  Lody cannot show that turn's output, and its next prompt is rejected as busy;
  [acp-extension-pi#38](https://github.com/LodyAI/acp-extension-pi/issues/38) shows
  the rejection surfacing as an internal error that terminates the Session.
- Codex delivery needs an App Server endpoint that Lody's stdio adapter does not
  expose. Kimi, Devin and Grok have no push route at all.

## Decision

Lody acts as Ryugi's host for Lody Sessions through Ryugi's public custom-host
contract: a `hosts` configuration, the `RYUGI_HOSTS_CONFIG` override, one delivery
command per event and a receipt. The mechanism lives once in Lody core and contains
no per-provider code.

```text
Ryugi page ── event ──> ryugi-hook (host lody) ──> Lody delivery command
          ──> Session Inbox ──> ordinary ACP prompt ──> any provider
```

1. **Environment.** Each ACP agent process and Lody-provided terminal already
   receives `LODY_SESSION_ID`. Lody also sets `RYUGI_HOSTS_CONFIG` to a file it owns
   under the Lody data directory.
2. **Host file.** That file declares a `lody` host keyed on `LODY_SESSION_ID`, whose
   command is the Lody CLI's delivery command by absolute path. Lody reads the user's
   own Ryugi configuration read-only and carries its other hosts over. Lody never
   writes the user's file. If a user host is keyed on a variable Lody sets, Lody
   injects nothing, so Ryugi never resolves two hosts.
3. **Subscription.** Ryugi resolves a custom host before its built-in hosts. An
   artifact opened from the Session therefore subscribes as `lody/<sessionId>` under
   every provider. Ryugi's Claude and Codex watchers stand down for a custom host, and
   its Pi and DeepSeek Harness watchers receive no events.
4. **Delivery.** The command reads Ryugi's payload and submits Ryugi's wake message
   unchanged as queued Session input whose source is Ryugi. The input passes through
   the ordinary Session Inbox admission, queue, Stop and access owners. It waits
   behind a running turn, never steers it, and never starts provider work outside a
   prompt Lody submits.
5. **Receipt.** Accepted input exits 0 with `{"status":"queued"}`. A transient failure,
   such as an unreachable daemon or unconfirmed sync, returns
   `{"status":"retry","reason":…}` so Ryugi retries. An archived, deleted or
   no-longer-accessible Session exits 10, which unsubscribes it.

## Guarantees

- Ryugi feedback enters a Session only as Inbox input under normal admission. Lody's
  queue orders it against the user's own messages.
- History labels the input as coming from Ryugi, not as typed by the user. Delivery
  acts as the machine-owner principal that the
  [automation rules](../apps/cli/src/automations/AGENTS.md) define for CLI commands,
  and rechecks edit access to the Session at delivery.
- Lody adds only the origin label. It adds no instruction to Ryugi's text, following
  the root rule on text sent to agents.
- Sessions without Ryugi installed behave exactly as before. The user's Ryugi
  configuration is never modified.
- Adapters must report a busy rejection as `invalid request` (`-32600`), not as an
  internal error. That adapter fix is tracked separately and does not depend on this
  Spec.

## Limits

- The agent must have Ryugi's skills loaded. Installation is provider-specific and is
  not managed here; Pi, for example, needs the extension selected in Lody.
- A provider that runs tools in a process that does not inherit the agent environment
  falls back to Ryugi's native route.
- Ryugi's hook uses Unix sockets and ships only macOS and Linux builds, so Windows is
  out of scope.

## Open questions

- Should delivery stay on by default with an explicit disable switch (currently
  `LODY_DISABLE_RYUGI_HOST=1`), or should it also have a UI machine setting or opt-in
  flow?
- Comments that other people leave on a published Ryugi Cloud artifact are forwarded
  by Ryugi. Should Lody accept them into the Session, and should they be labelled
  differently from local Ryugi feedback?
- Ryugi's worker for an ended Session exits only after its next delivery is refused
  with exit code 10. Does Lody need to stop it sooner?

## Evidence

Implemented in this branch and validated with unit and local Unix-socket IPC tests;
live end-to-end execution with an installed `ryugi-hook` binary has not yet been run
in this checkout:

- Shared contracts: `packages/shared/src/message-author.ts`
  (`ExternalMessageAuthorSchema`), `packages/shared/src/session-doc-schemas.ts`
  (`messageQueueItemSchema.author`), `packages/shared/src/session-inbox-deliver.ts`
  (`/session-inbox-deliver` schemas and exit code 10), and
  `packages/shared/src/node/local-ipc.ts` (`sessionInboxDeliver`).
- Host file and environment injection: `apps/cli/src/lib/ryugi-host.ts`
  (`prepareRyugiHostsConfigSync`, read-only user config merge, conflict avoidance,
  `LODY_DISABLE_RYUGI_HOST=1` opt-out, Node/Electron/SEA command resolution),
  wired in `apps/cli/src/session/session.ts` (`buildShellEnv`) and
  `apps/cli/src/lib/terminal-pty-service.ts` (`buildTerminalEnv`).
- Delivery command and daemon handler: `apps/cli/src/commands/session-inbox.ts`
  (`lody session inbox deliver --source ryugi`, canonical event deduplication,
  `queued`/`retry`/exit-10 receipts), `apps/cli/src/lib/session-inbox-deliver.ts`
  (machine-owner edit-access recheck, `resolveSessionConversationConfig`, encrypted
  workspace `signMachineInput`, queue signaling), `apps/cli/src/lib/local-session-control.ts`,
  `apps/cli/src/lib/local-control-handler.ts`, `apps/cli/src/lib/lody-fleet.ts`, and
  `apps/cli/src/session/session-dispatch-watcher.ts` (preserving `author` on queue
  promotion).
- UI attribution: `packages/components/src/components/ai-gui/message-author-identity.tsx`
  (`ExternalMessageAuthorIdentity`), `packages/components/src/components/ai-gui/view.tsx`,
  `packages/components/src/components/sessions/message-queue/message-queue-row.tsx`,
  and `locales/{en,zh_CN}.json`.
- Inspected upstream sources: Ryugi `7a3ee3c` (`hook/src/{hosts,cmd,subs,watch,codex,wake,queue}.rs`,
  `.pi/extensions/ryugi.ts`, `.dsh/index.mjs`, `docs/install.md`) and Pi adapter
  `66cc30a` (`src/connection.ts`).
