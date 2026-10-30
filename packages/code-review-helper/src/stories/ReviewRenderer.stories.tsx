import type { Meta, StoryObj } from '@storybook/react';

import { ReviewRenderer } from '../react';
import type { ReviewUserComment } from '../types';
import pr124GzUrl from './fixtures/pr-124-v2-format.review.json.gz?url';
import budgetDiagnosticsReview from './fixtures/budget-diagnostics.review.md?raw';
import fileStatusesReview from './fixtures/file-statuses.review.md?raw';
import groupedRefactorReview from './fixtures/grouped-refactor.review.md?raw';
import longGroupDescriptionReview from './fixtures/long-group-description.review.md?raw';
import { createReviewFixtureBundle, source } from './review-fixture-bundle';

const meta = {
  title: 'Code Review Helper/ReviewRenderer',
  component: ReviewRenderer,
  parameters: {
    layout: 'fullscreen',
    controls: {
      disable: true,
    },
  },
} satisfies Meta<typeof ReviewRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

const groupedRefactorBundle = createReviewFixtureBundle({
  reviewFilePath: '/storybook/grouped-refactor.review.md',
  markdown: groupedRefactorReview,
  commits: [
    {
      ref: 'a11b22c',
      sha: 'a11b22c3d4e5f60718293a4b5c6d7e8f90123456',
      authorName: 'Dana Lee',
      authorEmail: 'dana@example.com',
      authorDate: '2026-05-21T09:14:00Z',
      subject: 'refactor(adaptors): drop legacy aliases from the public surface',
      body: 'Remove createLegacyAdapter and the alias map so only the supported\nruntime factories are exported. Downstream code must migrate to\ncreateAdapter(kind).',
    },
    {
      ref: 'c33d44e',
      sha: 'c33d44e5f6071829a3b4c5d6e7f8091a2b3c4d5e',
      authorName: 'Dana Lee',
      authorEmail: 'dana@example.com',
      authorDate: '2026-05-21T11:02:00Z',
      subject: 'feat(adaptors): centralize label casing in toAdaptorLabel',
      body: 'UI and CLI now share one casing helper instead of ad-hoc formatting.',
    },
    {
      ref: 'e55f66a',
      sha: 'e55f66a7b8091a2c3d4e5f60718293a4b5c6d7e8',
      authorName: 'Wei Chen',
      authorEmail: 'wei@example.com',
      authorDate: '2026-05-22T16:40:00Z',
      subject: 'feat(code-review-helper): add package exports and CLI',
      body: 'Expose core parsing, React rendering, Node Git resolution, and the\nagent prompt; wire the validate/view CLI commands.',
    },
    {
      ref: 'f77a88b',
      sha: 'f77a88b9c0d1e2f30415263748596a7b8c9d0e1f',
      authorName: 'Wei Chen',
      authorEmail: 'wei@example.com',
      authorDate: '2026-05-22T18:05:00Z',
      subject: 'docs(code-review-helper): bound the agent prompt',
      body: 'Push agents toward logic-first groups, verified anchors, and\nrange-filtered changes blocks within the line budget.',
    },
  ],
  files: [
    {
      path: 'packages/adaptors/src/index.ts',
      oldPath: 'packages/adaptors/src/index.ts',
      newPath: 'packages/adaptors/src/index.ts',
      status: 'modified',
      additions: 8,
      deletions: 12,
      oldText: source([
        "import { LegacyAdapter } from './legacy';",
        "import { createHttpAdapter } from './http';",
        "import { createNodeAdapter } from './node';",
        "import type { AdapterFactory } from './types';",
        '',
        "export { createHttpAdapter } from './http';",
        "export { createNodeAdapter } from './node';",
        "export { createMemoryAdapter } from './memory';",
        "export { createLegacyAdapter } from './legacy';",
        "export { detectLegacyRuntime } from './legacy/runtime';",
        "export { normalizeLegacyOptions } from './legacy/options';",
        '',
        'export const ADAPTER_ALIASES = {',
        '  http: createHttpAdapter,',
        '  node: createNodeAdapter,',
        '  legacy: LegacyAdapter.create,',
        '};',
        '',
        'export function createAdapter(kind: keyof typeof ADAPTER_ALIASES): AdapterFactory {',
        '  return ADAPTER_ALIASES[kind];',
        '}',
      ]),
      newText: source([
        "import { createHttpAdapter } from './http';",
        "import { createNodeAdapter } from './node';",
        "import type { AdapterFactory } from './types';",
        '',
        "export { createHttpAdapter } from './http';",
        "export { createNodeAdapter } from './node';",
        "export { createMemoryAdapter } from './memory';",
        '',
        'export const ADAPTER_FACTORIES = {',
        '  http: createHttpAdapter,',
        '  node: createNodeAdapter,',
        '} satisfies Record<string, AdapterFactory>;',
        '',
        'export type AdapterKind = keyof typeof ADAPTER_FACTORIES;',
        '',
        'export function createAdapter(kind: AdapterKind): AdapterFactory {',
        '  return ADAPTER_FACTORIES[kind];',
        '}',
      ]),
    },
    {
      path: 'packages/adaptors/src/naming.ts',
      oldPath: 'packages/adaptors/src/naming.ts',
      newPath: 'packages/adaptors/src/naming.ts',
      status: 'modified',
      additions: 5,
      deletions: 3,
      oldText: source(['export function toLabel(name: string): string {', '  return name;', '}']),
      newText: source([
        'const WORD_BREAK = /[-_]+/g;',
        '',
        'export function toAdaptorLabel(name: string): string {',
        "  return name.replace(WORD_BREAK, ' ').replace(/\\b\\w/g, (char) => char.toUpperCase());",
        '}',
      ]),
    },
    {
      path: 'packages/code-review-helper/package.json',
      oldPath: 'packages/code-review-helper/package.json',
      newPath: 'packages/code-review-helper/package.json',
      status: 'modified',
      additions: 18,
      deletions: 3,
      oldText: source([
        '{',
        '  "name": "@lody/code-review-helper",',
        '  "version": "0.0.0",',
        '  "private": true,',
        '  "type": "module",',
        '  "main": "./src/index.ts",',
        '  "types": "./src/index.ts",',
        '  "exports": {',
        '    ".": "./src/index.ts"',
        '  },',
        '  "scripts": {',
        '    "test": "vitest run"',
        '  }',
        '}',
      ]),
      newText: source([
        '{',
        '  "name": "@lody/code-review-helper",',
        '  "version": "0.0.0",',
        '  "private": true,',
        '  "type": "module",',
        '  "main": "./src/index.ts",',
        '  "types": "./src/index.ts",',
        '  "exports": {',
        '    ".": "./src/index.ts",',
        '    "./node": "./src/node/index.ts",',
        '    "./react": "./src/react/index.ts",',
        '    "./styles.css": "./src/react/styles.css",',
        '    "./prompt": "./prompts/review-helper-agent.md"',
        '  },',
        '  "bin": {',
        '    "review-helper": "./bin/review-helper.mjs"',
        '  },',
        '  "scripts": {',
        '    "review-helper": "node bin/review-helper.mjs",',
        '    "view": "node bin/review-helper.mjs view",',
        '    "validate": "node bin/review-helper.mjs validate",',
        '    "test": "vitest run"',
        '  }',
        '}',
      ]),
    },
    {
      path: 'packages/code-review-helper/src/cli.ts',
      oldPath: 'packages/code-review-helper/src/cli.ts',
      newPath: 'packages/code-review-helper/src/cli.ts',
      status: 'added',
      additions: 38,
      deletions: 0,
      oldText: '',
      newText: source([
        "import { resolveReviewBundle } from './node';",
        "import { collectBundleDiagnostics } from './validation';",
        '',
        'export async function main(argv: readonly string[]): Promise<number> {',
        '  const command = argv[2];',
        "  if (command === 'validate') {",
        '    return validate(argv);',
        '  }',
        "  if (command === 'view') {",
        '    return view(argv);',
        '  }',
        '  printHelp();',
        '  return 1;',
        '}',
        '',
        'async function validate(argv: readonly string[]): Promise<number> {',
        '  const bundle = await resolveReviewBundle({ reviewFilePath: argv[3] ?? "" });',
        '  const diagnostics = collectBundleDiagnostics(bundle);',
        '  for (const diagnostic of diagnostics) {',
        '    console.error(`${diagnostic.severity}: ${diagnostic.message}`);',
        '  }',
        "  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;",
        '}',
        '',
        'async function view(argv: readonly string[]): Promise<number> {',
        '  await resolveReviewBundle({ reviewFilePath: argv[3] ?? "" });',
        "  console.log('serving review UI');",
        '  return 0;',
        '}',
        '',
        'function printHelp(): void {',
        "  console.log('review-helper validate <file.review.md>');",
        "  console.log('review-helper view <file.review.md>');",
        '}',
      ]),
    },
    {
      path: 'packages/code-review-helper/prompts/review-helper-agent.md',
      newPath: 'packages/code-review-helper/prompts/review-helper-agent.md',
      status: 'added',
      additions: 42,
      deletions: 0,
      oldText: '',
      newText: source([
        '# Code Review Helper Agent',
        '',
        'You generate one .review.md file for a local Git workspace.',
        '',
        '## Required Steps',
        '',
        '1. Resolve merge_base and current_commit.',
        '2. Inspect commits with git log merge_base..HEAD.',
        '3. Group changes by review logic first, then list related commits.',
        '4. Keep groups near the configured line budget.',
        '5. Use range-filtered changes:// blocks for large files.',
        '6. Verify every old:// and new:// line number before writing it.',
        '',
        '## Output',
        '',
        'The file must begin with frontmatter.',
        'Then write one or more ## Group sections.',
        'Each group should include changed lines, commits, and focus.',
        '',
        '## Line Budget',
        '',
        'Prefer groups at or below 1500 changed lines.',
        'If a semantic unit cannot be split cleanly, keep it together and explain why.',
        'Use changes://path?old=Lx-Ly&new=La-Lb to reduce the displayed diff.',
        '',
        '## Notes',
        '',
        'Only add notes when the anchor was verified.',
        'Do not add notes for every changed line.',
        'Use notes for risk, intent, or invariants that reviewers should check.',
      ]),
    },
  ],
});

