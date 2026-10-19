# Preserve official DeepSeek endpoints across the Messages upgrade

Status: implemented
Translation: current

[中文](2026-10-10-dsh-official-messages-endpoint.zh.md)

Provider PR: [acp-extension-dsh #29](https://github.com/LodyAI/acp-extension-dsh/pull/29)

## Abstract

Lody's official provider form persisted the Chat API root even after Harness
switched to Messages, so model discovery could succeed while a prompt failed
with HTTP 404. The provider now normalizes known official aliases before native
construction, and the form saves the Messages root. Model discovery stays on the
independent official `/models` endpoint; custom routes and stored credentials are
unchanged. Live ACP turns using both old and new official configuration completed
successfully; an installed desktop release was not rebuilt or replaced.

## Decision

The [Harness upgrade](../feature/2026-10-09-dsh-harness-upgrade.md) left the official
form default and endpoint classifiers behind. Fix ownership stays in the provider:
its shared endpoint vocabulary feeds Lody's form, generated profile, discovery,
and pricing. Profile v19 invalidates the generated-profile/capability identity.

- Accept the exact official HTTPS authority with root, `/v1`, `/anthropic`, or
  `/anthropic/v1` paths and trailing slashes. Other hosts, ports, credentials,
  query strings and fragments are not aliases.
- Resolve settings before environment, as upstream does. Normalize official
  inference aliases to `https://api.deepseek.com/anthropic` before constructing
  the native provider, without changing settings.yaml or the host environment.
  Missing settings must still run endpoint normalization.
- Discover official models at `https://api.deepseek.com/models`; retain the
  existing append-`/models` contract for custom endpoints. Classify both official
  generations for pricing and for the form's official tab.
- Do not silently translate custom Chat gateways. They need a Messages-compatible
  route, or an explicit `llm-pi-ai` Chat provider.

This repairs the implementation under the draft
[settings contract](../../../../specs/deepseek-harness-settings.md).

## Verification

- Provider: build, 57 unit tests, format check, and seven native settings-profile
  smoke cases. Coverage includes configuration precedence, absent settings,
  lookalike/custom origins, discovered selectors, and official usage pricing.
- Host: 48 configuration-dialog tests cover official creation, old/new URL
  hydration and saving, and custom endpoint preservation. Root formatting passes.
- Live test: isolated generated ACP profiles using the locally stored official
  credential, once with the legacy root and once with the Messages root. Both
  discovered two models (`GET /models`, HTTP 200), sent a synthetic prompt through
  `POST /anthropic/v1/messages` (HTTP 200), received the expected answer and
  returned `end_turn`. No user conversation or credential is committed.
- Root `pnpm check` is blocked by missing dependencies/type declarations in this
  nested checkout (first reported package: `@loro-dev/ignore`). This is not a
  passing whole-repository check. UI typecheck is also blocked by missing Electron
  dependencies. Documentation checks retain pre-existing debt.
