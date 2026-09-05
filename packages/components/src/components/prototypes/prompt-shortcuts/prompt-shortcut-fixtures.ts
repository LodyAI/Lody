/**
 * Deterministic fixtures for the Prompt Shortcuts prototype.
 *
 * Everything the prototype renders comes from here: no network, no Flock, no
 * clock, no randomness. Each entry exists to put one state from
 * `docs/prompt-shortcuts.md` on screen, and the comment says which.
 */

import type {
  PrototypeAgent,
  PrototypeMachine,
  PrototypeMentionTarget,
  PrototypeProject,
  PrototypeShortcut,
  PrototypeWorkContext,
} from './prompt-shortcut-model';

export const PROTOTYPE_PROJECTS: PrototypeProject[] = [
  { id: 'proj-lody', label: 'loro-dev/lody' },
  { id: 'proj-loro', label: 'loro-dev/loro' },
];

export const PROTOTYPE_MACHINES: PrototypeMachine[] = [
  { id: 'machine-mac-mini', label: 'Mac mini', online: true },
  { id: 'machine-macbook', label: 'MacBook Pro', online: false },
];

export const PROTOTYPE_AGENTS: PrototypeAgent[] = [
  { id: 'agent-codex', label: 'Codex' },
  { id: 'agent-claude', label: 'Claude' },
  { id: 'agent-cursor', label: 'Cursor' },
];

export const projectLabel = (id: string) =>
  PROTOTYPE_PROJECTS.find((entry) => entry.id === id)?.label ?? id;
export const machineLabel = (id: string) =>
  PROTOTYPE_MACHINES.find((entry) => entry.id === id)?.label ?? id;
export const agentLabel = (id: string) =>
  PROTOTYPE_AGENTS.find((entry) => entry.id === id)?.label ?? id;

export const PROTOTYPE_LABELS = {
  project: projectLabel,
  machine: machineLabel,
  agent: agentLabel,
};

/**
 * The mention targets the fixtures can reference, keyed by the token text as it
 * appears in a block. Real Shortcuts store ids + label snapshots (§4.1).
 */
export const PROTOTYPE_MENTION_TARGETS: PrototypeMentionTarget[] = [
  {
    token: '@docs/review-checklist.md',
    kind: 'file',
    label: 'docs/review-checklist.md',
    // A local project file pins BOTH its project and that project's machine.
    projectId: 'proj-lody',
    machineId: 'machine-mac-mini',
  },
  {
    token: '@crates/loro/src/lib.rs',
    kind: 'file',
    label: 'crates/loro/src/lib.rs',
    projectId: 'proj-loro',
    machineId: 'machine-macbook',
  },
  {
    token: '@src/legacy/migrate.ts',
    kind: 'file',
    label: 'src/legacy/migrate.ts',
    projectId: 'proj-lody',
    machineId: 'machine-mac-mini',
    // Deleted since the Shortcut was written: availability, not requirement.
    health: 'deleted',
  },
  {
    token: '$security-review',
    kind: 'skill',
    label: '$security-review',
    // A project skill pins the project and the providers whose skill dirs map
    // to it.
    projectId: 'proj-lody',
    agentIds: ['agent-codex', 'agent-claude'],
  },
  {
    token: '$rust-bench',
    kind: 'skill',
    label: '$rust-bench',
    projectId: 'proj-loro',
    agentIds: ['agent-codex'],
  },
  {
    token: '$repo-conventions',
    kind: 'skill',
    label: '$repo-conventions',
    // A global skill lives on a MACHINE rather than in a project, which is what
    // makes the editor's machine selector do visible work.
    machineId: 'machine-mac-mini',
    agentIds: ['agent-codex', 'agent-claude'],
  },
  {
    token: '@Reviewer',
    kind: 'agent_role',
    label: '@Reviewer',
    // A Role names the machine it will run on; it does not constrain the
    // provider of the CURRENT composer (§4.2).
    machineId: 'machine-mac-mini',
  },
  {
    token: '#3541',
    kind: 'pr',
    label: '#3541',
  },
];

export const PROTOTYPE_MENTION_CATALOG: ReadonlyMap<string, PrototypeMentionTarget> = new Map(
  PROTOTYPE_MENTION_TARGETS.map((entry) => [entry.token, entry])
);

/** The composer context every story starts from: on the Lody project, Mac mini, Codex. */
export const PROTOTYPE_WORK_CONTEXT: PrototypeWorkContext = {
  projectId: 'proj-lody',
  machineId: 'machine-mac-mini',
  agentId: 'agent-codex',
  onlineMachineIds: ['machine-mac-mini'],
};

