import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const PRIMARY_REVIEW_DIFF_PATH = 'src/generated/primary-snapshot.ts';
export const SECONDARY_REVIEW_DIFF_PATH = 'src/generated/secondary-snapshot.ts';

const PRIMARY_LINE_COUNT = 2_400;
const SECONDARY_LINE_COUNT = 1_200;

export type SyntheticReviewRepository = {
  rootPath: string;
  changedPaths: readonly string[];
  expectedLineChanges: Readonly<Record<string, { additions: number; deletions: number }>>;
  cleanup: () => void;
};

function renderGeneratedModule(prefix: string, lineCount: number, revision: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) =>
      `export const ${prefix}_${String(index).padStart(4, '0')} = ${index + revision};\n`
  ).join('');
}

function writeRepositoryFile(rootPath: string, relativePath: string, content: string): void {
  const targetPath = join(rootPath, relativePath);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, 'utf8');
}

function git(rootPath: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: rootPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Creates a real, fully local Git repository whose working tree has two large
 * deterministic text diffs. The fixture owns its temporary directory.
 */
export function createSyntheticReviewRepository(): SyntheticReviewRepository {
  const rootPath = mkdtempSync(join(tmpdir(), 'lody-review-e2e-'));
  let retained = false;

  try {
    git(rootPath, ['init', '--initial-branch=main']);
    git(rootPath, ['config', 'user.name', 'Lody E2E']);
    git(rootPath, ['config', 'user.email', 'e2e@invalid.example']);
    git(rootPath, ['config', 'commit.gpgsign', 'false']);

    writeRepositoryFile(
      rootPath,
      PRIMARY_REVIEW_DIFF_PATH,
      renderGeneratedModule('primary_value', PRIMARY_LINE_COUNT, 0)
    );
    writeRepositoryFile(
      rootPath,
      SECONDARY_REVIEW_DIFF_PATH,
      renderGeneratedModule('secondary_value', SECONDARY_LINE_COUNT, 0)
    );
    writeRepositoryFile(
      rootPath,
      'README.md',
      '# Synthetic Review Fixture\n\nThis repository contains generated test data only.\n'
    );
    git(rootPath, ['add', '--all']);
    git(rootPath, ['commit', '--quiet', '-m', 'test: establish synthetic review baseline']);

    writeRepositoryFile(
      rootPath,
      PRIMARY_REVIEW_DIFF_PATH,
      renderGeneratedModule('primary_value', PRIMARY_LINE_COUNT, 10_000)
    );
    writeRepositoryFile(
      rootPath,
      SECONDARY_REVIEW_DIFF_PATH,
      renderGeneratedModule('secondary_value', SECONDARY_LINE_COUNT, 20_000)
    );
    writeRepositoryFile(
      rootPath,
      'README.md',
      '# Synthetic Review Fixture\n\nThis working tree is intentionally changed.\n'
    );

    retained = true;
    return {
      rootPath,
      changedPaths: ['README.md', PRIMARY_REVIEW_DIFF_PATH, SECONDARY_REVIEW_DIFF_PATH],
      expectedLineChanges: {
        [PRIMARY_REVIEW_DIFF_PATH]: {
          additions: PRIMARY_LINE_COUNT,
          deletions: PRIMARY_LINE_COUNT,
        },
        [SECONDARY_REVIEW_DIFF_PATH]: {
          additions: SECONDARY_LINE_COUNT,
          deletions: SECONDARY_LINE_COUNT,
        },
      },
      cleanup: () => rmSync(rootPath, { recursive: true, force: true }),
    };
  } finally {
    if (!retained) rmSync(rootPath, { recursive: true, force: true });
  }
}
