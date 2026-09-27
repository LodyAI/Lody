import type { AcpCommandSummary } from './ai';
import type { LocalProjectId } from './project';

/** The part of a `ProjectRef` that identifies a command scope. */
export type AcpCommandScopeProject =
  | { kind: 'local'; localProjectId: LocalProjectId }
  | { kind: 'github'; repoFullName: string };

/**
 * Slash commands one project adds to, or hides from, its agent config's base
 * command list.
 *
 * An agent's commands are mostly user-level (built-ins, `~/.claude/skills`)
 * plus a handful the project's own directory contributes. Storing each
 * project's full list in the per-config capability row made every session that
 * started in a different project rewrite the whole 25–40 KB row and sync it to
 * every client. The base stays in the capability row; each project keeps only
 * this delta, so a project's row changes only when its own commands do.
 */
export type AcpCommandScopeDelta = {
  /** Source version of the base entry this delta was computed against. */
  sourceVersion: string;
  /** Commands the project has that the base lacks or describes differently. */
  added: AcpCommandSummary[];
  /** Base command names the project does not offer. */
  removed: string[];
};

/**
 * Identifies the command scope of a session's project. Worktrees of one
 * project share a scope because their command files come from the same
 * checkout. Returns undefined for chat sessions, which use the base list.
 */
export const getAcpCommandScopeKey = (
  project: AcpCommandScopeProject | null | undefined
): string | undefined => {
  if (!project) return undefined;
  if (project.kind === 'local') return `local:${project.localProjectId}`;
  return `github:${project.repoFullName.toLowerCase()}`;
};

/** Delta from `base` to `scoped`, or undefined when the two lists are the same. */
export const computeAcpCommandScopeDelta = (
  base: readonly AcpCommandSummary[],
  scoped: readonly AcpCommandSummary[],
  sourceVersion: string
): AcpCommandScopeDelta | undefined => {
  const baseByName = new Map(base.map((command) => [command.name, command]));
  const scopedNames = new Set(scoped.map((command) => command.name));
  const added = scoped.filter((command) => {
    const inBase = baseByName.get(command.name);
    return !inBase || inBase.description !== command.description;
  });
  const removed = base
    .filter((command) => !scopedNames.has(command.name))
    .map((command) => command.name);
  if (added.length === 0 && removed.length === 0) return undefined;
  return { sourceVersion, added, removed };
};

/**
 * Applies a project delta to the base list. A delta computed against another
 * source version is ignored: the base alone is shown until a session in that
 * project recomputes it.
 */
export const applyAcpCommandScopeDelta = (
  base: readonly AcpCommandSummary[],
  baseSourceVersion: string | undefined,
  delta: AcpCommandScopeDelta | undefined
): AcpCommandSummary[] => {
  if (!delta || delta.sourceVersion !== baseSourceVersion) return [...base];
  const removed = new Set(delta.removed);
  const addedNames = new Set(delta.added.map((command) => command.name));
  return [
    ...base.filter((command) => !removed.has(command.name) && !addedNames.has(command.name)),
    ...delta.added,
  ];
};

export const isAcpCommandScopeDelta = (value: unknown): value is AcpCommandScopeDelta => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const delta = value as Record<string, unknown>;
  return (
    typeof delta.sourceVersion === 'string' &&
    Array.isArray(delta.added) &&
    delta.added.every(
      (command) =>
        !!command &&
        typeof command === 'object' &&
        typeof (command as Record<string, unknown>).name === 'string' &&
        ((command as Record<string, unknown>).description === undefined ||
          typeof (command as Record<string, unknown>).description === 'string')
    ) &&
    Array.isArray(delta.removed) &&
    delta.removed.every((name) => typeof name === 'string')
  );
};
