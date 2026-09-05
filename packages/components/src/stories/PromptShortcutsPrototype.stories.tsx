import type { ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';

import { PromptShortcutComposerPrototype } from '@/components/prototypes/prompt-shortcuts/prompt-shortcut-composer-prototype';
import { PromptShortcutDesktopShell } from '@/components/prototypes/prompt-shortcuts/prompt-shortcut-desktop-shell';
import { PromptShortcutEditorPrototype } from '@/components/prototypes/prompt-shortcuts/prompt-shortcut-editor-prototype';
import { PromptShortcutsSettingPrototype } from '@/components/prototypes/prompt-shortcuts/prompt-shortcuts-setting-prototype';
import {
  findShortcut,
  createBlankShortcut,
  PROTOTYPE_WORK_CONTEXT,
} from '@/components/prototypes/prompt-shortcuts/prompt-shortcut-fixtures';

/**
 * Prompt Shortcuts — interaction prototype for `docs/prompt-shortcuts.md`.
 *
 * Every story is driven by the same pure model (`prompt-shortcut-model.ts`) and
 * the same closed fixture set, so the pills, the menu filtering and the send
 * gate are computed rather than drawn. Nothing here touches a route, a store,
 * the network, or the workspace Flock document.
 */
const meta = {
  title: 'Prototypes/PromptShortcuts',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;

/* ------------------------------------------------------------------ */
/* 1. Settings                                                         */
/* ------------------------------------------------------------------ */

type SettingsStory = StoryObj<typeof PromptShortcutsSettingPrototype>;

/**
 * Settings → Prompt Shortcuts, all six fixture states in one list: two the
 * author left at the default scope (Workspace), one pinned to
 * Project/Machine/Agent, one pinned to a project this composer is not in, one
 * whose reference was deleted, and one whose prompt references a project its
 * own scope excludes.
 *
 * Every row stays listed. Settings is where a broken Shortcut is repaired, so
 * hiding it here is the one thing the surface must not do.
 */
export const SettingsList: SettingsStory = {
  render: () => (
    <div className="min-h-screen bg-background py-6">
      <PromptShortcutsSettingPrototype />
    </div>
  ),
};

/* ------------------------------------------------------------------ */
/* 2. Editor                                                           */
/* ------------------------------------------------------------------ */

type EditorStory = StoryObj<typeof PromptShortcutEditorPrototype>;

const editorFrame = (node: ReactNode) => (
  <div className="min-h-screen bg-background p-6">
    <div className="mx-auto w-[720px] overflow-hidden rounded-xl border border-border/60 bg-card/30">
      {node}
    </div>
  </div>
);

/**
 * Editing a Shortcut that uses all four first-phase mention kinds.
 *
 * "Applies to" is set by the author and defaults to None on every axis. It also
 * decides what `@` / `$` / `#` offer, because Settings has no current project or
 * machine of its own to complete against (§3.3) — set Machine to MacBook Pro and
 * this project's files stop being offered.
 */
export const EditorWithMentionsAndVariables: EditorStory = {
  render: () =>
    editorFrame(<PromptShortcutEditorPrototype initialShortcut={findShortcut('review-pr')} />),
};

/** §2.1 — a new Shortcut starts at None on every axis: one `Workspace` pill. */
export const EditorNewWorkspaceOnly: EditorStory = {
  render: () =>
    editorFrame(<PromptShortcutEditorPrototype initialShortcut={createBlankShortcut()} />),
};

/**
 * The trade an author-set scope makes: this one says loro-dev/lody while the
 * prompt references a file in loro-dev/loro. The editor names that reference and
 * blocks Save — widen the scope or drop the reference.
 */
export const EditorReferenceOutOfScope: EditorStory = {
  render: () =>
    editorFrame(
      <PromptShortcutEditorPrototype initialShortcut={findShortcut('cross-repo-audit')} />
    ),
};

/** A reference that no longer resolves: still saved, still editable, clearly marked. */
export const EditorBrokenReference: EditorStory = {
  render: () =>
    editorFrame(
      <PromptShortcutEditorPrototype initialShortcut={findShortcut('legacy-migration')} />
    ),
};

/* ------------------------------------------------------------------ */
/* 3–5. Composer                                                       */
/* ------------------------------------------------------------------ */

type ComposerStory = StoryObj<typeof PromptShortcutComposerPrototype>;

const composerFrame = (node: ReactNode) => (
  <div className="flex min-h-screen items-end bg-background p-8">
    <div className="mx-auto w-[640px]">{node}</div>
  </div>
);

/**
 * §6.1 — the `/` menu with both sources grouped and labelled. `/review-pr`
 * appears twice on purpose: once as a Shortcut and once as an ACP command, and
 * the group label is what tells them apart (§6.2).
 *
 * Only Shortcuts that can run in this context are listed; `/rust-bench`,
 * `/legacy-migration` and `/cross-repo-audit` are absent by design.
 */
export const ComposerSlashMenu: ComposerStory = {
  render: () => composerFrame(<PromptShortcutComposerPrototype initialQuery="" />),
};

/**
 * §2.3 — typing a full name that is unavailable here shows an unselectable
 * diagnostic line with the reason, so the Shortcut does not look deleted.
 */
export const ComposerUnavailableDiagnostic: ComposerStory = {
  render: () => composerFrame(<PromptShortcutComposerPrototype initialQuery="rust-bench" />),
};

/**
 * §5.3 — a Shortcut with variables just selected: compact `/slug` chip, `!2`
 * badge, parameter tray open under the input, send disabled with the missing
 * names spelled out.
 */
export const ComposerMissingVariables: ComposerStory = {
  render: () =>
    composerFrame(<PromptShortcutComposerPrototype initialSlug="triage-issue" initialTrayOpen />),
};

/** The same invocation once the required values are filled: no badge, send enabled. */
export const ComposerFilledVariables: ComposerStory = {
  render: () =>
    composerFrame(
      <PromptShortcutComposerPrototype
        initialSlug="triage-issue"
        initialTrayOpen
        initialValues={{
          issue_url: 'https://github.com/loro-dev/lody/issues/3612',
          severity: 'high',
          reporter_notes: 'Only reproduces after the machine reconnects.',
        }}
      />
    ),
};

/**
 * The tray closed: values are kept, and the chip keeps carrying the missing
 * count so closing the surface never hides the blocker.
 */
export const ComposerChipOnlyWithBadge: ComposerStory = {
  render: () => composerFrame(<PromptShortcutComposerPrototype initialSlug="review-pr" />),
};

/**
 * §6.3 — "Expand and edit". Filled values are written into the text, mentions
 * keep their chips, and an unfilled required `!{focus}` still blocks the send.
 * After this the draft is plain text: it no longer follows the Shortcut.
 */
export const ComposerExpandedAndEditable: ComposerStory = {
  render: () =>
    composerFrame(
      <PromptShortcutComposerPrototype
        initialSlug="review-pr"
        initialValues={{ pr_url: 'https://github.com/loro-dev/lody/pull/3541' }}
        initialExpanded
      />
    ),
};

/* ------------------------------------------------------------------ */
/* 6. Desktop + mobile                                                 */
/* ------------------------------------------------------------------ */

/**
 * The full desktop frame at 1440×900: the Settings catalog and the composer
 * that calls it, side by side. Switching the machine in the composer header
 * re-checks every Shortcut through the same resolver the list uses.
 */
export const Desktop1440: StoryObj<typeof PromptShortcutDesktopShell> = {
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div className="h-[900px] w-[1440px] overflow-hidden">
      <PromptShortcutDesktopShell />
    </div>
  ),
};

/**
 * §5.3 — touch has no hover, so the chip and the `!` badge open a bottom sheet
 * and the missing count is announced as text rather than in a tooltip.
 *
 * The sheet is the real `ui/sheet` primitive, which anchors to the VIEWPORT.
 * View this story in a phone-sized window (390×844); a wrapper cannot constrain
 * a `fixed` bottom sheet, and faking one with an absolutely positioned panel
 * would be showing a component we would never ship.
 */
export const MobileVariableSheet: ComposerStory = {
  render: () => (
    <div className="mx-auto flex min-h-screen w-full max-w-[390px] flex-col justify-end bg-background p-3">
      <PromptShortcutComposerPrototype
        surface="mobile"
        initialSlug="triage-issue"
        initialTrayOpen
        context={PROTOTYPE_WORK_CONTEXT}
      />
    </div>
  ),
};
