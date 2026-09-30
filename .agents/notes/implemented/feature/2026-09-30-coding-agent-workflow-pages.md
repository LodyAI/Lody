# Coding-agent GUI and remote workflow pages

Status: implemented
Translation: current

PR: [#1150](https://github.com/LodyAI/Lody/pull/1150)

[中文](2026-09-30-coding-agent-workflow-pages.zh.md)

## Abstract

Readers looking for a coding-agent GUI or remote workflow need a focused explanation of what Lody
adds across agents. Two English marketing pages now connect those use cases to setup documentation,
using the existing marketing shell and real public product screenshots. The pages distinguish
agent runtimes from provider presets and acknowledge official vendor interfaces. Integration coverage
does not claim feature parity or real-model end-to-end validation across all clients.

## Decision and evidence

- `/coding-agent-gui/` explains sessions, worktrees, and review;
  `/coding-agent-remote-control/` explains execution-machine requirements, with dedicated
  Claude Code and Codex sections. Both reuse six integration cards and native FAQ disclosures.
- Setup remains in the bilingual Agent Config and Mobile Access docs. Claims follow those docs,
  Quick Start, Claude & Codex Capabilities, and the [Pi contract](../../../../specs/builtin-pi.md).
  GLM is a Claude Code provider preset; Harness is distinct from DeepSeek over Claude Code.
  Kimi and Pi are managed runtimes with version-specific capabilities.
- Remote work requires an awake, online execution machine running the CLI. Mobile realtime
  editing remains coming soon. No new encryption or self-hosting guarantees are introduced.
- Official guides checked on 2026-09-30: [Claude Remote Control](https://code.claude.com/docs/en/remote-control),
  [Claude desktop](https://code.claude.com/docs/en/desktop), [OpenAI app](https://developers.openai.com/codex/app/),
  [Codex Cloud](https://developers.openai.com/codex/cloud/), [Kimi web](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/web.html),
  [Kimi remote](https://www.kimi.com/code/docs/en/kimi-code-cli/guides/remote-control.html),
  [Harness](https://github.com/deepseek-ai/deepseek-harness), and its optional
  [Schedule overlay](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md).
  The existing Harness warning references [upstream discussion 4065](https://github.com/deepseek-ai/deepseek-harness/discussions/4065).

## Structure and trade-offs

Thin routes → shared page head and marketing components → existing setup docs.
`collectSitePaths` owns static publication; `site-url.mjs` registers only the two English routes
under the [directory-URL policy](../bug-fix/2026-09-30-public-site-directory-urls.md).
The nav omits language switching on these English-only pages rather than inventing alternates.
Footer and docs links provide native discovery paths. No provider-specific doorway pages,
fabricated screenshots, app-source imports, or new interactive replica are needed.

## Verification and limits

Site typechecking, unit tests, and the production build pass. The PR records final generated-HTML,
metadata, link, and sitemap verification. The existing production-browser suite gains desktop/mobile,
no-JavaScript, theme, FAQ, and history-navigation scenarios. Interactive validation could not run:
Chromium cannot create its local socket, and the cloud browser rejects the loopback preview URL.
Do not treat the added browser scenarios as executed or as agent-runtime tests.

The site-only frozen install needed the existing implicit `tw-animate-css@1.4.0` through an ignored
local symlink during initial validation. CI exposed a pre-existing Codex adapter/root-lockfile
mismatch and CLI formatting issue. Main subsequently fixed both in [#1148](https://github.com/LodyAI/Lody/pull/1148),
so this branch incorporates that upstream repair, including the complete Codex 0.159.2 platform
lock entries. No dependency quarantine change or submodule-pin change is needed. Frozen lockfile
validation covers all 22 workspace projects; root formatting, initialized-submodule docs checks,
and the public repository boundary pass. Exact completed checks and limits belong in the PR summary.
