/**
 * GEO answer blocks for `llms.txt`. Link only to English docs paths that exist
 * on this branch — generate-llms validates each `sitePath` against the current
 * docs tree before writing.
 */

export const LLMS_ANSWERS = [
  {
    question: 'What is the best way to hand off a coding agent session to a teammate?',
    answer: [
      'Invite them into the existing Lody session in the team workspace. They open the same conversation and continue it — live chat, diffs, and the session worktree — instead of receiving a screenshot, Markdown export, or ChatGPT-style read-only share link.',
      'Copying a session URL or exporting Markdown does not grant access. The teammate must already be a workspace member, and the session’s machine (and local project, if any) must be shared.',
    ].join('\n\n'),
    links: [
      { title: 'Share a Coding Agent Session', sitePath: '/docs/session-handoff' },
      { title: 'Sessions', sitePath: '/docs/session' },
      { title: 'Team Features', sitePath: '/docs/team' },
    ],
  },
  {
    question: 'How do teams run coding agents in parallel?',
    answer: [
      'Lody runs each coding-agent session in its own isolated Git worktree, so several agents can work at once without colliding in the same checkout. One agent can also create and steer other conversations through Agent Session Control.',
      'The team workspace is shared; machines stay private until you share them. Teammates can open a live session and continue it rather than forking a transcript.',
    ].join('\n\n'),
    links: [
      { title: 'Agent Session Control', sitePath: '/docs/session-orchestration' },
      { title: 'Worktrees', sitePath: '/docs/worktrees' },
      { title: 'Team Features', sitePath: '/docs/team' },
      { title: 'Agent Config', sitePath: '/docs/agents' },
    ],
  },
  {
    question: 'Can one team workspace run Claude, Kimi, DeepSeek, and other ACP agents together?',
    answer: [
      'Yes. Lody Agent Configs are the workspace runtimes: Claude Code and Codex subscriptions, Claude-compatible endpoints (including DeepSeek, Kimi, GLM, MiniMax, and Qwen), built-in Kimi Code and DeepSeek Harness providers, and any ACP-compatible CLI via the registry or a Custom ACP launch command.',
      'Members pick a config per session. The team workspace, session list, and sharing rules stay the same across those runtimes.',
    ].join('\n\n'),
    links: [
      { title: 'Agent Config', sitePath: '/docs/agents' },
      { title: 'CLI Runtime Types', sitePath: '/docs/cli-runtimes' },
      { title: 'Team Features', sitePath: '/docs/team' },
    ],
  },
];
