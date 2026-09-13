# Let Codex and Grok own their session titles, and split the ACP title predicates

Status: implemented
Translation: current

[中文](2026-09-08-acp-owned-session-titles.zh.md)

## Abstract

Lody wanted every builtin agent to stop carrying its own `titleGeneration`
session config and take the session title from its ACP adapter instead. An audit
of all five builtin adapters found three that already produce a usable title —
Claude, Codex, and, contrary to a first reading that inspected only our proxy,
Grok, whose official runtime generates one and pushes it, confirmed by live probe
— so all three now take the ACP title while Kimi and the DeepSeek Harness keep
the isolated generator. Codex and Grok were both doing the work twice, each
generating a title that Lody then either duplicated or discarded. Delivering this
required splitting the single `usesAcpProvidedSessionTitle()` predicate into
ownership and trust, because Codex tags its titles and emits a prompt-preview
`fallback` first while Claude and Grok push one bare authoritative title, and
conflating the two would have promoted Codex's preview to the session title. The
cost is that title wording now belongs to the adapters. Branch naming was the last
caller able to start an isolated session, and it is removed outright rather than
reimplemented locally: deriving a git ref from prompt text publishes the prompt, and
no prompt-based filter can prove a secret absent. Worktree sessions keep their
`session/<id>` branch.

## The audit

Each adapter was read at the commit this repository pins; the versions below were
re-confirmed after merging main, which moved the Codex, Grok and Harness pins
without changing any of these findings.

| Adapter | Version | Publishes a title | `_meta.lody.titleSource` | Real generation |
| --- | --- | --- | --- | --- |
| `acp-extension-claude` | 0.70.0 | yes | no `_meta` at all | yes — SDK `generate_session_title` control request |
| `acp-extension-codex` | 1.10.1 (since 1.8.0) | yes | yes, generated titles are `explicit` | yes — cheap-model turn on an ephemeral thread |
| `acp-extension-grok` | 0.1.3 (runtime 1.0.13) | yes — the runtime pushes it and the proxy forwards it | no `_meta` at all | yes — upstream `title_refresh.rs` |
| `acp-extension-kimi` | acp-server 0.0.1 | yes, but the title is the first prompt truncated to 200 chars | no `_meta` at all | no |
| `acp-extension-dsh` | 0.1.2 | no | no | no |

Two near-misses are worth recording because they change what "add title support"
would cost later. Kimi's engine already tracks
`SessionTitleKind = 'replaceable' | 'generated' | 'custom'`, and it has a real
generator (`SessionTitleService`, backed by Moonshot's managed `chat_title`
endpoint) — but the generator is reachable only from the kap-server HTTP route and
the node SDK, and the kind is discarded at the ACP boundary in
`packages/acp-server/src/events-map.ts`. The DeepSeek Harness pins
`@deepseek-ai/dsh-session-title` in its dependency closure but never mounts it in
`createDeepSeekHarnessCordisConfig`, so the plugin is inert.

Grok is the sharpest correction to an earlier reading of this audit. The adapter
is a pure stdio proxy with no title code, which is easy to mistake for "Grok has
no titles". The official `@xai-official/grok` 1.0.13 runtime pinned by
`runtime-manifest.json` in fact ships a full automatic title generator: strings in
the shipped binary include the `session_title` tool-call prompt ("Final session
title, just 5-10 word descriptive title for the session"), the failure path
"session title generation failed, falling back to truncated user text", and user
documentation stating the title is generated right after the first prompt,
regenerated over a couple of early turns, then frozen, with `/rename` and
`/rename --auto` as manual overrides. Decisively, the logic lives at
`crates/codegen/xai-grok-shell/src/session/acp_session_impl/title_refresh.rs` —
inside the ACP session implementation, alongside `goal.rs`, `mcp.rs` and
`prompt_build.rs` — so it is not TUI-only, and the runtime's ACP `SessionUpdate`
enum includes `session_info_update` with `title` and `updatedAt`.

That title does reach the ACP wire, as a pushed notification. A probe run on a
credentialed machine against runtime 1.0.13 — one short turn, then a 25s wait —
produced exactly one push per run, both talking straight to `grok agent stdio`
and routing through `acp-extension-grok`:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"01a08127-...",
 "update":{"sessionUpdate":"session_info_update","title":"Reply with single word ok"}}}
