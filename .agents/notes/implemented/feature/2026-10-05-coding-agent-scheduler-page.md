# Coding-agent scheduler workflow page

Status: implemented
Translation: current

[中文](2026-10-05-coding-agent-scheduler-page.zh.md)

## Abstract

Readers looking for recurring coding-agent work need to distinguish scheduling from runtime
availability and from vendor-native automation. The English scheduler landing and bilingual
operating guide now explain Lody's shared schedule workflow, six integration routes, machine-clock
semantics, proposal confirmation, and a known configuration-validation failure. The page extends
the existing GUI/remote guide shell without inventing a scheduler screenshot or claiming all-agent
execution certification. Runtime behavior and release packaging are unchanged.

## Decision and evidence

- `/coding-agent-scheduler/` owns the use-case overview and vendor comparison;
  `/docs/scheduled-tasks/` owns the operating instructions and troubleshooting. Follow the
  [GUI/remote page decision](2026-09-30-coding-agent-workflow-pages.md) for the shared shell,
  native FAQ disclosures, English-only route, and absence of fabricated alternate URLs.
- Codex, Claude Code, Kimi Code, GLM over Claude Code, DeepSeek Harness, and Pi are integration
  routes, not a uniform capability matrix. GLM remains a provider configuration over Claude Code.
  Harness remains distinct from DeepSeek over Claude Code. Actual model execution is not tested by
  a site build; users should test the chosen configuration before relying on unattended work.
- Source audit at `cd3f5b3ca969be5fa2e327744d449ffd802efe7b`: `apps/cli/src/lib/schedules/schedule-workspace.ts`
  wakes the scheduler on startup and on its interval, not by waking the OS. The shared schedule
  time logic selects one latest due slot, and editor/proposal defaults select `run_once`.
  Current UI uses reported machine time zone with a viewer-zone fallback for older metadata.
  Once stores an instant; calendar rules store their zone. Advanced stored cron/skip policies
  are not silently equated with editor defaults.
- [#1197](https://github.com/LodyAI/Lody/pull/1197) explains machine-clock input and DST changes;
  [#1159](https://github.com/LodyAI/Lody/pull/1159) removed the extra schedule permission gate,
  without removing ordinary Session/provider validation.
- The proposal card requires Create to commit the task. MCP schedule tools also expose pause:
  correcting the old “cannot change a task” sentence preserves this distinction.
- [#1247](https://github.com/LodyAI/Lody/issues/1247#issuecomment-5986803074) reports a saved
  `fast: "false"` rejected by Session creation and mislabeled `DISPATCH_UNAVAILABLE`. The docs
  describe the symptom and diagnostic boundary; this change does not patch the runtime or claim
  an unverified workaround, installed fix, or successful end-to-end run.

## Current official alternatives

Sources checked October 5, 2026:

- [Claude scheduling](https://code.claude.com/docs/en/scheduled-tasks) distinguishes session
  `/loop`, Desktop tasks, and cloud routines. Avoid the outdated claim that every Claude schedule
  disappears on session exit.
- [Codex automations](https://developers.openai.com/codex/app/automations/) currently redirects to
  [OpenAI Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app), covering local
  project and web workflows. The copy names the search intent without describing the old page as
  the current exclusive product surface.
- [Harness Schedule](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md)
  documents a separate Host subsystem. Upstream support does not establish exposure in Lody.

## Structure and verification

Thin route → page head and scheduler component → existing shared shell and setup docs.
The route joins path enumeration, canonical-directory handling, generated llms discovery, guide
navigation, and the footer. No runtime dependency, screenshot asset, global SEO policy, or later
agent-specific landing page is introduced. The existing path tests cover the new route and fragment;
production-browser scenarios cover it alongside GUI and remote pages, including native FAQ toggles,
mobile overflow, theme changes, no-JavaScript rendering, and Back/Forward navigation.

Final executed checks and any environment limits are recorded in the PR. Build and static-site
checks are not real-provider scheduling, installed-version verification, or deployment evidence.