const fileStatusesBundle = createReviewFixtureBundle({
  reviewFilePath: '/storybook/file-statuses.review.md',
  markdown: fileStatusesReview,
  files: [
    {
      path: 'packages/review-helper/src/cli.ts',
      oldPath: 'packages/review-helper/src/cli.ts',
      newPath: 'packages/review-helper/src/cli.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      oldText: source([
        'const commands = new Map<string, () => Promise<void>>();',
        '',
        "commands.set('validate', async () => {",
        '  await validateReviewFile();',
        '});',
      ]),
      newText: source([
        'const commands = new Map<string, () => Promise<void>>();',
        '',
        "commands.set('validate', async () => {",
        '  await validateReviewFile();',
        '});',
        '',
        "commands.set('view', async () => {",
        '  await serveReviewFile();',
        '});',
      ]),
    },
    {
      path: 'packages/review-helper/src/report.ts',
      newPath: 'packages/review-helper/src/report.ts',
      status: 'added',
      additions: 8,
      deletions: 0,
      oldText: '',
      newText: source([
        'export function formatReviewComments(comments: readonly string[]): string {',
        '  if (comments.length === 0) {',
        "    return '# Review Comments\\n\\nNo comments.';",
        '  }',
        '  return comments',
        '    .map((comment, index) => `## Comment ${index + 1}\\n\\n${comment}`)',
        "    .join('\\n\\n');",
        '}',
      ]),
    },
    {
      path: 'packages/review-helper/src/legacy.ts',
      oldPath: 'packages/review-helper/src/legacy.ts',
      status: 'deleted',
      additions: 0,
      deletions: 7,
      oldText: source([
        'export function formatLegacyComment(path: string, line: number, body: string): string {',
        "  return [`File: ${path}`, `Line: ${line}`, '', body].join('\\n');",
        '}',
        '',
        'export function printLegacyComment(comment: string): void {',
        '  console.log(comment);',
        '}',
      ]),
      newText: '',
    },
    {
      path: 'packages/review-helper/src/rendering/comment-export.ts',
      oldPath: 'packages/review-helper/src/rendering/copy-comments.ts',
      newPath: 'packages/review-helper/src/rendering/comment-export.ts',
      status: 'renamed',
      additions: 3,
      deletions: 1,
      oldText: source([
        'export function copyComments(comments: readonly string[]): string {',
        '  return comments.join("\\n\\n");',
        '}',
        '',
        'export const label = "Copy comments";',
        '',
      ]),
      newText: source([
        'interface ExportedComment {',
        '  readonly path: string;',
        '  readonly side: "old" | "new";',
        '  readonly line: number;',
        '  readonly body: string;',
        '  readonly lineText?: string;',
        '}',
        '',
        'export function exportComments(comments: readonly ExportedComment[]): string {',
        '  return comments',
        '    .map((comment) => `${comment.path} ${comment.side}://L${comment.line}\\n${comment.body}`)',
        '    .join("\\n\\n");',
        '}',
      ]),
    },
  ],
});

