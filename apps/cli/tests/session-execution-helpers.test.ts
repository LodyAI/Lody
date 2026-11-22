import { describe, expect, it } from 'vitest';
import { SessionProjectRunSchema, type LocalProjectId } from '@lody/shared';

import { buildPrompt } from '../src/session/session-execution-helpers';
import { TURN_BUDGETS } from '../src/session/turn-budgets';

describe('session execution prompt helpers', () => {
  it('requires command-specific help before executing Lody commands', () => {
    const prompt = buildPrompt('inspect the UI');

    expect(prompt).toBe(
      'inspect the UI\n\nUse the available Lody MCP tools when relevant. Before executing a Lody command, you MUST call lody_help({command: TOOL_NAME}) and read its successful command-specific response. The index and short summaries do not replace full help. Read help before issuing the command, never in parallel with it. Reuse full help already in the current context; after compaction or loss, fetch it again. lody_help itself is exempt.'
    );
  });

  describe('approved PR-link sentence', () => {
    const tail = 'lody_help itself is exempt.';
    const build = (options: { gitRepository?: boolean; managedGhShim?: boolean }) =>
      buildPrompt('fix it', undefined, undefined, undefined, options);

    it('excludes gh pr create, which already links, when the managed gh shim is on PATH', () => {
      expect(
        build({ gitRepository: true, managedGhShim: true }).endsWith(
          `${tail} A pull or merge request this Session opened without gh pr create is linked to it with lody_session_manage action pr_link.`
        )
      ).toBe(true);
    });

    it('covers every pull or merge request when the Session has no gh shim', () => {
      expect(
        build({ gitRepository: true, managedGhShim: false }).endsWith(
          `${tail} A pull or merge request this Session opens is linked to it with lody_session_manage action pr_link.`
        )
      ).toBe(true);
    });

    it('adds no sentence when the working directory is not a git repository', () => {
      for (const managedGhShim of [true, false])
        expect(build({ gitRepository: false, managedGhShim })).not.toContain('pr_link');
      expect(buildPrompt('fix it')).not.toContain('pr_link');
    });
  });

  it('injects the frozen project group instructions and ordered member directories', () => {
    const projectRun = SessionProjectRunSchema.parse({
      id: 'd835a1ee-4f85-4e15-9dca-2bca912e36bf',
      name: 'Shop',
      root: 'project-shop-d835a1ee-4f85-4e15-9dca-2bca912e36bf',
      instructions: 'Keep the API compatible.',
      members: {
        api: {
          o: 1,
          src: { kind: 'github', repoFullName: 'example/api' },
          placement: { kind: 'submodule', parent: 'web', path: 'deps/api' },
          path: 'web/deps/api',
          base: 'abc123',
        },
        web: {
          o: 0,
          src: { kind: 'github', repoFullName: 'example/web' },
          placement: { kind: 'root', dir: 'web' },
          path: 'web',
          base: 'main',
        },
      },
    });
    const prompt = buildPrompt('Fix checkout', undefined, undefined, undefined, { projectRun });
    expect(prompt).toContain('Project group: "Shop"');
    expect(prompt).toContain(
      '"web/deps/api" (example/api), access worktree; base "abc123"; submodule of "web"'
    );
    expect(prompt.indexOf('- "web":')).toBeLessThan(prompt.indexOf('- "api":'));
    expect(prompt).toContain('Project group instructions:\nKeep the API compatible.');
    expect(prompt).toContain('Fix checkout');
    const web = Object.values(projectRun.members).find((member) => member.path === 'web')!;
    web.src = { kind: 'github', repoFullName: 'example/web', preferLocal: true };
    web.repositoryCheckout = {
      kind: 'local',
      machineId: 'm' as never,
      localProjectId: 'web' as never,
    };
    const repositoryPrompt = buildPrompt('Edit repo', undefined, undefined, undefined, {
      projectRun,
    });
    expect(repositoryPrompt).toContain('example/web, local copy, native Git/GitHub credentials');
    web.src = { kind: 'local', machineId: 'm' as never, localProjectId: 'docs' as never };
    web.access = 'additional';
    const directoryPrompt = buildPrompt('Edit notes', undefined, undefined, undefined, {
      projectRun,
      projectFileRoots: [{ id: 'member:web', absolutePath: '/registered/notes' }],
    });
    expect(directoryPrompt).toContain('"/registered/notes" (non-Git directory, not isolated)');
    expect(directoryPrompt).not.toContain('base "main"');
  });

  it('keeps GitHub guidance without opting into first-task branch naming', () => {
    const prompt = buildPrompt('fix the bug', {
      kind: 'github',
      repoFullName: 'owner/repo',
      branch: 'feature',
    });

    expect(prompt).toContain("use GitHub's branch rename flow");
    expect(prompt).toContain('Use the available Lody MCP tools when relevant');
    expect(prompt).not.toContain('Before starting this task, rename the branch');
  });

  it('combines first-task instructions with task references and feedback context for local worktrees', () => {
    const prompt = buildPrompt(
      'Fix the checkout observer',
      { kind: 'local', localProjectId: 'local-1' as LocalProjectId, useWorktree: true },
      [
        {
          type: 'issue',
          number: 42,
          title: ' Checkout observer ',
          url: 'https://github.com/owner/repo/issues/42',
        },
      ],
      ' feedback-1 ',
      { branchToRename: 'lody/12345678-abc-2' }
    );

    expect(prompt).toContain(
      'Fix the checkout observer\n\n\n- issue#42: Checkout observer (https://github.com/owner/repo/issues/42)\n'
    );
    expect(prompt).toContain('The feedback postId is feedback-1.');
    expect(prompt).toContain('git branch -m lody/12345678-abc-2 <name>');
    expect(prompt).not.toContain('inspect');
    expect(prompt).toContain(
      'Do not use main, master, or dev, include sensitive input, or force-overwrite an existing branch.'
    );
    expect(prompt).toContain('if renaming fails, report it briefly and continue the task.');
    expect(prompt).not.toContain('gh pr create');
  });
});

describe('turn release budgets', () => {
  it('ends a Git observation before the shared workspace-statistics budget', () => {
    expect(TURN_BUDGETS.gitObservationMs).toBeLessThan(TURN_BUDGETS.workspaceStatsMs);
  });

  it('writes shutdown release receipts inside the CLI shutdown budget', () => {
    expect(
      TURN_BUDGETS.shutdownReleaseWaitMs + TURN_BUDGETS.shutdownForcedWriteMs
    ).toBeLessThanOrEqual(TURN_BUDGETS.cliShutdownMs);
  });
});
