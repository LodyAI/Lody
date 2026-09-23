import {
  normalizeMarkdownAgentFilePath,
  parseMarkdownAgentFileHref,
} from './markdown-agent-file-link';

/**
 * How much a requested path may be rewritten before it is sent to the machine.
 *
 * `canonical` — the caller already holds the workspace-relative path the
 * machine indexed (file tree, quick open, mobile file browser, an LSP result).
 * `markdown-href` — an href an agent wrote in chat, which may carry a line
 * suffix, percent-encoding, or an absolute host path that needs stripping.
 */
export type SessionFileOpenPathKind = 'canonical' | 'markdown-href';

export type SessionFileOpenTargetInput = {
  readonly rawPath: string;
  readonly pathKind: SessionFileOpenPathKind;
  readonly workspacePath?: string | null;
  /** Same-machine Electron opens must not reroot another worktree into this one. */
  readonly preserveWorktreePath?: boolean;
  /** An anchor the caller already has, rather than one encoded in the path. */
  readonly startLine?: number;
  readonly endLine?: number;
};

export type SessionFileOpenTarget = {
  readonly filePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
  /** True when the path was parsed as an agent-written link, for analytics. */
  readonly fromMarkdownLink: boolean;
  readonly lineSuffixFormat?: 'github' | 'colon' | 'vscode';
};

/**
 * Decide the exact path to ask the machine for.
 *
 * The provenance split is the whole point. `normalizeMarkdownAgentFilePath` is
 * built for hrefs an agent typed, so it URL-decodes, strips a trailing
 * `:<line>` / `#L<line>`, and removes a `.../worktrees/<uuid>/` prefix. Applied
 * to a path that came out of the file index — where every one of those
 * sequences can be a real part of a real filename — it silently asks the
 * machine for a file that does not exist:
 *
 *   `docs/report%20v2.md`            → `docs/report v2.md`   (decoded)
 *   `logs/2024:30.txt`               → `logs/2024`           (read as a line)
 *   `fixtures/worktrees/<uuid>/a.txt` → `a.txt`              (read as a host root)
 *
 * So a `canonical` path is passed through untouched, and only a `markdown-href`
 * gets the parsing it was written for.
 */
export function resolveSessionFileOpenTarget(
  input: SessionFileOpenTargetInput
): SessionFileOpenTarget {
  if (input.pathKind === 'canonical') {
    return {
      filePath: input.rawPath,
      ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
      ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
      fromMarkdownLink: false,
    };
  }

  const normalizedPath = normalizeMarkdownAgentFilePath(
    input.rawPath,
    input.workspacePath,
    input.preserveWorktreePath
  );
  const parsedTarget = parseMarkdownAgentFileHref(normalizedPath);
  const startLine = input.startLine ?? parsedTarget?.startLine;
  const endLine = input.endLine ?? parsedTarget?.endLine;
  return {
    filePath: parsedTarget?.filePath ?? normalizedPath,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
    fromMarkdownLink: parsedTarget != null,
    ...(parsedTarget?.lineSuffixFormat === undefined
      ? {}
      : { lineSuffixFormat: parsedTarget.lineSuffixFormat }),
  };
}