const budgetDiagnosticsBundle = createReviewFixtureBundle({
  reviewFilePath: '/storybook/budget-diagnostics.review.md',
  markdown: budgetDiagnosticsReview,
  files: [
    {
      path: 'packages/parser/src/large-parser.ts',
      oldPath: 'packages/parser/src/large-parser.ts',
      newPath: 'packages/parser/src/large-parser.ts',
      status: 'modified',
      additions: 17,
      deletions: 12,
      oldText: source([
        'export function parseToken(value: string): string {',
        '  const trimmed = value.trim();',
        '',
        "  if (trimmed.startsWith('#')) {",
        "    return 'heading';",
        '  }',
        "  if (trimmed.startsWith('- ')) {",
        "    return 'list';",
        '  }',
        '  if (trimmed.length === 0) {',
        "    return 'blank';",
        '  }',
        "  return 'text';",
        '}',
      ]),
      newText: source([
        'export function parseToken(value: string): string {',
        '  const trimmed = value.trim();',
        '',
        '  if (trimmed.length === 0) {',
        "    return 'blank';",
        '  }',
        "  if (trimmed.startsWith('```')) {",
        "    return 'code-fence';",
        '  }',
        "  if (trimmed.startsWith('#')) {",
        "    return 'heading';",
        '  }',
        "  if (trimmed.startsWith('- ')) {",
        "    return 'list';",
        '  }',
        "  return 'text';",
        '}',
      ]),
    },
  ],
});