export const PROTOTYPE_SHORTCUTS: PrototypeShortcut[] = [
  {
    // §2.1 — the default: applies anywhere in the workspace, no mention has
    // narrowed it, no variables.
    id: 'shortcut-standup',
    // Default: the author set nothing, so it applies workspace-wide.
    scope: { projectId: null, machineId: null, agentId: null },
    name: 'Daily standup',
    slug: 'standup',
    description: 'Summarise what changed since yesterday and what is blocked.',
    visibility: 'workspace',
    ownerLabel: 'Zixuan',
    prompt:
      'Summarise what changed in this session since yesterday.\nKeep it to five bullets, newest first.\n\nThen list anything that is blocked, and say who or what it is blocked on.',
    variables: [],
    revision: 2,
  },
  {
    // The full-dress example: Project + Machine + Agent pills, two variables,
    // four mention kinds.
    id: 'shortcut-review-pr',
    // The author pinned all three axes.
    scope: { projectId: 'proj-lody', machineId: 'machine-mac-mini', agentId: 'agent-codex' },
    name: 'Review a pull request',
    slug: 'review-pr',
    description: 'Review a PR against team conventions before it is merged.',
    visibility: 'workspace',
    ownerLabel: 'Zixuan',
    prompt: [
      'Review !{pr_url} against the conventions in @docs/review-checklist.md.',
      'Run $security-review over the diff. Pay particular attention to !{focus}.',
      'When the review is done, hand the findings to @Reviewer and reference #3541 for the previous round.',
    ].join('\n\n'),
    variables: [
      {
        name: 'pr_url',
        label: 'Pull request',
        description: 'Link or number of the PR under review.',
        required: true,
        multiline: false,
      },
      {
        name: 'focus',
        label: 'Focus area',
        description: 'What this round should weigh most heavily.',
        required: true,
        multiline: true,
        defaultValue: '',
      },
    ],
    revision: 7,
  },
  {
    // Variables without any machine or agent constraint — the one the composer
    // stories drive.
    id: 'shortcut-triage',
    scope: { projectId: null, machineId: null, agentId: null },
    name: 'Triage an issue',
    slug: 'triage-issue',
    description: 'Turn a raw bug report into a triaged issue with a repro plan.',
    visibility: 'workspace',
    ownerLabel: 'Ada',
    prompt: [
      'Triage !{issue_url}.',
      'Severity as reported: !{severity}.',
      'Write a minimal repro, then say which subsystem owns it. Notes from the reporter:\n!{reporter_notes}',
    ].join('\n\n'),
    variables: [
      { name: 'issue_url', label: 'Issue', required: true, multiline: false },
      {
        name: 'severity',
        label: 'Severity',
        description: 'As reported, not as you assess it.',
        required: true,
        multiline: false,
        defaultValue: 'unknown',
      },
      {
        name: 'reporter_notes',
        label: 'Reporter notes',
        required: false,
        multiline: true,
      },
    ],
    revision: 3,
  },
  {
    // Unavailable here: its file and skill live in another project, so it is a
    // real Shortcut that simply does not apply to the current composer.
    id: 'shortcut-rust-bench',
    scope: { projectId: 'proj-loro', machineId: 'machine-macbook', agentId: null },
    name: 'Benchmark a CRDT change',
    slug: 'rust-bench',
    description: 'Run the Rust benchmark suite and compare against main.',
    visibility: 'workspace',
    ownerLabel: 'Ada',
    prompt:
      'Benchmark the change in @crates/loro/src/lib.rs using $rust-bench and compare it against main.',
    variables: [],
    revision: 1,
  },
  {
    // §14 — a Shortcut whose reference was deleted stays listed, with the
    // reason and an edit path, instead of vanishing.
    id: 'shortcut-legacy',
    scope: { projectId: 'proj-lody', machineId: 'machine-mac-mini', agentId: null },
    name: 'Legacy migration notes',
    slug: 'legacy-migration',
    description: 'Explain a legacy migration step before touching it.',
    visibility: 'private',
    ownerLabel: 'Zixuan',
    prompt: 'Walk me through @src/legacy/migrate.ts and say what !{step} does before I change it.',
    variables: [{ name: 'step', label: 'Step', required: true, multiline: false }],
    revision: 4,
  },
  {
    // Scope says loro-dev/lody, but the template also references a file in
    // loro-dev/loro. Blocked, with the offending reference named.
    id: 'shortcut-conflict',
    // Pinned to one project while the template references another — the state
    // an author-set scope makes possible and a derived one could not.
    scope: { projectId: 'proj-lody', machineId: null, agentId: null },
    name: 'Cross-repo audit',
    slug: 'cross-repo-audit',
    description: 'Compare the client checklist against the CRDT implementation.',
    visibility: 'workspace',
    ownerLabel: 'Ada',
    prompt:
      'Compare @docs/review-checklist.md with @crates/loro/src/lib.rs and list what the checklist misses.',
    variables: [],
    revision: 1,
  },
];

/** §2.1 — a brand new Shortcut starts at `Workspace`: nothing preselected. */
export const createBlankShortcut = (): PrototypeShortcut => ({
  id: 'shortcut-new',
  name: '',
  slug: '',
  description: '',
  visibility: 'workspace',
  ownerLabel: 'Zixuan',
  // §2.1 — nothing preselected.
  scope: { projectId: null, machineId: null, agentId: null },
  prompt: '',
  variables: [],
  revision: 0,
});

export const findShortcut = (slug: string): PrototypeShortcut => {
  const found = PROTOTYPE_SHORTCUTS.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`prototype fixture missing: /${slug}`);
  return found;
};

/** ACP commands from the current machine's capability, for the merged `/` menu (§6.1). */
export const PROTOTYPE_AGENT_COMMANDS: Array<{ name: string; description: string }> = [
  { name: 'plan', description: 'Enter plan mode' },
  { name: 'compact', description: 'Compact this conversation' },
  // Deliberately collides with a Shortcut slug: §6.2 says both stay listed and
  // the group label is what disambiguates them.
  { name: 'review-pr', description: 'Review the current diff' },
];