```

The same title landed in the session's on-disk `summary.json` (`session_summary`
non-empty, so generation genuinely ran), and the proxy filtered nothing — the two
paths differed only in generated wording. Crucially the message carries **no
`_meta` at all**, so Grok has the same shape as Claude: one authoritative pushed
title with no `titleSource` to gate on. Lody therefore already receives Grok's
title today and discards it in `handleAgentSessionTitleUpdate` for want of a tag.
Only one push was observed, with no `fallback`-style preview beforehand.

The pull path does not exist in the mode Lody runs: `x.ai/session/info` answers
`-32601 Method not found` under `grok agent stdio`, direct and through the proxy
alike. The literal string is present in the shipped binary, so the method is
presumably registered on some other channel, but not on the ACP agent one. That
has a consequence beyond titles, recorded here because the evidence is in hand:
`proxy.js` issues `internalRequest('context', ...)` after `model_changed` and at
session start, and drops the reply when it is an error, so builtin Grok's
context-window usage notification is silently dead against this runtime. Fixing
that is separate work and is not attempted here.

## Decision

`usesAcpProvidedSessionTitle()` answered two different questions at three call
sites, and Codex needs opposite answers to them:

- *May Lody skip its isolated generator and hide the title config?* Yes for
  Claude, Codex and Grok. This is now `acpOwnsSessionTitleGeneration()`.
- *May Lody trust a pushed title that carries no `titleSource`?* Only for Claude
  and Grok, which both send a bare `session_info_update`. This is now
  `trustsUntaggedAcpSessionTitle()`.

Capability negotiation was the alternative, and it was deferred rather than
overlooked. The adapters already declare `_meta.lody` capabilities that Lody
consumes (`usage`, `rateLimits`, `compaction`, ...), and the Grok proxy even
synthesizes some the runtime never sends, so a `sessionTitle` capability is the
shape this rule eventually wants — it would degrade correctly when a
`BuiltinRuntimeOverrides` path points at an older binary, and would let registry
and custom providers opt in, neither of which an identity allowlist can do. The
cost is what deferred it: `acpOwnsSessionTitleGeneration` is consulted at session
start before `initialize` returns, and again in the settings dialog where no
client exists, so it needs the capability *persisted* — a new field on
`AcpCapabilityCacheEntry`, threaded through the capability probe and both
positional doc signatures, plus an `ACP_CAPABILITY_CACHE_VERSION` bump that
invalidates every user's cache and a bootstrap path for never-probed configs.
That is a larger change than this one, and it spans three adapter submodules.
`BUILTIN_ACP_TITLE_OWNERSHIP` is the interim stand-in; it is exhaustive over
`BuiltinAgentType` so a new builtin agent cannot silently default.

The table also collapses what began as two hand-synced lists. The trusted set is
a strict subset of the owning set, and expressing that as one `none | untagged |
tagged` value per agent makes the relation structural instead of a comment.
Codex is the reason the two questions differ at all. It emits a
`fallback` prompt-preview title before its generated `explicit` one, and
`apps/cli/src/agent/AGENTS.md` already required rejecting that preview. Keeping
one predicate and extending it to Codex would have silently made the raw first
prompt the session title — the main trap this split exists to prevent. Grok, by
contrast, was observed to push exactly one title with no preview, so it joins
Claude in the trusted-untagged set.

The `titleGeneration` config surface (schema field, settings section, CLI flags)
is deliberately left in place. Removing it would strip the cheap-model and
least-privilege-mode selection that Kimi, the DeepSeek Harness, registry and
custom providers still rely on. The config simply stops being reachable for Codex
and Grok, as it already was for Claude.

"Unreachable" has to hold on every path, not just the settings form. Branch
naming resolved the persisted `titleGeneration` for whatever agent it was naming
a branch for, so a value stored before this change would have kept steering
Claude, Codex and Grok runs after their config disappeared from the UI. That
lookup is gone with the branch-naming path itself (below).

## Trade-offs and limits

Codex generates its title after the first turn completes and skips generation
entirely on resumed sessions (its internal source is `unknown` there), so a
resumed codex session no longer gets a Lody-generated title. Generation is also
best-effort inside the adapter and swallows failures without signalling the
client, so a failed generation now leaves the draft title rather than falling
back to Lody's generator.

Handing titles to the adapters also hands over their wording. None of the three
sees `DEFAULT_TITLE_GENERATION_PROMPT`, so constraints it carries — the 26-letter
English budget, the single-line rule — no longer apply to them. Grok additionally
keeps refining its title over the first few turns before freezing it, so a Grok
session title can change after it first appears.

Branch naming had to change too, or the isolated session would simply have moved
from the title path to the branch path. `maybeRenameSessionBranchFromPrompt` ran at
session-ready, before any turn, so an ACP title can never have arrived by then; with
the title path skipped it would have started its own agent, leaving worktree sessions
at exactly the same one isolated session as before. It took three attempts to land,
and the first two are recorded because each looks reasonable until you see why it
fails.

Deferring the rename until the pushed title arrives was rejected first: it moves a
"once, at session creation" operation into the middle of a running conversation,
where a turn may already have pushed the branch or opened a PR, and
`renameBranchWithAvailableSuffix` was a bare `git branch -m` with no upstream check.

Deriving the name locally from the prompt landed next, and review found it publishes
secrets. A branch name is a ref: it reaches the remote as soon as the session opens a
PR, and asking an agent to "rotate the password before Friday" is ordinary. This was
reachable before this branch too — the old `generateTitleIsolated` returned
`sanitizeGeneratedTitle(taskPrompt)` on every failure path — but skipping title
generation for the three ACP-owned agents turned a rare fallback into the common path.

Two filters were then tried, and both failed for the same reason. The first stripped
credential-shaped tokens and named the branch from what was left; a secret has no
reliable shape, since `hunter2` is a password and an ordinary word, so a shape-based
denylist removes what looks secret and keeps everything else — `Fix DB_PASSWORD=hunter2`
and `Fix https://alice:hunter2@example.com` both survived it verbatim. The second
failed closed on credential *syntax* (an assignment to a sensitive name, URL userinfo,
known prefixes, PEM blocks, high-entropy runs) and caught those two, but any
prompt-based check fails *open* on every miss, so plain prose like "the password is
hunter2" still published. A boundary that fails open is not a boundary.

