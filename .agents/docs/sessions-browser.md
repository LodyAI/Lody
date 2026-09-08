# Session Browser engines, Managed Preview, HTML viewer, annotations

The two browser engines, the loopback-only Managed Preview boundary, static HTML rendering, and visual annotation.

Scope: `packages/components/src/components/sessions`. Binding rules and the
pointer to this page live in
[that directory's AGENTS.md](../../packages/components/src/components/sessions/AGENTS.md);
this page is the full text of the rules summarised there.

- Complete `.html` / `.htm` viewer text may switch between Monaco source and Managed Preview without
  a Machine RPC endpoint. Build a policy-owned `srcdoc` from the current complete viewer text,
  inject the shared annotation runtime, and run it in uncached static-document mode
  (`allow-scripts` only, opaque origin). Static frames must be destroyed as soon as the file
  tab or rendered mode becomes inactive; never park their JavaScript in the Browser frame cache.
  Keep CSP/referrer/base policy and the annotation runtime ahead of source scripts, map runtime
  messages to a file-path logical URL whose namespace distinguishes relative, POSIX-absolute,
  Windows-drive, and UNC paths. Same-document `#fragment` links stay inside the `srcdoc`; leave
  rendered mode on every other navigation request because local subresources/pages are not part of
  the single-document contract. HTML starts in code mode,
  and truncated documents are never executable. The iframe is a permission boundary, not a promised
  renderer-process/thread boundary; do not claim arbitrary user JS cannot consume the app renderer.
  Likewise, CSP governs the initial `srcdoc`, not an arbitrary later self-navigation. Require
  credentialless iframe support before offering the toggle, and do not describe the
  self-contained/no-network rule as a hard browser guarantee. The rendered frame exists only while
  its viewer tab and containing sidebar are visible. Key the file viewer by session + tab so switching
  session targets always returns HTML to code mode before the new file can execute.
- Session Browser has strict dual engines, split on exactly one question: is the address the
  agent machine's own LOOPBACK? Only that uses Managed Preview, where the machine opens one
  approved port on itself; those are the only pages eligible for Visual Annotation. Everything
  else — public sites AND private LAN / `.local` / `host.docker.internal` — uses the declared
  public-browser capability (Electron `WebContentsView` today), which is the user's own browser
  on the user's own machine reaching the user's own network. Never fall back from a missing
  public engine to iframe, system browser, CLI, Preview Gateway, or a different Machine RPC plane.
  INVARIANT — a managed preview is never a pivot: routing a LAN address through the machine
  would let whoever holds the tunnel reach hosts behind that machine that they could never reach
  themselves, and the approver sits on the OTHER side of the tunnel, so approval cannot make it
  safe. `parseBrowserAddress` never routes LAN there and `PreviewTargetApproval.targetClass` is
  the literal `'loopback'`, but the CLI's `normalizeTarget` is the authoritative rejection.
  The public engine has NO network guard — no resolver check, no per-request hostname policy.
  It is a sandboxed view with no preload, script injection, page capture, or agent tool, so
  the only reader of what it renders is the person looking at it, and it is strictly less
  capable than the user's own Chrome. The DNS guard it once had broke every fake-IP proxy user
  (Clash, Surge, sing-box, Shadowrocket — all their answers land in `198.18.0.0/15`) while
  protecting nothing. The engine split is therefore by hostname TEXT: a public name that
  RESOLVES to loopback still opens in the public engine. Do not document it as
  resolution-accurate.
  A guard must return if the view gains a non-human READER, attached to that path rather than
  to human navigation. A non-human NAVIGATOR already exists and is handled here, not in
  Electron: a Managed Preview page is served by the agent machine, so the navigation requests
  its injected script posts up (`handleManagedNavigationRequest`) are agent-authored. Those
  carry `fromPageContent`, and `openAddress` refuses a private-LAN destination for them —
  public is an ordinary external link and loopback still needs its own approval in the managed
  branch, but a LAN address would open silently on the USER's network at a page's request.
  Only the address bar may reach one.
  The composer info-bar Browser action is an explicit candidate-navigation request, not merely a
  panel-open action. It opens the reported candidate even when another page is already visible.
  That click IS the approval for that exact target: a remote route creates (or replaces) its tunnel
  immediately, with no confirmation dialog, because the CLI only accepts LOOPBACK targets from an
  agent report. A typed loopback address and Share still go through the confirmation flow. The
  approver is the session initiator, the same person the CLI already requires.
  Consume the request after handling it so a later panel remount cannot replay stale user intent —
  but NOT while the candidate is still in flight. Session meta carries only the candidate status;
  its target lives in the session doc `preview` state, and the two planes sync independently, so a
  click landing between those writes must wait for the doc (bounded by the doc reaching `synced`)
  instead of consuming the request and leaving an empty panel.
  An empty Browser must always say WHY it is empty — a bare globe reads as a broken panel. With no
  reported candidate the empty state names that (the agent never called `lody_report_preview_candidate`,
  which is the common case, not a bug); with one, it points at the address bar.
  Annotation mode installs a full-viewport transparent interaction layer inside the managed page;
  it must remain the pointer target while hit-testing temporarily ignores it to inspect the page
  below. Do not revert to listener-only interception, which lets page pointer handlers activate.
  Draft and persisted comment UI render outside the iframe, so both must be registered with the
  injected runtime as tracked anchors. Their overlay position must come from refreshed resolved
  rects on page scroll; an initial click rect is only a pre-resolution placeholder.
  Injected annotation target payloads use path-relative `page.url` values; resolve them against the
  logical preview URL before stripping capability parameters. Treat parse failures as visible runtime
  errors instead of silently dropping the selection message.
  Creating a new preview comment immediately stages its visual-annotation reference in the matching
  session composer through the idempotent `addVisualAnnotationReference` path. Existing-comment
  controls use the separate toggle path so users can remove or re-add a staged reference.
  Preview comment create/resolve/unresolve/submitted writes MUST go through
  `runtime.writer.mutatePreviewVisualComments`; never call the preview comment store's `setState`
  from UI code. Preview comments are renderer-authored user data on every platform.