const existingComments: ReviewUserComment[] = [
  {
    id: 'storybook-comment-1',
    anchor: {
      path: 'packages/adaptors/src/index.ts',
      side: 'new',
      lineNumber: 9,
    },
    body: 'Please mirror this name in the public package docs before merge.',
    lineText: 'export const ADAPTER_FACTORIES = {',
    createdAt: 1_700_000_000_000,
  },
  {
    id: 'storybook-comment-2',
    anchor: {
      path: 'packages/code-review-helper/src/cli.ts',
      side: 'new',
      lineNumber: 21,
    },
    body: 'The validator should stay read-only even when future strict flags are added.',
    lineText: "  return diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 1 : 0;",
    createdAt: 1_700_000_060_000,
  },
];

export const GroupedRefactor: Story = {
  args: {
    bundle: groupedRefactorBundle,
    storageKey: 'storybook-grouped-refactor',
  },
};

export const WithExistingComments: Story = {
  args: {
    bundle: groupedRefactorBundle,
    storageKey: 'storybook-existing-comments',
    initialComments: existingComments,
  },
};

export const SplitView: Story = {
  args: {
    bundle: groupedRefactorBundle,
    storageKey: 'storybook-split-view',
    diffStyle: 'split',
  },
};

const severityMarkerBundle = {
  ...groupedRefactorBundle,
  document: {
    ...groupedRefactorBundle.document,
    findings: (['p0', 'p1', 'p2', 'question', 'info'] as const).map((severity, index) => ({
      id: `severity-${severity}`,
      severity,
      bodyMarkdown: `Synthetic ${severity} finding.`,
      refs: [],
      line: index + 1,
    })),
  },
  groups: groupedRefactorBundle.groups.map((group, groupIndex) =>
    groupIndex
      ? group
      : {
          ...group,
          blocks: group.blocks.map((block, blockIndex) =>
            blockIndex
              ? block
              : {
                  ...block,
                  notes: [
                    ...block.notes,
                    ...(['p0', 'p1', 'p2', 'question'] as const).map((severity, index) => ({
                      id: `severity-note-${severity}`,
                      severity,
                      path: block.path,
                      blockId: block.id,
                      side: 'new' as const,
                      range: { start: 9 + index, end: 9 + index },
                      line: 9 + index,
                      body: `Synthetic ${severity} marker note.`,
                    })),
                  ],
                }
          ),
        }
  ),
};

export const SeverityMarkerCoverage: Story = {
  args: {
    bundle: severityMarkerBundle,
    storageKey: 'storybook-severity-marker-coverage',
    initialComments: [
      {
        ...existingComments[0]!,
        id: 'severity-info-comment',
        anchor: { ...existingComments[0]!.anchor, lineNumber: 11 },
        body: 'Synthetic info marker comment.',
        lineText: '  node: createNodeAdapter,',
      },
    ],
  },
};