So the path was removed rather than filtered a third time.
`maybeRenameSessionBranchFromPrompt`, `deriveWorktreeBranchName`,
`branch-name-generator.ts` and the now-unreachable `renameBranchWithAvailableSuffix` /
`isManagedWorktreeBranchName` are deleted. A worktree session keeps the `session/<id>`
branch `worktree-manager.ts` gave it. Nothing is silently lost: `syncSessionBranchName`
still records the session's real branch after every turn, so an agent that renames it
is picked up, and GitHub-project prompts already carry an instruction asking the agent
to name branches after the task (`GITHUB_WORKTREE_SYSTEM_COMMANDS`). That instruction
is not a replacement — `buildPrompt` runs only in `startSession` and the instruction is
stripped before storage, so it is absent from turn two onward and from resumed
sessions, and it is injected only for `project.kind === 'github'` while worktrees are
also created for local projects with `useWorktree`.

Restoring automatic naming needs a source provably isolated from the prompt. None
exists at session-ready: the ACP title has not arrived yet, and the isolated
generator's own fallback is the raw prompt. A title known to be model-generated rather
than prompt-derived would qualify, but the current code cannot distinguish the two.

Ownership also had to account for `BuiltinRuntimeOverrides`. The table describes the
managed runtime each agent normally launches, but an override can aim the same
`agentType` at any executable, including one predating the title behaviour — Grok's
title generation lives in the runtime itself, and Codex's needs an `ephemeral` thread
its older builds lack. Such a session got no title at all: the isolated generator was
skipped, nothing arrived over ACP, and the setting that would have fixed it was
hidden. `acpOwnsSessionTitleGeneration` now returns false whenever an override is
active, restoring the local generator and the config for it. The trust gate is
deliberately unchanged: an override that does push a good title still gets it, and
Claude behaved this way before this branch.

One residual inconsistency is known and left alone: `acpOwnsSessionTitleGeneration`
gates the settings dialog, but `lody agent-config` and the onboarding provider
screen still accept and persist a `titleGeneration` block for these agents. The
stored value is now provably inert — nothing reads it for them on any path — so
this is cosmetic, and applying the predicate in the config write path is a
follow-up.

Verification is type checks, lint, and the shared unit tests covering both
predicates, the branch-name derivation cases, and the dialog cases covering the
hidden title-generation section. The Grok behaviour rests on the live probe
described above; no live Codex, Kimi or DeepSeek session was exercised, and no
real worktree rename was driven end to end.
