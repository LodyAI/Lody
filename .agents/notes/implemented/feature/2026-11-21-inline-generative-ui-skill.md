# Inline generative UI through an opt-in fence and an MCP skill

Status: implemented
Translation: current

[中文](2026-11-21-inline-generative-ui-skill.zh.md)

## Abstract

Lody runs HTML from assistant replies as sandboxed UI inside the conversation, but
agents were never told the capability existed, and every closed `html` fence ran,
including HTML source a coding agent meant the user to read or copy. Execution now
requires the exact info string `html render`. The built-in MCP server publishes a
`lody-visualize` skill that teaches the marker, the sandbox limits and the theme
variables, and its server instructions name the skill URI. Agents that never read the
skill keep showing plain HTML as source. The guidance is fixed per CLI bundle and cannot
follow an App setting, and whether hosts other than Claude Code read MCP instructions is
unverified.

## Decision

- **Opt-in marker.** Only a closed fence whose info string is exactly `html render`
  executes. The Markdown parser decides the marker and records it by source position, the
  same way it records fence closure, so `rehype-raw` and sanitization cannot erase it and
  raw HTML attributes cannot forge it. The language stays `html`, so a fence still
  streaming as source keeps HTML highlighting.
- **Guidance as an MCP skill.** `lody-visualize` ships in the existing bundled skill
  catalog. The server instructions name every entry URI because Codex 0.160.1 and Claude
  Agent SDK 0.3.293 did not request `skills/list` in the recorded probe
  ([delivery](../../../../apps/cli/src/mcp/README.md#skills-over-mcp)); instructions are
  the one connection-time channel those hosts receive.
- **Prompt sources.** T3 Code shows HTML through MCP tools (`html_preview` returns a
  screenshot, height and console output; `html_render` publishes the page). Their tool
  descriptions supplied the rules the skill adopts: do not announce or restate the page;
  leave html, body and the outer element without background, card, border or side
  padding; use theme variables; let content set the height, with no `vh` units. The skill's
  structure (decide whether to use it, route by need, universal constraints, a final check)
  follows the Figma diagram skill bundled in opencode; opencode has no inline
  visualization of its own.

## Alternatives

- **Render every closed `html` fence.** This was the previous behavior. Coding agents
  routinely use `html` fences for source, and most agents never read the skill, so
  intended source would run.
- **A separate language such as `lody-ui`.** It loses HTML highlighting while the fence
  streams as source, and agents are less likely to write valid HTML under an unfamiliar
  language name.
- **Inject a prompt per turn from an App setting.** The App could flag the turn and the
  CLI could append guidance, reaching agents that ignore MCP instructions. It adds a
  prompt-injection path the MCP skill delivery explicitly avoids, and was not chosen.
- **A dedicated render tool, as in T3 Code.** Server-side rendering gives the agent a
  screenshot and a measured height before publishing. It needs a headless browser and
  attachment storage; Lody's fence already renders client-side and measures its own
  height.

## Consequences

- The skill must match the renderer: the `--preview-*` variable names, the
  `allow-scripts`-only sandbox, the 10,000px height cap and its loop guard. The
  [HTML preview rules](../../../../packages/components/src/components/ai-gui/html-preview/AGENTS.md)
  bind both sides.
- Agents cannot see the result. The skill asks for small pages and a browser check when
  one is available; a Lody preview tool remains the largest gap compared with T3 Code.
- Lody injects no chart palette or status colours. The skill directs one accent series,
  neutral others, and `light-dark()` for extra colours.
- An App setting can later hide the capability on the client by showing `html render`
  fences as source; the MCP guidance itself does not change per user.

## Verification

- `packages/components/tests/markdown-streaming-reparse.test.ts` pins marker gating,
  closure, nested containers and forged raw attributes.
- `apps/cli/src/mcp/skills/server.test.ts` pins the listed skills, exact served bytes,
  reachable links and instructions naming every entry; `lody-mcp-server.test.ts` pins the
  HTTP listing.
- Storybook `Conversation/Markdown HTML` includes a `Source` story for a plain fence. The
  skill's example chart was rendered in a temporary story in dark and light themes.
- Unverified: whether Codex and other ACP agents read MCP server instructions, and how
  agents use the skill in real sessions.
