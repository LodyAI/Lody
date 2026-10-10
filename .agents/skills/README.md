# Repository Effect skills

`effect-ts` and `effect-v3-to-v4` are installed from
[Effect-TS/skills](https://github.com/Effect-TS/skills/tree/155c50c911f9c99c294ef8a4461981c5bbe6453e)
at commit `155c50c911f9c99c294ef8a4461981c5bbe6453e` (retrieved 2026-10-11).
The upstream MIT license is preserved in [LICENSE.effect-skills](LICENSE.effect-skills).

Local changes: broaden the Effect skill trigger to code/review/debugging, and
prepend Lody overrides to both skills. Upstream bodies are retained. On refresh,
review the upstream diff and reapply the overrides; do not overwrite them blindly.
`.claude/skills/effect-ts` and `.claude/skills/effect-v3-to-v4` link to these canonical
copies. Root `AGENTS.md` supplies the required read even without skill discovery.

Reference the consuming package's installed Effect guide and source, rather than
vendoring another runtime checkout. See the
[installation and reference decision](../notes/implemented/process/2026-10-11-effect-reference-skills.md).
