# Repository Effect skills

`effect-ts` and `effect-v3-to-v4` are installed from
[Effect-TS/skills](https://github.com/Effect-TS/skills/tree/155c50c911f9c99c294ef8a4461981c5bbe6453e)
at commit `155c50c911f9c99c294ef8a4461981c5bbe6453e` (retrieved 2026-10-11).
The upstream MIT license is preserved in [LICENSE.effect-skills](LICENSE.effect-skills).

Local changes: effect-ts is a Lody lifecycle workflow derived from the upstream
reference entrypoint; it replaces upstream installation steps with version-matched
lookup, task-mode selection, progressive reading, contract-based primitive selection
and behavioral acceptance. Review/debug do not initiate migration; implementation
uses the guide's five contract questions and precise runtime execution boundary.
The explicit v3-to-v4 skill retains its upstream body with Lody overrides. On refresh, review
the upstream diff and preserve these adaptations; do not overwrite them blindly.
The [charter decision](../notes/proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#migration-guidance-and-progress)
records the later guidance revision; the recorded source and license stay unchanged.
`.claude/skills/effect-ts` and `.claude/skills/effect-v3-to-v4` link to these canonical
copies. Root `AGENTS.md` supplies the required read even without skill discovery.

Reference the consuming package's installed Effect guide and source, rather than
vendoring another runtime checkout. See the
[installation and reference decision](../notes/implemented/process/2026-10-11-effect-reference-skills.md).