export const FileStatuses: Story = {
  args: {
    bundle: fileStatusesBundle,
    storageKey: 'storybook-file-statuses',
  },
};

export const BudgetAndLineDiagnostics: Story = {
  args: {
    bundle: budgetDiagnosticsBundle,
    storageKey: 'storybook-budget-diagnostics',
  },
};

export const Pr124V2FormatReviewFile: Story = {
  args: {
    bundle: groupedRefactorBundle,
    storageKey: 'storybook-pr-124-v2-format',
  },
  loaders: [
    async () => {
      const response = await fetch(pr124GzUrl);
      if (!response.ok) {
        throw new Error(`Failed to load PR 124 fixture: ${response.status} ${response.statusText}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text: string;
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(bytes.buffer).body?.pipeThrough(
          new DecompressionStream('gzip')
        );
        if (!stream) {
          throw new Error('Unable to decompress PR 124 fixture');
        }
        text = await new Response(stream).text();
      } else {
        text = new TextDecoder().decode(bytes);
      }
      return { bundle: JSON.parse(text) as import('../types').ReviewBundle };
    },
  ],
  render: (args, { loaded }) => (
    <ReviewRenderer {...args} bundle={loaded.bundle} storageKey="storybook-pr-124-v2-format" />
  ),
};

const longGroupDescriptionBundle = createReviewFixtureBundle({
  reviewFilePath: '/storybook/long-group-description.review.md',
  markdown: longGroupDescriptionReview,
  commits: [
    {
      ref: 'a11b22c',
      sha: 'a11b22c3d4e5f60718293a4b5c6d7e8f90123456',
      authorName: 'Dana Lee',
      authorEmail: 'dana@example.com',
      authorDate: '2026-05-21T09:14:00Z',
      subject: 'refactor(adaptors): drop legacy aliases from the public surface',
      body: '',
    },
    {
      ref: 'c33d44e',
      sha: 'c33d44e5f6071829a3b4c5d6e7f8091a2b3c4d5e',
      authorName: 'Dana Lee',
      authorEmail: 'dana@example.com',
      authorDate: '2026-05-21T11:02:00Z',
      subject: 'feat(adaptors): centralize label casing in toAdaptorLabel',
      body: '',
    },
  ],
  files: [
    {
      path: 'packages/adaptors/src/index.ts',
      status: 'modified',
      oldText: source([
        'export const ADAPTER_ALIASES = {};',
        'export function createLegacyAdapter() {}',
        '',
      ]),
      newText: source([
        'export const ADAPTER_FACTORIES = {};',
        'export function createAdapter(kind: AdapterKind) {}',
        '',
      ]),
      additions: 2,
      deletions: 2,
    },
  ],
});

export const LongGroupDescription: Story = {
  args: {
    bundle: longGroupDescriptionBundle,
    storageKey: 'storybook-long-group-description',
  },
};

const commitOverflowBundle = createReviewFixtureBundle({
  reviewFilePath: '/storybook/commit-overflow.review.md',
  markdown: groupedRefactorReview.replace(
    'Commits: `a11b22c`, `c33d44e`',
    'Commits: `a11b22c`, `c33d44e`, `ee00003`, `ee00004`, `ee00005`, `ee00006`'
  ),
  files: Object.values(groupedRefactorBundle.files),
  commits: [
    ...Object.values(groupedRefactorBundle.commits ?? {}),
    ...[0, 1, 2].map((index) => {
      const ref = `ee0000${index + 3}`;
      return {
        ref,
        sha: ref.padEnd(40, '0'),
        authorName: index === 0 ? 'Synthetic Maintainer' : index === 1 ? '界面测试' : '',
        authorEmail: `fixture-${index}@example.com`,
        authorDate: '2026-05-23T10:00:00Z',
        subject: `Synthetic commit ${index + 1}: verify a long commit subject stays within its row`,
        body:
          index === 0
            ? ''
            : 'Synthetic commit body.\n\nA second paragraph verifies expanded text wrapping.',
      };
    }),
  ],
});

export const CommitOverflowCoverage: Story = {
  args: {
    bundle: commitOverflowBundle,
    storageKey: 'storybook-commit-overflow-coverage',
  },
};
